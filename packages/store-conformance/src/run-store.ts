import type { RunStatus, RunStorePort } from "@forge/ports";
import { describe, expect, test } from "vitest";

import {
  CONFORMANCE_RUN,
  CONFORMANCE_RUN_ID,
  type RunStoreConformanceHarness,
} from "./harness.js";

function describeIdentity(harness: RunStoreConformanceHarness): void {
  describe("a run is readable by the id it was created under", () => {
    test("load returns the record, artifact and start inputs verbatim", async () => {
      const { store } = await harness.create();
      await store.create(CONFORMANCE_RUN);

      expect(await store.load(CONFORMANCE_RUN_ID)).toEqual({
        ...CONFORMANCE_RUN,
        // A freshly created run has been written once and no more.
        revision: 1,
        values: [],
        routes: [],
        effects: [],
      });
    });

    test("an unknown run reports absence rather than inventing one", async () => {
      const { store } = await harness.create();

      // A fabricated run would rehydrate into state nobody wrote.
      expect(await store.load("run_never_started")).toBeUndefined();
    });

    test("creating the same run twice is refused", async () => {
      // Two runs sharing an id are one run as far as every index is concerned,
      // and the second would silently displace the first.
      const { store } = await harness.create();
      await store.create(CONFORMANCE_RUN);

      await expect(store.create(CONFORMANCE_RUN)).rejects.toThrow();
    });

    test("the optional halves of a record survive absent, not as null", async () => {
      const { store } = await harness.create();
      await store.create(CONFORMANCE_RUN);
      const loaded = await store.load(CONFORMANCE_RUN_ID);

      expect(loaded?.record.pendingApprovalId).toBeUndefined();
      expect(loaded?.record.error).toBeUndefined();
      expect(loaded?.record.result).toBeUndefined();
      expect(loaded?.record.traceparent).toBeUndefined();
    });

    test("the trace the run belongs to survives the round trip", async () => {
      /**
       * A run outlives every process that touches it, so its trace has to be
       * a property of the row rather than of anyone's memory. This is the only
       * thing tying together the process that created the run, the worker that
       * walked it and whoever resumed it after a human decided.
       *
       * Asserted here rather than left to whichever store happens to keep the
       * record as one document: a store that normalised it into columns and
       * forgot this one would cost nothing at write time and lose the run's
       * trace at exactly the moment somebody was looking for it.
       */
      const traceparent = `00-${"a1".repeat(16)}-${"b2".repeat(8)}-01`;
      const { store } = await harness.create();
      await store.create({
        ...CONFORMANCE_RUN,
        record: { ...CONFORMANCE_RUN.record, traceparent },
      });

      expect((await store.load(CONFORMANCE_RUN_ID))?.record.traceparent).toBe(
        traceparent,
      );
    });
  });
}

function describeList(harness: RunStoreConformanceHarness): void {
  const runFor = (runId: string, status: RunStatus = "RUNNING") => ({
    ...CONFORMANCE_RUN,
    record: { ...CONFORMANCE_RUN.record, runId, status },
  });

  describe("the estate is readable without knowing a run id first", () => {
    test("every run is listed, most recent first, through a second handle", async () => {
      // The one that matters: a control plane that enumerates its own memory
      // passes nothing here, because the peer never saw those runs created.
      const handle = await harness.create();
      for (const runId of ["run_a", "run_b", "run_c"]) {
        await handle.store.create(runFor(runId));
      }

      const peer = await handle.peer();
      expect((await peer.list()).map((record) => record.runId)).toEqual([
        "run_c",
        "run_b",
        "run_a",
      ]);
    });

    test("a listing reads the current record, not the one that was created", async () => {
      const handle = await harness.create();
      await handle.store.create(runFor("run_a"));
      await handle.store.update(
        {
          ...runFor("run_a").record,
          status: "AWAITING_APPROVAL",
          pendingApprovalId: "approval_1",
        },
        1,
      );

      const peer = await handle.peer();
      expect((await peer.list())[0]).toMatchObject({
        status: "AWAITING_APPROVAL",
        pendingApprovalId: "approval_1",
      });
    });

    test("a status filter narrows to that status and keeps the order", async () => {
      const handle = await harness.create();
      await handle.store.create(runFor("run_a", "AWAITING_APPROVAL"));
      await handle.store.create(runFor("run_b", "SUCCEEDED"));
      await handle.store.create(runFor("run_c", "AWAITING_APPROVAL"));

      const peer = await handle.peer();
      expect(
        (await peer.list({ status: "AWAITING_APPROVAL" })).map(
          (record) => record.runId,
        ),
      ).toEqual(["run_c", "run_a"]);
    });

    test("a status the filter matches nothing on is empty, not everything", async () => {
      // A filter that fell back to "all" on no match would show an operator
      // runs they explicitly excluded, which is worse than showing none.
      const handle = await harness.create();
      await handle.store.create(runFor("run_a", "RUNNING"));

      expect(await handle.store.list({ status: "CANCELLED" })).toEqual([]);
    });

    test("a store with no runs lists nothing", async () => {
      const { store } = await harness.create();

      expect(await store.list()).toEqual([]);
    });
  });
}

