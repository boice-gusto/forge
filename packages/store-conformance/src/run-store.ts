import type { RunStatus } from "@forge/ports";
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
      await handle.store.update({
        ...runFor("run_a").record,
        status: "AWAITING_APPROVAL",
        pendingApprovalId: "approval_1",
      });

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
      await handle.store.update({
        ...CONFORMANCE_RUN.record,
        status: "AWAITING_APPROVAL",
        pendingApprovalId: "approval_1",
        performedEffects: ["publish"],
      });

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
      await handle.store.update({
        ...CONFORMANCE_RUN.record,
        status: "AWAITING_APPROVAL",
        pendingApprovalId: "approval_1",
      });
      await handle.store.update({
        ...CONFORMANCE_RUN.record,
        status: "RUNNING",
      });

      const peer = await handle.peer();
      expect(
        (await peer.load(CONFORMANCE_RUN_ID))?.record.pendingApprovalId,
      ).toBeUndefined();
    });

    test("a run result that is JSON null is a result, not an absence", async () => {
      const handle = await harness.create();
      await handle.store.create(CONFORMANCE_RUN);
      await handle.store.update({
        ...CONFORMANCE_RUN.record,
        status: "SUCCEEDED",
        result: null,
      });

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
        store.update({ ...CONFORMANCE_RUN.record, runId: "run_never_started" }),
      ).rejects.toThrow();
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
    describeIsolation(harness);
  });
}
