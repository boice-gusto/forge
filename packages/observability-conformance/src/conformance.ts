import type { Span } from "@forge/ports";
import { describe, expect, test } from "vitest";

import {
  type ExportedRecord,
  type ObservabilityConformanceHarness,
  type ObservabilitySubject,
  PII_NEEDLES,
  PII_PROBE,
  PII_PROBE_SURVIVORS,
  PRINCIPAL_PROBE,
  REDACTED,
} from "./harness.js";

function named(
  records: readonly ExportedRecord[],
  name: string,
): ExportedRecord {
  const found = records.find((record) => record.name === name);
  if (found === undefined) {
    throw new Error(
      `The sink was never handed ${name}; it received ${
        records.map((record) => record.name).join(", ") || "nothing"
      }.`,
    );
  }
  return found;
}

/** The one record whose `runId` says which of two concurrent runs it belongs to. */
function forRun(
  records: readonly ExportedRecord[],
  name: string,
  runId: string,
): ExportedRecord {
  return named(
    records.filter((record) => record.attributes.runId === runId),
    name,
  );
}

async function drain(
  subject: ObservabilitySubject,
): Promise<readonly ExportedRecord[]> {
  await subject.flush();
  return subject.recorded();
}

/** Yields to the event loop, so what follows is a genuinely later turn. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

function describeRecording(harness: ObservabilityConformanceHarness): void {
  describe("what the runtime records is what the sink is handed", () => {
    test("a span arrives under its own name with its identifiers intact", async () => {
      const subject = await harness.create();

      subject.observability
        .startSpan("forge.run.start", { runId: "run_1", workflowId: "wf" })
        .end();

      expect(named(await drain(subject), "forge.run.start")).toMatchObject({
        kind: "span",
        attributes: { runId: "run_1", workflowId: "wf" },
      });
      await subject.shutdown();
    });

    test("an event arrives too, and is distinguishable from a span", async () => {
      const subject = await harness.create();

      subject.observability.startSpan("forge.policy.decide").end();
      subject.observability.event("forge.effect.dispatched", {
        runId: "run_1",
      });

      const records = await drain(subject);
      expect(named(records, "forge.policy.decide").kind).toBe("span");
      expect(named(records, "forge.effect.dispatched").kind).toBe("event");
      await subject.shutdown();
    });

    test("closing attributes land on the record the span opened", async () => {
      const subject = await harness.create();

      subject.observability
        .startSpan("forge.node.judge", { nodeId: "review" })
        .end({ verdict: "pass" });

      expect(named(await drain(subject), "forge.node.judge")).toMatchObject({
        attributes: { nodeId: "review", verdict: "pass" },
      });
      await subject.shutdown();
    });

    test("a span with no attributes at either end still arrives", async () => {
      const subject = await harness.create();

      subject.observability.startSpan("forge.node.agent").end();

      expect(named(await drain(subject), "forge.node.agent").kind).toBe("span");
      await subject.shutdown();
    });
  });
}

/**
 * A trace has to read as one run. Correlating on a `runId` attribute is not the
 * same thing: it makes a dashboard's job possible and a trace viewer's job
 * impossible, and it says nothing about ordering or containment.
 *
 * Every assertion here is about the parent the *sink* was told about, not about
 * an attribute the caller wrote, because the caller writing `runId` on both is
 * exactly the state this replaces.
 */