function describeRecord(harness: RunStoreConformanceHarness): void {
  describe("the mutable record is replaced, not merged", () => {
    test("an update is what a later load reads", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.update(
        {
          ...CONFORMANCE_RUN.record,
          status: "AWAITING_APPROVAL",
          pendingApprovalId: "approval_1",
          performedEffects: ["publish"],
        },
        1,
      );

      const peer = await handle.peer();
      const loaded = await peer.load(CONFORMANCE_RUN_ID);
      expect(loaded?.record.status).toBe("AWAITING_APPROVAL");
      expect(loaded?.record.pendingApprovalId).toBe("approval_1");
      expect(loaded?.record.performedEffects).toEqual(["publish"]);
    });

    test("a field that was set and then cleared reads as absent again", async () => {
      // A run leaves `AWAITING_APPROVAL` by clearing its pending gate. A store
      // that merged instead of replacing would leave a decided gate pending
      // forever, and a rehydrated run would wait on it.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.update(
        {
          ...CONFORMANCE_RUN.record,
          status: "AWAITING_APPROVAL",
          pendingApprovalId: "approval_1",
        },
        1,
      );
      await handle.store.update(
        { ...CONFORMANCE_RUN.record, status: "RUNNING" },
        2,
      );

      const peer = await handle.peer();
      expect(
        (await peer.load(CONFORMANCE_RUN_ID))?.record.pendingApprovalId,
      ).toBeUndefined();
    });

    test("a run result that is JSON null is a result, not an absence", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.update(
        { ...CONFORMANCE_RUN.record, status: "SUCCEEDED", result: null },
        1,
      );

      const peer = await handle.peer();
      const loaded = await peer.load(CONFORMANCE_RUN_ID);
      // Strict, so a store that dropped the key rather than storing a null
      // fails here instead of reading as an equal record with one less field.
      expect(loaded?.record).toStrictEqual({
        ...CONFORMANCE_RUN.record,
        status: "SUCCEEDED",
        result: null,
      });
    });

    test("updating a run that was never created is refused", async () => {
      const { store } = await harness.create();

      await expect(
        store.update(
          { ...CONFORMANCE_RUN.record, runId: "run_never_started" },
          1,
        ),
      ).rejects.toThrow("FORGE_RUN_NOT_FOUND");
    });
  });

  describe("a write from a stale read is refused, not applied", () => {
    test("the revision moves on every write, and a load reports the current one", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      const created = await handle.store.load(CONFORMANCE_RUN_ID);

      const next = await handle.store.update(
        { ...CONFORMANCE_RUN.record, status: "RUNNING" },
        created?.revision as number,
      );

      expect(next).toBeGreaterThan(created?.revision as number);
      // Read through a second handle, so this is the store's answer rather
      // than one process's memory of what it just wrote.
      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.revision).toBe(next);
    });

    test("the second of two writers loses, and the first's record survives", async () => {
      /**
       * The lost update, staged exactly as it happens: both read, both decide,
       * both write. What makes it worth refusing rather than tolerating is
       * *which* fields are lost. A run parked at a gate that is then
       * overwritten with `RUNNING` is a run waiting on an approval nothing
       * will ever look for — the human decides, and the decision reaches a
       * gate the record no longer mentions.
       */
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);

      const first = await handle.store.load(CONFORMANCE_RUN_ID);
      const second = await (await handle.peer()).load(CONFORMANCE_RUN_ID);
      expect(first?.revision).toBe(second?.revision);

      await handle.store.update(
        {
          ...CONFORMANCE_RUN.record,
          status: "AWAITING_APPROVAL",
          pendingApprovalId: "approval_1",
        },
        first?.revision as number,
      );

      await expect(
        handle.store.update(
          { ...CONFORMANCE_RUN.record, status: "RUNNING" },
          second?.revision as number,
        ),
      ).rejects.toThrow("FORGE_RUN_CONFLICT");

      const peer = await handle.peer();
      const loaded = await peer.load(CONFORMANCE_RUN_ID);
      expect(loaded?.record.status).toBe("AWAITING_APPROVAL");
      expect(loaded?.record.pendingApprovalId).toBe("approval_1");
    });

    test("a refused write leaves the revision alone, so the retry after a reload works", async () => {
      // A conflict that consumed a revision anyway would make the obvious
      // recovery — read again, write again — fail a second time for a reason
      // the caller cannot see.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);

      await expect(
        handle.store.update({ ...CONFORMANCE_RUN.record }, 99),
      ).rejects.toThrow("FORGE_RUN_CONFLICT");

      const current = await handle.store.load(CONFORMANCE_RUN_ID);
      await expect(
        handle.store.update(
          { ...CONFORMANCE_RUN.record, status: "SUCCEEDED" },
          current?.revision as number,
        ),
      ).resolves.toBeGreaterThan(current?.revision as number);
    });
  });
}

