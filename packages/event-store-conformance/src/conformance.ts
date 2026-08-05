import type { RunEventInput, RunEventStorePort } from "@forge/observability";
import { describe, expect, test } from "vitest";

import {
  CONFORMANCE_AT,
  CONFORMANCE_RUN_ID,
  type EventStoreConformanceHarness,
  OTHER_RUN_ID,
} from "./harness.js";

function record(
  name: string,
  attributes: RunEventInput["attributes"] = {},
  runId: string = CONFORMANCE_RUN_ID,
): RunEventInput {
  return { runId, kind: "event", name, at: CONFORMANCE_AT, attributes };
}

const names = async (
  store: RunEventStorePort,
  runId: string = CONFORMANCE_RUN_ID,
): Promise<readonly string[]> =>
  (await store.list(runId)).map((event) => event.name);

/** The run's walk, in the order the runtime records it. */
const WALK = [
  "forge.run.start",
  "forge.policy.decide",
  "forge.approval.requested",
  "forge.approval.decided",
  "forge.effect.dispatched",
  "forge.run.succeeded",
] as const;

/**
 * The clock the records claim, running **backwards** across the walk.
 *
 * This is not a contrivance: a run's timeline is written by more than one
 * process, and two hosts a second apart — or one host after an NTP step — put
 * an earlier reading on a later event. It is also the only shape that catches
 * the bug. An earlier version of this suite gave every record the *same* `at`
 * and asserted the order came back unchanged; ordering both stores by `at`
 * instead of by the sequence left it green, because a stable sort on equal keys
 * preserves insertion order and Postgres returned the rows physically. A check
 * that cannot fail is worse than no check.
 */
const skewed = (index: number): string =>
  new Date(Date.parse(CONFORMANCE_AT) - index * 1_000).toISOString();

function describeOrdering(harness: EventStoreConformanceHarness): void {
  describe("a run reads back in the order it happened", () => {
    test("order is the sequence, not the clock the records carry", async () => {
      const { store } = await harness.create();
      for (const [index, name] of WALK.entries()) {
        await store.append({ ...record(name), at: skewed(index) });
      }

      // Ordering by `at` would hand back the exact reverse.
      expect(await names(store)).toEqual([...WALK]);
      // Read twice: an unstable order is a bug that a single read cannot see.
      expect(await names(store)).toEqual([...WALK]);
    });

    test("a record with the same instant as the one before it does not tie", async () => {
      const { store } = await harness.create();
      for (const name of WALK) await store.append(record(name));

      expect(await names(store)).toEqual([...WALK]);
    });

    test("the sequence strictly increases, so it is a total order", async () => {
      const { store } = await harness.create();
      for (const name of WALK) await store.append(record(name));

      const sequences = (await store.list(CONFORMANCE_RUN_ID)).map(
        (event) => event.seq,
      );
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
    });

    test("append returns the sequence the record was filed under", async () => {
      const { store } = await harness.create();

      const first = await store.append(record("forge.run.start"));
      const second = await store.append(record("forge.node.agent"));

      const listed = await store.list(CONFORMANCE_RUN_ID);
      expect(listed.map((event) => event.seq)).toEqual([first, second]);
    });

    test("two runs interleaved keep each their own order", async () => {
      const { store } = await harness.create();

      await store.append(record("forge.run.start"));
      await store.append(record("forge.run.start", {}, OTHER_RUN_ID));
      await store.append(record("forge.effect.dispatched"));
      await store.append(record("forge.run.failed", {}, OTHER_RUN_ID));

      expect(await names(store)).toEqual([
        "forge.run.start",
        "forge.effect.dispatched",
      ]);
      expect(await names(store, OTHER_RUN_ID)).toEqual([
        "forge.run.start",
        "forge.run.failed",
      ]);
    });
  });
}

function describeScoping(harness: EventStoreConformanceHarness): void {
  describe("a run's timeline is its own", () => {
    test("one run's records never appear under another", async () => {
      const { store } = await harness.create();

      await store.append(record("forge.node.agent", { nodeId: "draft" }));
      await store.append(
        record("forge.node.agent", { nodeId: "elsewhere" }, OTHER_RUN_ID),
      );

      const listed = await store.list(CONFORMANCE_RUN_ID);
      expect(listed).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toContain("elsewhere");
      expect(JSON.stringify(listed)).not.toContain(OTHER_RUN_ID);
    });

    test("a run with no records is empty rather than an error", async () => {
      // An operator opening a run that recorded nothing gets an empty
      // timeline; a throw here would turn that into a 500.
      const { store } = await harness.create();

      await expect(store.list("run_never_seen")).resolves.toEqual([]);
    });
  });
}

