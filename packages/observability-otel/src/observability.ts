import {
  createSpanContexts,
  failOpen,
  redactAttributes,
} from "@forge/observability";
import type { ObservabilityPort, Span, SpanAttributes } from "@forge/ports";
import { type Context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type BufferConfig,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import {
  type Environment,
  resolveHeaders,
  resolveServiceName,
  resolveTracesEndpoint,
} from "./environment.js";

/**
 * The port has spans and events; OpenTelemetry has spans. An event becomes a
 * zero-duration span rather than an OTel span *event* because a span with no
 * duration is queryable in every backend, and it is marked with this attribute
 * so the two remain distinguishable. Given a `parent` it is nested like any
 * other child, so an event is part of the run's trace rather than beside it.
 */
export const TELEMETRY_KIND_ATTRIBUTE = "forge.telemetry.kind";

const TRACER_NAME = "@forge/observability-otel";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface OtelObservabilityOptions {
  /** Defaults to `OTEL_SERVICE_NAME`, then `forge`. */
  readonly serviceName?: string;
  /** Defaults to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, then the base endpoint. */
  readonly endpoint?: string;
  /** Merged over `OTEL_EXPORTER_OTLP_HEADERS`. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Replaces the OTLP transport entirely. Supplying one skips endpoint
   * resolution, because the caller has said where spans go.
   */
  readonly exporter?: SpanExporter;
  readonly batch?: BufferConfig;
  /**
   * How long shutdown waits for a flush before giving up on it. A collector
   * that stops answering must not stop a process from exiting.
   */
  readonly shutdownTimeoutMs?: number;
  /** Injected so a test never has to mutate `process.env`. */
  readonly env?: Environment;
}

export interface OtelObservability extends ObservabilityPort {
  /** Pushes buffered spans to the collector. Never rejects. */
  forceFlush(): Promise<void>;
  /** Flushes and stops. Never rejects, and always returns. */
  shutdown(): Promise<void>;
}

/**
 * Resolves once `work` settles or `timeoutMs` elapses, whichever is first, and
 * never rejects.
 *
 * Both halves are load-bearing. Swallowing the rejection keeps an export
 * failure out of the caller; the timeout keeps an export that never answers
 * out of process exit. A `shutdown()` awaiting a dead collector is the outage
 * caused by the thing that was supposed to observe one.
 */
async function settle(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work.then(noop, noop), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function noop(): void {}

/**
 * `ObservabilityPort` over the OpenTelemetry SDK, exporting over OTLP/HTTP.
 *
 * Two properties are not negotiable and neither is the caller's job:
 *
 * - **Redaction happens here.** Every attribute is scrubbed before the SDK sees
 *   it, so nothing downstream — the batch processor, the exporter, the wire —
 *   is ever handed a payload. A call site that forgets is a silent disclosure;
 *   an adapter that scrubs everything it is handed cannot forget.
 * - **It fails open.** Telemetry is a report, never a dependency (011 §2).
 */
export function createOtelObservability(
  options: OtelObservabilityOptions = {},
): OtelObservability {
  const env = options.env ?? process.env;
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: resolveTracesEndpoint(env, options.endpoint),
      headers: resolveHeaders(env, options.headers),
    });

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: resolveServiceName(env, options.serviceName),
    }),
    spanProcessors: [new BatchSpanProcessor(exporter, options.batch)],
  });
  // Deliberately not `register()`ed: a library that installs itself as the
  // global tracer provider takes a decision that belongs to the composition
  // root, and makes two stacks in one process impossible to test.
  const tracer = provider.getTracer(TRACER_NAME);
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const contexts = createSpanContexts<Context>();

  /**
   * `ROOT_CONTEXT` rather than `context.active()`: this provider is
   * deliberately not registered globally, so there is no active context to
   * read, and reading one would make the parent depend on whatever else in the
   * process happens to have installed a context manager.
   */
  const startOtelSpan = (
    name: string,
    attributes: SpanAttributes,
    kind: "span" | "event",
    parent: Span | undefined,
  ) =>
    tracer.startSpan(
      name,
      {
        attributes: {
          ...redactAttributes(attributes),
          [TELEMETRY_KIND_ATTRIBUTE]: kind,
        },
      },
      contexts.resolve(parent) ?? ROOT_CONTEXT,
    );

  const port: ObservabilityPort = {
    startSpan(name: string, attributes: SpanAttributes = {}, parent?: Span) {
      const span = startOtelSpan(name, attributes, "span", parent);
      return {
        end(endAttributes?: SpanAttributes) {
          if (endAttributes !== undefined) {
            span.setAttributes(redactAttributes(endAttributes));
          }
          span.end();
        },
        context: contexts.issue(trace.setSpan(ROOT_CONTEXT, span)),
      };
    },
    event(name: string, attributes: SpanAttributes = {}, parent?: Span) {
      startOtelSpan(name, attributes, "event", parent).end();
    },
  };

  return {
    ...failOpen(port),
    forceFlush: () => settle(provider.forceFlush(), timeoutMs),
    shutdown: () => settle(provider.shutdown(), timeoutMs),
  };
}
