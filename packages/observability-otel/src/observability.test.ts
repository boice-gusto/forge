import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "vitest";

import {
  createOtelObservability,
  TELEMETRY_KIND_ATTRIBUTE,
} from "./observability.js";

class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {}
}

function names(exporter: RecordingExporter): readonly string[] {
  return exporter.spans.map((span) => span.name);
}

describe("spans are batched, so the flush on shutdown is what saves them", () => {
  test("a recorded span is withheld until something flushes it", async () => {
    // If this ever passes without the flush, the shutdown test below has
    // stopped proving anything: a processor that exports immediately cannot
    // lose the last spans of a run, and losing them is the failure being
    // guarded against.
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({ exporter, env: {} });

    observability.event("forge.effect.dispatched", { runId: "run_1" });
    expect(exporter.spans).toEqual([]);

    await observability.shutdown();
    expect(names(exporter)).toEqual(["forge.effect.dispatched"]);
  });

  test("the last spans of a run survive an exit", async () => {
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({ exporter, env: {} });

    const span = observability.startSpan("forge.run.start", { runId: "run_1" });
    observability.event("forge.approval.decided", { runId: "run_1" });
    observability.event("forge.effect.dispatched", { runId: "run_1" });
    span.end({ status: "SUCCEEDED" });
    await observability.shutdown();

    expect([...names(exporter)].sort()).toEqual([
      "forge.approval.decided",
      "forge.effect.dispatched",
      "forge.run.start",
    ]);
  });

  test("a span still open is not exported as though it had finished", async () => {
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({ exporter, env: {} });

    observability.startSpan("forge.run.start", { runId: "run_1" });
    await observability.forceFlush();

    expect(exporter.spans).toEqual([]);
  });
});

describe("an event is a span the taxonomy can tell apart", () => {
  test("each carries the kind it was recorded as", async () => {
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({ exporter, env: {} });

    observability.startSpan("forge.policy.decide").end();
    observability.event("forge.run.transition");
    await observability.shutdown();

    expect(
      Object.fromEntries(
        exporter.spans.map((span) => [
          span.name,
          span.attributes[TELEMETRY_KIND_ATTRIBUTE],
        ]),
      ),
    ).toEqual({
      "forge.policy.decide": "span",
      "forge.run.transition": "event",
    });
  });
});

describe("the adapter announces itself", () => {
  test("the resource carries the service name the operator configured", async () => {
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({
      exporter,
      env: { OTEL_SERVICE_NAME: "forge-api" },
    });

    observability.event("forge.run.succeeded");
    await observability.shutdown();

    expect(exporter.spans[0]?.resource.attributes["service.name"]).toBe(
      "forge-api",
    );
  });
});

describe("construction says what is missing rather than guessing", () => {
  test("no endpoint and no exporter is refused at boot", () => {
    expect(() => createOtelObservability({ env: {} })).toThrow(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    );
  });

  test("an explicit exporter needs no endpoint at all", () => {
    expect(() =>
      createOtelObservability({ exporter: new RecordingExporter(), env: {} }),
    ).not.toThrow();
  });
});

describe("a resumed run inherits the sampling decision, not just the trace", () => {
  const traceparentWith = (flags: string) =>
    `00-${"a1".repeat(16)}-${"b2".repeat(8)}-${flags}`;

  test("a run sampled in at creation keeps recording when another process resumes it", async () => {
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({ exporter, env: {} });

    observability
      .startSpan("forge.node.effect", { runId: "run_1" }, traceparentWith("01"))
      .end();
    await observability.shutdown();

    expect(names(exporter)).toEqual(["forge.node.effect"]);
    expect(exporter.spans[0]?.spanContext().traceId).toBe("a1".repeat(16));
  });

  test("a run sampled out at creation stays sampled out", async () => {
    /**
     * The half of the flags that is easy to drop and expensive to have
     * dropped. Sampling is decided once, for the run, by the process that
     * started it. A resuming process that ignored the decision would give a
     * backend the tail of a trace whose head was never sent — a run that
     * appears to begin at its approval gate — and would quietly undo whatever
     * sampling rate the deployment chose, at exactly the volume that rate was
     * chosen to control.
     */
    const exporter = new RecordingExporter();
    const observability = createOtelObservability({ exporter, env: {} });

    observability
      .startSpan("forge.node.effect", { runId: "run_1" }, traceparentWith("00"))
      .end();
    await observability.shutdown();

    expect(names(exporter)).toEqual([]);
  });
});