function describeValues(harness: RunStoreConformanceHarness): void {
  describe("values are pinned", () => {
    test("a pinned value reads back through a second handle", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.pinValue(CONFORMANCE_RUN_ID, "prepare", {
        member: "synthetic-001",
        amount: 4200,
      });

      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.values).toEqual([
        { nodeId: "prepare", value: { member: "synthetic-001", amount: 4200 } },
      ]);
    });

    test("a second pin does not change the first", async () => {
      // The invariant, stated at the store: an agent is a model call, and a
      // value a human approved must not be overwritten by one computed later.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.pinValue(
        CONFORMANCE_RUN_ID,
        "draft",
        "what was approved",
      );
      await handle.store.pinValue(
        CONFORMANCE_RUN_ID,
        "draft",
        "something else",
      );

      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.values).toEqual([
        { nodeId: "draft", value: "what was approved" },
      ]);
    });

    test("'ran and produced nothing' is not the same as 'has not run'", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.pinValue(CONFORMANCE_RUN_ID, "silent", undefined);

      const peer = await handle.peer();
      const loaded = await peer.load(CONFORMANCE_RUN_ID);
      // Present in the ledger, with no value: a read past it must fail, and a
      // rehydrated run must not invoke the node again to find out.
      expect(loaded?.values).toHaveLength(1);
      expect(loaded?.values[0]?.nodeId).toBe("silent");
      expect(loaded?.values[0]?.value).toBeUndefined();
    });

    test("a value that is JSON null is a value", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.pinValue(CONFORMANCE_RUN_ID, "empty", null);

      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.values).toEqual([
        { nodeId: "empty", value: null },
      ]);
    });

    test("pinning against a run that was never created is refused", async () => {
      const { store } = await harness.create();

      await expect(
        store.pinValue("run_never_started", "draft", "x"),
      ).rejects.toThrow();
    });
  });
}

function describeRoutes(harness: RunStoreConformanceHarness): void {
  describe("a route is decided once per run", () => {
    test("a pinned arm reads back through a second handle", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.pinRoute(CONFORMANCE_RUN_ID, "panel", "pass");

      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.routes).toEqual([
        { nodeId: "panel", arm: "pass" },
      ]);
    });

    test("a second pin does not change the arm the run took", async () => {
      // Without this a resumed run could reroute away from the effect a human
      // had already approved, and report SUCCEEDED having dispatched nothing.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.pinRoute(CONFORMANCE_RUN_ID, "panel", "pass");
      await handle.store.pinRoute(CONFORMANCE_RUN_ID, "panel", "fail");

      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.routes).toEqual([
        { nodeId: "panel", arm: "pass" },
      ]);
    });

    test("pinning against a run that was never created is refused", async () => {
      const { store } = await harness.create();

      await expect(
        store.pinRoute("run_never_started", "panel", "pass"),
      ).rejects.toThrow();
    });
  });
}

