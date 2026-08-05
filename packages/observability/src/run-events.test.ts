import type {
  ClockPort,
  ObservabilityPort,
  RunEvent,
  RunEventInput,
  RunEventStorePort,
  SpanAttributes,
} from "@forge/ports";
import { describe, expect, test, vi } from "vitest";

import { recordRunEvents } from "./run-events.js";

/**
 * A store that redacts nothing, normalises nothing and forgets nothing.
 *
 * This is the whole point of the file. Asking an adapter that scrubs on the way
 * in what it remembers proves it can read its own notes — that exact mistake
 * was made in this repository and proved nothing. Every assertion below is
 * against `handed`, which is the argument object `recordRunEvents` passed to
 * `append`, captured before anything could touch it.
 */
interface CaptureStore extends RunEventStorePort {
  /** Exactly what `append` was called with, in call order. */
  readonly handed: readonly RunEventInput[];
  /** Exactly what `close` was called with, in call order. */
  readonly closed: readonly (readonly [number, SpanAttributes])[];
}

function captureStore(): CaptureStore {
  const handed: RunEventInput[] = [];
  const closed: [number, SpanAttributes][] = [];
  return {
    handed,
    closed,
    async append(event) {
      handed.push(event);
      return handed.length;
    },
    async close(seq, attributes) {
      closed.push([seq, attributes]);
    },
    async list() {
      return [];
    },
  };
}

/** A sink that records nothing, so a test is only reading the store side. */
const SILENT: ObservabilityPort = {
  startSpan: () => ({ end: () => undefined }),
  event: () => undefined,
};

const clockAt = (iso: string): ClockPort => ({ now: () => new Date(iso) });

/** Lets the microtask chain the recorder queues its writes on drain. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A run's worth of attributes Forge is most likely to be handed and least able
 * to survive leaking — the same probe `@forge/observability-conformance` uses
 * against a trace sink, aimed here at a database row instead.
 */
const PII_PROBE: SpanAttributes = {
  runId: "run_1",
  nodeId: "publish",
  promptRef: "acme.publish.draft@1",
  attempt: 2,
  memberEmail: "ada.lovelace@example.test",
  ssn: "123-45-6789",
  annualWage: 82000,
  homeAddress: "1 Infinite Loop",
  bankAccountNumber: "000123456",
  // Short on purpose: a longer literal is indistinguishable from a real
  // credential to `pnpm security:secrets`.
  apiKey: "sk-abc",
  prompt: "Summarise the payroll for ada.lovelace@example.test",
  note: "call ada.lovelace@example.test about 123-45-6789",
};

const PII_NEEDLES: readonly string[] = [
  "ada.lovelace@example.test",
  "123-45-6789",
  "82000",
  "1 Infinite Loop",
  "000123456",
  "sk-abc",
  "Summarise the payroll",
];

describe("what the store is handed", () => {
  test("a span and an event both arrive, in the order recorded", async () => {
    const store = captureStore();
    const observability = recordRunEvents(
      SILENT,
      store,
      clockAt("2026-08-04T00:00:00.000Z"),
    );

    observability
      .startSpan("forge.run.start", { runId: "run_1", workflowId: "wf" })
      .end();
    observability.event("forge.effect.dispatched", {
      runId: "run_1",
      nodeId: "publish",
    });
    await settle();

    expect(store.handed).toEqual([
      {
        runId: "run_1",
        kind: "span",
        name: "forge.run.start",
        at: "2026-08-04T00:00:00.000Z",
        attributes: { runId: "run_1", workflowId: "wf" },
      },
      {
        runId: "run_1",
        kind: "event",
        name: "forge.effect.dispatched",
        at: "2026-08-04T00:00:00.000Z",
        attributes: { runId: "run_1", nodeId: "publish" },
      },
    ]);
  });

  test("closing attributes are sent to close, against the span's own sequence", async () => {
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    const judge = observability.startSpan("forge.node.judge", {
      runId: "run_1",
      nodeId: "review",
    });
    observability.event("forge.effect.dispatched", { runId: "run_1" });
    judge.end({ verdict: "pass" });
    await settle();

    // The judge span was the first record, so its verdict closes sequence 1 —
    // not the event that happened to be recorded most recently.
    expect(store.closed).toEqual([[1, { verdict: "pass" }]]);
  });

  test("a span that ends with nothing closes nothing", async () => {
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    observability.startSpan("forge.node.agent", { runId: "run_1" }).end();
    await settle();

    expect(store.handed).toHaveLength(1);
    expect(store.closed).toEqual([]);
  });

  test("the tracing sink still gets everything, unredacted and parented", () => {
    // The store is an addition, not a replacement: the trace is where a payload
    // is *also* stopped, and the adapters do their own redacting.
    const startSpan = vi.fn(() => ({ end: vi.fn(), context: { id: 7 } }));
    const event = vi.fn();
    const parent = { end: () => undefined };
    const observability = recordRunEvents({ startSpan, event }, captureStore());

    const span = observability.startSpan("forge.node.agent", PII_PROBE, parent);
    observability.event("forge.node.branch", { runId: "run_1" }, parent);

    expect(startSpan).toHaveBeenCalledWith(
      "forge.node.agent",
      PII_PROBE,
      parent,
    );
    expect(event).toHaveBeenCalledWith(
      "forge.node.branch",
      { runId: "run_1" },
      parent,
    );
    // The parent handle survives the wrapping, or a run's spans stop being one
    // trace the moment a store is bound.
    expect(span.context).toEqual({ id: 7 });
  });
});