function describeParenting(harness: ObservabilityConformanceHarness): void {
  describe("a run's spans form one trace", () => {
    test("a span started under a parent arrives as that parent's child", async () => {
      const subject = await harness.create();

      const run = subject.observability.startSpan("forge.run.start", {
        runId: "run_1",
      });
      subject.observability
        .startSpan("forge.node.agent", { runId: "run_1" }, run)
        .end();
      run.end({ status: "SUCCEEDED" });

      const records = await drain(subject);
      const parent = named(records, "forge.run.start");
      const child = named(records, "forge.node.agent");

      expect(child.parentSpanId).toBe(parent.spanId);
      // The run itself is the root, so the trace has one and not two.
      expect(parent.parentSpanId).toBeUndefined();
      await subject.shutdown();
    });

    test("an event recorded under a parent hangs from it too", async () => {
      const subject = await harness.create();

      const run = subject.observability.startSpan("forge.run.start", {
        runId: "run_1",
      });
      subject.observability.event(
        "forge.effect.dispatched",
        { runId: "run_1" },
        run,
      );
      run.end();

      const records = await drain(subject);
      expect(named(records, "forge.effect.dispatched").parentSpanId).toBe(
        named(records, "forge.run.start").spanId,
      );
      await subject.shutdown();
    });

    test("a span started with no parent is a root", async () => {
      const subject = await harness.create();

      subject.observability.startSpan("forge.run.start").end();

      expect(
        named(await drain(subject), "forge.run.start").parentSpanId,
      ).toBeUndefined();
      await subject.shutdown();
    });

    test("two runs open at once do not adopt each other's children", async () => {
      // The reason the parent is a handle rather than ambient state. Both runs
      // hold an open span across an await; anything that remembers "the
      // current span" gets this wrong, and gets it wrong silently.
      const subject = await harness.create();

      const runA = subject.observability.startSpan("forge.run.start", {
        runId: "run_a",
      });
      const runB = subject.observability.startSpan("forge.run.start", {
        runId: "run_b",
      });

      await Promise.all([
        (async () => {
          await tick();
          subject.observability
            .startSpan("forge.node.agent", { runId: "run_a" }, runA)
            .end();
        })(),
        (async () => {
          await tick();
          subject.observability
            .startSpan("forge.node.agent", { runId: "run_b" }, runB)
            .end();
        })(),
      ]);
      runA.end();
      runB.end();

      const records = await drain(subject);
      expect(forRun(records, "forge.node.agent", "run_a").parentSpanId).toBe(
        forRun(records, "forge.run.start", "run_a").spanId,
      );
      expect(forRun(records, "forge.node.agent", "run_b").parentSpanId).toBe(
        forRun(records, "forge.run.start", "run_b").spanId,
      );
      await subject.shutdown();
    });

    test("a span from another adapter is a root here, not a failure", async () => {
      // Two sinks in one process is a real configuration, and a handle only
      // one of them can read is the ordinary case, not a corrupt one.
      const elsewhere = await harness.create();
      const subject = await harness.create();
      const foreign = elsewhere.observability.startSpan("forge.run.start", {
        runId: "somewhere_else",
      });

      expect(() => {
        subject.observability.startSpan("forge.node.agent", {}, foreign).end();
        subject.observability.event("forge.effect.dispatched", {}, foreign);
      }).not.toThrow();
      foreign.end();

      const records = await drain(subject);
      expect(named(records, "forge.node.agent").parentSpanId).toBeUndefined();
      expect(
        named(records, "forge.effect.dispatched").parentSpanId,
      ).toBeUndefined();
      // Nor did the other adapter quietly acquire the children.
      expect(
        (await drain(elsewhere)).map((record) => record.name),
      ).not.toContain("forge.node.agent");
      await subject.shutdown();
      await elsewhere.shutdown();
    });

    test("a parent whose context throws when read never reaches the run", async () => {
      const subject = await harness.create();
      const run = subject.observability.startSpan("forge.run.start", {
        runId: "run_1",
      });
      const broken: Span = {
        end: () => run.end(),
        get context(): never {
          throw new Error("the parent handle is broken");
        },
      };

      expect(() => {
        subject.observability.startSpan("forge.node.judge", {}, broken).end();
        subject.observability.event("forge.node.branch", {}, broken);
      }).not.toThrow();
      broken.end();

      const records = await drain(subject);
      expect(named(records, "forge.node.judge").parentSpanId).toBeUndefined();
      expect(named(records, "forge.node.branch").parentSpanId).toBeUndefined();
      // The run span itself still landed, so this is a lost edge and not a
      // lost record.
      expect(named(records, "forge.run.start").attributes.runId).toBe("run_1");
      await subject.shutdown();
    });
  });
}

/**
 * The property that matters most. Run data is the most PII-dense thing in this
 * system, and a span is the one copy of it that leaves the trust boundary
 * without an access control in front of it.
 *
 * Asserted against the serialised record the *sink* was handed, not against
 * what the adapter remembers, because the adapter is the thing doing the
 * redacting and asking it to mark its own work proves nothing.
 */
function describeRedaction(harness: ObservabilityConformanceHarness): void {
  describe("no payload reaches the sink", () => {
    test("nothing in the probe survives to the sink", async () => {
      const subject = await harness.create();

      subject.observability.startSpan("forge.node.agent", PII_PROBE).end();
      subject.observability.event("forge.effect.dispatched", PII_PROBE);
      const serialised = JSON.stringify(await drain(subject));

      for (const needle of PII_NEEDLES) {
        expect(serialised).not.toContain(needle);
      }
      await subject.shutdown();
    });

    test("the identifiers a dashboard needs do survive", async () => {
      // Without this an adapter could pass the suite by exporting nothing, or
      // by replacing every attribute it is handed.
      const subject = await harness.create();

      subject.observability.startSpan("forge.node.agent", PII_PROBE).end();

      expect(named(await drain(subject), "forge.node.agent")).toMatchObject({
        attributes: PII_PROBE_SURVIVORS,
      });
      await subject.shutdown();
    });

    test("a payload smuggled in through a closing attribute is scrubbed too", async () => {
      // The end of a span is the easiest place to forget: the node has run, and
      // whatever it produced is right there.
      const subject = await harness.create();

      subject.observability
        .startSpan("forge.node.agent", { workflowId: "wf" })
        .end(PII_PROBE);
      const records = await drain(subject);

      for (const needle of PII_NEEDLES) {
        expect(JSON.stringify(records)).not.toContain(needle);
      }
      expect(named(records, "forge.node.agent").attributes).toMatchObject({
        workflowId: "wf",
        prompt: REDACTED,
      });
      await subject.shutdown();
    });
  });
}