function describeEffects(harness: RunStoreConformanceHarness): void {
  describe("an effect is claimed once, before it is performed", () => {
    test("the first claim wins and records what the action was performed on", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);

      expect(
        await handle.store.claimEffect({
          runId: CONFORMANCE_RUN_ID,
          nodeId: "publish",
          effect: "prod.write",
          input: { member: "synthetic-001" },
          at: "2026-08-04T00:00:01.000Z",
        }),
      ).toBe(true);

      const peer = await handle.peer();
      expect((await peer.load(CONFORMANCE_RUN_ID))?.effects).toEqual([
        {
          nodeId: "publish",
          effect: "prod.write",
          input: { member: "synthetic-001" },
          dispatchedAt: "2026-08-04T00:00:01.000Z",
        },
      ]);
    });

    test("a second claim on the same node is refused, from a second handle", async () => {
      // The one that matters. An in-process Set passes the first half of this
      // and fails here, which is the difference between a ledger and a cache.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      const claim = {
        runId: CONFORMANCE_RUN_ID,
        nodeId: "publish",
        effect: "prod.write",
        at: "2026-08-04T00:00:01.000Z",
      };

      expect(await handle.store.claimEffect(claim)).toBe(true);
      const peer = await handle.peer();
      expect(await peer.claimEffect(claim)).toBe(false);
      expect((await peer.load(CONFORMANCE_RUN_ID))?.effects).toHaveLength(1);
    });

    test("concurrent claims on one node produce exactly one winner", async () => {
      // Two workers racing a resume cannot be separated by a check in
      // JavaScript; the store has to be the one that says no.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      const peer = await handle.peer();
      const claim = {
        runId: CONFORMANCE_RUN_ID,
        nodeId: "publish",
        effect: "prod.write",
        at: "2026-08-04T00:00:01.000Z",
      };

      const outcomes = await Promise.all([
        handle.store.claimEffect(claim),
        peer.claimEffect(claim),
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await peer.load(CONFORMANCE_RUN_ID))?.effects).toHaveLength(1);
    });

    test("effects list in the order they were claimed", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      for (const nodeId of ["notify", "publish", "archive"]) {
        await handle.store.claimEffect({
          runId: CONFORMANCE_RUN_ID,
          nodeId,
          effect: "prod.write",
          at: "2026-08-04T00:00:01.000Z",
        });
      }

      const peer = await handle.peer();
      expect(
        (await peer.load(CONFORMANCE_RUN_ID))?.effects.map(
          (effect) => effect.nodeId,
        ),
      ).toEqual(["notify", "publish", "archive"]);
    });

    test("an effect performed on nothing records no input, not a null one", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.claimEffect({
        runId: CONFORMANCE_RUN_ID,
        nodeId: "publish",
        effect: "prod.write",
        at: "2026-08-04T00:00:01.000Z",
      });

      const peer = await handle.peer();
      const loaded = await peer.load(CONFORMANCE_RUN_ID);
      expect(loaded?.effects[0]?.input).toBeUndefined();
    });

    test("claiming against a run that was never created is refused", async () => {
      const { store } = await harness.create();

      await expect(
        store.claimEffect({
          runId: "run_never_started",
          nodeId: "publish",
          effect: "prod.write",
          at: "2026-08-04T00:00:01.000Z",
        }),
      ).rejects.toThrow();
    });
  });
}