/**
 * The property that matters most. A run's events are the most PII-dense thing
 * in this system, and a row in Postgres is the copy that outlives the process
 * and sits behind no access control at rest.
 */
describe("no payload reaches the store", () => {
  test("nothing in the probe survives to append", async () => {
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    observability.startSpan("forge.node.agent", PII_PROBE).end();
    observability.event("forge.effect.dispatched", PII_PROBE);
    await settle();

    expect(store.handed).toHaveLength(2);
    const serialised = JSON.stringify(store.handed);
    for (const needle of PII_NEEDLES) {
      expect(serialised).not.toContain(needle);
    }
  });

  test("nothing in the probe survives to close either", async () => {
    // The end of a span is the easiest place to forget: the node has run, and
    // whatever it produced is right there.
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    observability
      .startSpan("forge.node.agent", { runId: "run_1" })
      .end(PII_PROBE);
    await settle();

    const serialised = JSON.stringify(store.closed);
    for (const needle of PII_NEEDLES) {
      expect(serialised).not.toContain(needle);
    }
    expect(store.closed[0]?.[1]).toMatchObject({ prompt: "[REDACTED]" });
  });

  test("the identifiers an operator needs do survive", async () => {
    // Without this the suite would pass on a recorder that wrote nothing, or
    // one that replaced every attribute it was handed.
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    observability.startSpan("forge.node.agent", PII_PROBE).end();
    await settle();

    expect(store.handed[0]?.attributes).toMatchObject({
      runId: "run_1",
      nodeId: "publish",
      promptRef: "acme.publish.draft@1",
      attempt: 2,
    });
  });

  test("a principal never reaches the store", async () => {
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    observability.event("forge.approval.decided", {
      runId: "run_1",
      approvalId: "approval_1",
      decision: "approve",
      principalHash: "9f2a5c1e4b7d0a63",
      approverCount: 2,
      principal: "ada.lovelace",
      approverId: "u_88",
      decidedBySubject: "ada.lovelace",
    });
    await settle();

    expect(store.handed[0]?.attributes).toEqual({
      runId: "run_1",
      approvalId: "approval_1",
      decision: "approve",
      // The link back to `ApprovalRecord.decidedBy`, which is where "who"
      // actually lives.
      principalHash: "9f2a5c1e4b7d0a63",
      approverCount: 2,
      principal: "[REDACTED]",
      approverId: "[REDACTED]",
      decidedBySubject: "[REDACTED]",
    });
    expect(JSON.stringify(store.handed)).not.toContain("ada.lovelace");
    expect(JSON.stringify(store.handed)).not.toContain("u_88");
  });
});

describe("a record with no run", () => {
  test("is not written, because no query would ever find it", async () => {
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store);

    observability.startSpan("forge.policy.decide", { action: "slack.post" });
    observability.event("forge.secret.redacted");
    observability.event("forge.run.start", { runId: "" });
    await settle();

    expect(store.handed).toEqual([]);
  });

  test("still reaches the tracing sink", async () => {
    const event = vi.fn();
    const observability = recordRunEvents(
      { startSpan: () => ({ end: () => undefined }), event },
      captureStore(),
    );

    observability.event("forge.secret.redacted");
    await settle();

    expect(event).toHaveBeenCalledWith("forge.secret.redacted", {}, undefined);
  });
});

