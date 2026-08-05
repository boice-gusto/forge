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