function describeSettlement(harness: RunStoreConformanceHarness): void {
  describe("an action claimed and never finished is findable", () => {
    const claim = async (store: RunStorePort, nodeId: string, at: string) => {
      await store.claimEffect({
        runId: CONFORMANCE_RUN_ID,
        nodeId,
        effect: "prod.write",
        at,
      });
    };

    test("a claim with no settlement is reported, estate-wide", async () => {
      /**
       * The failure this makes visible: the claim is written before the
       * action, so a process that dies in between leaves an action that a
       * human approved, that the ledger believes was dispatched, and that
       * never happened. The run carries on and reports SUCCEEDED.
       *
       * "Losing one is recoverable" — the reason the claim comes first — is
       * only true if somebody is told, and until this nobody was. Asked
       * without a run id because nobody knows which run to go and look at.
       */
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await claim(handle.store, "publish", "2026-08-04T00:00:01.000Z");

      const peer = await handle.peer();
      expect(await peer.listUnsettled(100)).toEqual([
        {
          runId: CONFORMANCE_RUN_ID,
          nodeId: "publish",
          effect: "prod.write",
          claimedAt: "2026-08-04T00:00:01.000Z",
        },
      ]);
    });

    test("a settled action drops off the list and says when it finished", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await claim(handle.store, "publish", "2026-08-04T00:00:01.000Z");
      await handle.store.settleEffect(
        CONFORMANCE_RUN_ID,
        "publish",
        "2026-08-04T00:00:02.000Z",
      );

      const peer = await handle.peer();
      expect(await peer.listUnsettled(100)).toEqual([]);
      expect((await peer.load(CONFORMANCE_RUN_ID))?.effects[0]).toMatchObject({
        dispatchedAt: "2026-08-04T00:00:01.000Z",
        settledAt: "2026-08-04T00:00:02.000Z",
      });
    });

    test("the oldest claim is first, because it is the one still unexplained", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await claim(handle.store, "later", "2026-08-04T00:00:09.000Z");
      await claim(handle.store, "earlier", "2026-08-04T00:00:01.000Z");

      expect(
        (await (await handle.peer()).listUnsettled(100)).map(
          (entry) => entry.nodeId,
        ),
      ).toEqual(["earlier", "later"]);
    });

    test("settling twice keeps the first answer", async () => {
      // When the action happened is a fact, and a redelivery arriving later
      // must not restate it. A settlement that moved would make the window
      // this whole mechanism measures unmeasurable.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await claim(handle.store, "publish", "2026-08-04T00:00:01.000Z");
      await handle.store.settleEffect(
        CONFORMANCE_RUN_ID,
        "publish",
        "2026-08-04T00:00:02.000Z",
      );
      await handle.store.settleEffect(
        CONFORMANCE_RUN_ID,
        "publish",
        "2026-08-04T00:00:59.000Z",
      );

      expect(
        (await (await handle.peer()).load(CONFORMANCE_RUN_ID))?.effects[0],
      ).toMatchObject({ settledAt: "2026-08-04T00:00:02.000Z" });
    });

    test("settling something that was never claimed is refused", async () => {
      // A settlement with no claim would mean an action performed outside the
      // one path that gates them, and recording it quietly is the worst of
      // both: no gate, and no gap to find later either.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);

      await expect(
        handle.store.settleEffect(
          CONFORMANCE_RUN_ID,
          "publish",
          "2026-08-04T00:00:02.000Z",
        ),
      ).rejects.toThrow("FORGE_EFFECT_NOT_CLAIMED");
    });

    test("the bound keeps the oldest, because those are the least explained", async () => {
      /**
       * A page that dropped the old ones to show the new would hide exactly
       * the entries worth acting on: an action outstanding for a week is a
       * worse fact than one outstanding for a minute. The bound exists because
       * the day this list is long is the day an outage made it long — the one
       * day an operator most needs it to load.
       */
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await claim(handle.store, "oldest", "2026-08-04T00:00:01.000Z");
      await claim(handle.store, "middle", "2026-08-04T00:00:02.000Z");
      await claim(handle.store, "newest", "2026-08-04T00:00:03.000Z");

      const peer = await handle.peer();
      expect(
        (await peer.listUnsettled(2)).map((entry) => entry.nodeId),
      ).toEqual(["oldest", "middle"]);
    });

    test("a bound of zero is honoured rather than read as no bound", async () => {
      // The reading that turns a paging bug into an unbounded query, on the
      // one code path where the list is expected to be enormous.
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await claim(handle.store, "publish", "2026-08-04T00:00:01.000Z");

      expect(await handle.store.listUnsettled(0)).toEqual([]);
    });

    test("a store with nothing outstanding reports nothing", async () => {
      // Guards the four above: a list that always came back empty would pass
      // "drops off the list" and prove nothing.
      const { store } = await harness.create();

      expect(await store.listUnsettled(100)).toEqual([]);
    });
  });
}

function describeIsolation(harness: RunStoreConformanceHarness): void {
  describe("two stores are two stores", () => {
    test("a run written to one store is not visible in another", async () => {
      const first = await harness.create();
      const second = await harness.create();
      await first.store.create(CONFORMANCE_RUN);

      // Guards the suite itself: every test above assumes it starts empty.
      expect(await second.store.load(CONFORMANCE_RUN_ID)).toBeUndefined();
    });
  });
}

/**
 * Runs the whole `RunStorePort` contract against one adapter. A new run store
 * proves itself by calling this with its own factory rather than by
 * hand-copying the memory adapter's tests and drifting from them.
 */
export function describeRunStoreConformance(
  harness: RunStoreConformanceHarness,
): void {
  describe(`${harness.name} · RunStorePort conformance`, () => {
    describeIdentity(harness);
    describeList(harness);
    describeRecord(harness);
    describeValues(harness);
    describeRoutes(harness);
    describeEffects(harness);
    describeSettlement(harness);
    describeIsolation(harness);
  });
}