function describePrincipal(harness: ObservabilityConformanceHarness): void {
  describe("a principal never reaches the sink", () => {
    test("the decision is exported as a hash and a count, never as a person", async () => {
      const subject = await harness.create();

      subject.observability.event("forge.approval.decided", PRINCIPAL_PROBE);

      const record = named(await drain(subject), "forge.approval.decided");
      expect(record.attributes).toMatchObject({
        runId: "run_1",
        approvalId: "approval_1",
        decision: "approve",
        // The link back to `ApprovalRecord.decidedBy`, which is where "who"
        // actually lives.
        principalHash: "9f2a5c1e4b7d0a63",
        approverCount: 2,
        principal: REDACTED,
        approverId: REDACTED,
        decidedBySubject: REDACTED,
      });
      expect(JSON.stringify(record)).not.toContain("ada.lovelace");
      expect(JSON.stringify(record)).not.toContain("u_88");
      await subject.shutdown();
    });
  });
}

/**
 * Telemetry fails open, alone among the ports. Everything else in Forge fails
 * closed; a sink that could stop a run would make the observability of a
 * payroll workflow a dependency of paying anyone.
 */
function describeFailOpen(harness: ObservabilityConformanceHarness): void {
  describe("a broken sink never reaches the caller", () => {
    test("every adapter can stage an internal failure", () => {
      // A harness that declares no fault would silently skip this whole
      // section, which is the section that matters when the collector is down.
      expect(harness.faults).toContain("throws");
    });

    for (const fault of harness.faults) {
      test(`recording does not throw when the sink ${fault}`, async () => {
        const subject = await harness.createFaulty(fault);

        expect(() => {
          const span = subject.observability.startSpan("forge.run.start", {
            runId: "run_1",
          });
          span.end({ status: "SUCCEEDED" });
          subject.observability.event("forge.effect.dispatched", {
            runId: "run_1",
          });
        }).not.toThrow();

        await expect(subject.flush()).resolves.toBeUndefined();
        await expect(subject.shutdown()).resolves.toBeUndefined();
      });

      test(`shutdown resolves when the sink ${fault}`, async () => {
        // A process that cannot exit because its collector is unreachable is
        // an outage caused by the thing that was supposed to observe one.
        const subject = await harness.createFaulty(fault);
        subject.observability.event("forge.run.succeeded", { runId: "run_1" });

        await expect(subject.shutdown()).resolves.toBeUndefined();
      });
    }

    test("recording after shutdown is a no-op rather than a throw", async () => {
      const subject = await harness.create();
      await subject.shutdown();

      expect(() => {
        subject.observability.startSpan("forge.run.start").end();
        subject.observability.event("forge.run.succeeded");
      }).not.toThrow();
    });
  });
}

function describeShutdown(harness: ObservabilityConformanceHarness): void {
  describe("shutdown flushes", () => {
    test("what was recorded but not yet exported still reaches the sink", async () => {
      // The spans that matter most are usually the last ones — the failure, the
      // dispatch, the decision — and a process that exits without flushing
      // loses exactly those.
      const subject = await harness.create();

      subject.observability.event("forge.effect.dispatched", {
        runId: "run_1",
        nodeId: "publish",
      });
      subject.observability
        .startSpan("forge.run.start", { runId: "run_1" })
        .end({ status: "SUCCEEDED" });

      await subject.shutdown();

      expect(subject.recorded().map((record) => record.name)).toEqual(
        expect.arrayContaining(["forge.effect.dispatched", "forge.run.start"]),
      );
    });

    test("shutting down twice is safe, because a process closes in a finally", async () => {
      const subject = await harness.create();

      await subject.shutdown();
      await expect(subject.shutdown()).resolves.toBeUndefined();
    });
  });
}

/**
 * Runs the whole `ObservabilityPort` contract against one adapter. A new sink
 * proves itself by calling this with its own factory, which is what stops the
 * in-memory recorder and the exporting adapter drifting apart.
 */
export function describeObservabilityConformance(
  harness: ObservabilityConformanceHarness,
): void {
  describe(`${harness.name} · ObservabilityPort conformance`, () => {
    describeRecording(harness);
    describeParenting(harness);
    describeRedaction(harness);
    describePrincipal(harness);
    describeFailOpen(harness);
    describeShutdown(harness);
  });
}
