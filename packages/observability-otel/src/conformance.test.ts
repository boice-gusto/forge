import { createServer } from "node:http";
import {
  describeObservabilityConformance,
  type ExportedRecord,
  type ObservabilitySubject,
  type SinkFault,
} from "@forge/observability-conformance";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type {
  BufferConfig,
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";

import {
  createOtelObservability,
  TELEMETRY_KIND_ATTRIBUTE,
} from "./observability.js";

/** A port nothing is listening on, chosen by the OS rather than assumed. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return port;
}

/**
 * The far side of the adapter. Conformance reads from here rather than from
 * anything the adapter keeps, so "no payload reached the sink" is a claim about
 * what left, not about what the redactor remembers doing.
 */
class RecordingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }

  async shutdown(): Promise<void> {}
}

class ThrowingExporter implements SpanExporter {
  export(): void {
    throw new Error("the sink threw");
  }

  async shutdown(): Promise<void> {
    throw new Error("the sink threw");
  }
}

class RejectingExporter implements SpanExporter {
  export(_spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    done({
      code: ExportResultCode.FAILED,
      error: new Error("the sink failed"),
    });
  }

  async shutdown(): Promise<void> {}
}

class SilentExporter implements SpanExporter {
  export(): void {
    // Accepts the work and never answers, like a collector under load.
  }

  async shutdown(): Promise<void> {
    await new Promise(() => undefined);
  }
}

function toRecord(span: ReadableSpan): ExportedRecord {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (key === TELEMETRY_KIND_ATTRIBUTE) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      attributes[key] = value;
    }
  }
  return {
    name: span.name,
    kind:
      span.attributes[TELEMETRY_KIND_ATTRIBUTE] === "event" ? "event" : "span",
    attributes,
    spanId: span.spanContext().spanId,
    ...(span.parentSpanContext === undefined
      ? {}
      : { parentSpanId: span.parentSpanContext.spanId }),
  };
}

function subject(
  exporter: SpanExporter,
  spans: () => readonly ReadableSpan[],
  batch?: BufferConfig,
): ObservabilitySubject {
  const observability = createOtelObservability({
    exporter,
    // Short enough that a shutdown which does not resolve fails the suite by
    // timing out rather than by hanging it.
    shutdownTimeoutMs: 250,
    ...(batch === undefined ? {} : { batch }),
  });
  return {
    observability,
    flush: () => observability.forceFlush(),
    shutdown: () => observability.shutdown(),
    recorded: () => spans().map(toRecord),
  };
}

async function faulty(fault: SinkFault): Promise<ObservabilitySubject> {
  const empty = (): readonly ReadableSpan[] => [];
  if (fault === "throws") return subject(new ThrowingExporter(), empty);
  if (fault === "rejects") return subject(new RejectingExporter(), empty);
  if (fault === "slow") {
    return subject(new SilentExporter(), empty, { exportTimeoutMillis: 50 });
  }
  return subject(
    new OTLPTraceExporter({
      url: `http://127.0.0.1:${await closedPort()}/v1/traces`,
      timeoutMillis: 250,
    }),
    empty,
  );
}

describeObservabilityConformance({
  name: "@forge/observability-otel",
  faults: ["throws", "rejects", "unreachable", "slow"],
  async create() {
    const exporter = new RecordingExporter();
    return subject(exporter, () => exporter.spans);
  },
  createFaulty: faulty,
});