/**
 * Telemetry fails open, alone among the ports. A durable store is a database,
 * so it fails in every way a database fails, and none of them may reach a run.
 */
describe("a broken store never reaches the run", () => {
  const failing = (store: Partial<RunEventStorePort>): RunEventStorePort => ({
    async append() {
      return 1;
    },
    async close() {},
    async list() {
      return [];
    },
    ...store,
  });

  const record = (observability: ObservabilityPort): void => {
    const span = observability.startSpan("forge.run.start", { runId: "run_1" });
    span.end({ status: "SUCCEEDED" });
    observability.event("forge.effect.dispatched", { runId: "run_1" });
  };

  test("a store that throws synchronously", async () => {
    const observability = recordRunEvents(
      SILENT,
      failing({
        append() {
          throw new Error("the store is gone");
        },
      }),
    );

    expect(() => record(observability)).not.toThrow();
    await expect(settle()).resolves.toBeUndefined();
  });

  test("a store that rejects", async () => {
    const observability = recordRunEvents(
      SILENT,
      failing({
        async append() {
          throw new Error("connection terminated unexpectedly");
        },
        async close() {
          throw new Error("connection terminated unexpectedly");
        },
      }),
    );

    expect(() => record(observability)).not.toThrow();
    await expect(settle()).resolves.toBeUndefined();
  });

  test("a store that never answers does not hold the run up", async () => {
    const observability = recordRunEvents(
      SILENT,
      failing({ append: () => new Promise<number>(() => {}) }),
    );

    const before = Date.now();
    expect(() => record(observability)).not.toThrow();
    // Returned without waiting on a store that will never answer. If the
    // recorder awaited its writes, this line would never run at all.
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  test("a clock that throws costs a record, not a run", async () => {
    const store = captureStore();
    const observability = recordRunEvents(SILENT, store, {
      now() {
        throw new Error("the clock failed");
      },
    });

    expect(() => record(observability)).not.toThrow();
    await settle();
    expect(store.handed).toEqual([]);
  });

  test("a rejected append does not strand the writes behind it", async () => {
    // The writes are serialised so the store assigns sequences in recording
    // order. A queue that stopped at the first failure would lose the rest of
    // the run — the ordering guarantee must not become a single point of loss.
    const handed: RunEventInput[] = [];
    let first = true;
    const observability = recordRunEvents(
      SILENT,
      failing({
        async append(input) {
          if (first) {
            first = false;
            throw new Error("the first write failed");
          }
          handed.push(input);
          return handed.length;
        },
      }),
    );

    observability.event("forge.run.start", { runId: "run_1" });
    observability.event("forge.policy.decide", { runId: "run_1" });
    observability.event("forge.effect.dispatched", { runId: "run_1" });
    await settle();

    expect(handed.map((event) => event.name)).toEqual([
      "forge.policy.decide",
      "forge.effect.dispatched",
    ]);
  });

  test("a sink that throws does not stop the durable record", async () => {
    // The two halves fail independently. A collector being down must not also
    // empty the operator's timeline.
    const store = captureStore();
    const observability = recordRunEvents(
      {
        startSpan() {
          throw new Error("the collector is unreachable");
        },
        event() {
          throw new Error("the collector is unreachable");
        },
      },
      store,
    );

    expect(() => record(observability)).not.toThrow();
    await settle();
    expect(store.handed.map((event) => event.name)).toEqual([
      "forge.run.start",
      "forge.effect.dispatched",
    ]);
  });
});

describe("recording order is insertion order", () => {
  test("a slow first write does not let a later one be filed before it", async () => {
    // The store assigns the sequence at insert. Two inserts in flight at once
    // would order a run's timeline by whichever socket answered first, which is
    // exactly the tie the sequence exists to prevent.
    const order: string[] = [];
    let release: (() => void) | undefined;
    const observability = recordRunEvents(SILENT, {
      async append(event: RunEventInput) {
        if (event.name === "forge.run.start") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        order.push(event.name);
        return order.length;
      },
      async close() {},
      async list(): Promise<readonly RunEvent[]> {
        return [];
      },
    });

    observability.event("forge.run.start", { runId: "run_1" });
    observability.event("forge.effect.dispatched", { runId: "run_1" });
    await settle();
    // The second write has not been offered while the first is outstanding.
    expect(order).toEqual([]);

    release?.();
    await settle();
    expect(order).toEqual(["forge.run.start", "forge.effect.dispatched"]);
  });
});
