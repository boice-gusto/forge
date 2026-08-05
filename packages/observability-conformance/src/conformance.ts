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

async function drain(
  subject: ObservabilitySubject,
): Promise<readonly ExportedRecord[]> {
  await subject.flush();
  return subject.recorded();
}

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
    describeRedaction(harness);
    describePrincipal(harness);
    describeFailOpen(harness);
    describeShutdown(harness);
  });
}