function describeClosing(harness: EventStoreConformanceHarness): void {
  describe("a span's closing attributes land on the span that opened", () => {
    test("closing merges without moving the record", async () => {
      const { store } = await harness.create();

      const seq = await store.append({
        runId: CONFORMANCE_RUN_ID,
        kind: "span",
        name: "forge.node.judge",
        at: CONFORMANCE_AT,
        attributes: { runId: CONFORMANCE_RUN_ID, nodeId: "review" },
      });
      await store.append(record("forge.effect.dispatched"));
      await store.close(seq, { verdict: "pass" });

      const listed = await store.list(CONFORMANCE_RUN_ID);
      // Still first. A verdict arriving after a later event must not drag the
      // judge span to the end of the operator's timeline.
      expect(listed.map((event) => event.name)).toEqual([
        "forge.node.judge",
        "forge.effect.dispatched",
      ]);
      expect(listed[0]?.attributes).toEqual({
        runId: CONFORMANCE_RUN_ID,
        nodeId: "review",
        verdict: "pass",
      });
    });

    test("a closing attribute overwrites the opening one of the same name", async () => {
      const { store } = await harness.create();

      const seq = await store.append({
        runId: CONFORMANCE_RUN_ID,
        kind: "span",
        name: "forge.run.start",
        at: CONFORMANCE_AT,
        attributes: { runId: CONFORMANCE_RUN_ID, status: "RUNNING" },
      });
      await store.close(seq, { status: "SUCCEEDED" });

      expect((await store.list(CONFORMANCE_RUN_ID))[0]?.attributes).toEqual({
        runId: CONFORMANCE_RUN_ID,
        status: "SUCCEEDED",
      });
    });

    test("closing a sequence that is not there is a no-op", async () => {
      // The recorder never asks for one, but telemetry fails open and a store
      // that threw here would hand the recorder something to swallow — and a
      // swallowed error is a record nobody knows was lost.
      const { store } = await harness.create();
      await store.append(record("forge.run.start"));

      await expect(
        store.close(-1, { verdict: "pass" }),
      ).resolves.toBeUndefined();
      expect(await names(store)).toEqual(["forge.run.start"]);
    });
  });
}

/**
 * The store is a **dumb log**, and that is a requirement rather than an
 * omission.
 *
 * Redaction happens once, in `recordRunEvents`, before anything is offered
 * here. If a store scrubbed as well, the proof that nothing PII-bearing ever
 * reached a database would be a store marking its own work — the exact mistake
 * this repository has already made once. Asserting that a store keeps what it
 * was handed is what keeps that proof aimed at the writer.
 */
function describeVerbatim(harness: EventStoreConformanceHarness): void {
  describe("the store keeps what it was handed", () => {
    test("attributes come back unchanged, scrubbing included", async () => {
      const { store } = await harness.create();
      const attributes = {
        runId: CONFORMANCE_RUN_ID,
        nodeId: "publish",
        attempt: 2,
        replayed: false,
        note: "[REDACTED]",
        // Would be scrubbed by the recorder. A store that scrubbed too would
        // pass this suite by rewriting, and hide a recorder that had stopped.
        memberEmail: "grace.hopper@example.test",
      };

      await store.append({
        runId: CONFORMANCE_RUN_ID,
        kind: "span",
        name: "forge.node.tool",
        at: CONFORMANCE_AT,
        attributes,
      });

      expect((await store.list(CONFORMANCE_RUN_ID))[0]).toMatchObject({
        runId: CONFORMANCE_RUN_ID,
        kind: "span",
        name: "forge.node.tool",
        at: CONFORMANCE_AT,
        attributes,
      });
    });

    test("kind distinguishes a span from an event", async () => {
      const { store } = await harness.create();

      await store.append({
        runId: CONFORMANCE_RUN_ID,
        kind: "span",
        name: "forge.node.agent",
        at: CONFORMANCE_AT,
        attributes: {},
      });
      await store.append(record("forge.effect.dispatched"));

      expect(
        (await store.list(CONFORMANCE_RUN_ID)).map((event) => event.kind),
      ).toEqual(["span", "event"]);
    });
  });
}

/**
 * The reason the port exists. Everything above would be satisfied by an array
 * in one process; this is the part `GET /v1/runs/:runId/events` needed and did
 * not have.
 */
function describeDurability(harness: EventStoreConformanceHarness): void {
  describe("a timeline outlives the process that recorded it", () => {
    test("a second process reads a run it never saw, in order", async () => {
      // Skewed, for the reason above: two hosts writing one timeline are the
      // case where the clock and the sequence actually disagree.
      const { store, ...handle } = await harness.create();
      for (const [index, name] of WALK.entries()) {
        await store.append({ ...record(name), at: skewed(index) });
      }

      expect(await names(await handle.peer())).toEqual([...WALK]);
    });

    test("what a second process reads is ordered the same way", async () => {
      const { store, ...handle } = await harness.create();
      const seq = await store.append({
        runId: CONFORMANCE_RUN_ID,
        kind: "span",
        name: "forge.run.start",
        at: CONFORMANCE_AT,
        attributes: { runId: CONFORMANCE_RUN_ID },
      });
      await store.append(record("forge.effect.dispatched"));
      await store.close(seq, { status: "SUCCEEDED" });

      const peer = await handle.peer();
      const listed = await peer.list(CONFORMANCE_RUN_ID);
      expect(listed.map((event) => event.name)).toEqual([
        "forge.run.start",
        "forge.effect.dispatched",
      ]);
      // The merge is durable too, not a fact the writing process remembers.
      expect(listed[0]?.attributes.status).toBe("SUCCEEDED");
    });

    test("a second process appends onto the same run, after it", async () => {
      // What a restart actually looks like: one process parks a run at a gate,
      // another carries the decision out, and the operator reads one timeline.
      const { store, ...handle } = await harness.create();
      await store.append(record("forge.approval.requested"));

      const peer = await handle.peer();
      await peer.append(record("forge.approval.decided"));

      expect(await names(peer)).toEqual([
        "forge.approval.requested",
        "forge.approval.decided",
      ]);
    });
  });
}

/**
 * Runs the whole `RunEventStorePort` contract against one adapter. A new store
 * proves itself by calling this with its own factory, which is what stops the
 * in-memory store and the Postgres one drifting apart.
 */
export function describeRunEventStoreConformance(
  harness: EventStoreConformanceHarness,
): void {
  describe(`${harness.name} · RunEventStorePort conformance`, () => {
    describeOrdering(harness);
    describeScoping(harness);
    describeClosing(harness);
    describeVerbatim(harness);
    describeDurability(harness);
  });
}
