import {
  createSpanContexts,
  failOpen,
  redactAttributes,
} from "@forge/observability";
import type {
  ClockPort,
  ObservabilityPort,
  RecordedSpan,
  Span,
  SpanAttributes,
} from "@forge/ports";

/**
 * Spans and events are separate lists below, which loses the interleaving. The
 * run inspector needs it — a policy decision landing after the gate opened
 * tells a different story from one landing before — so the ordered view is the
 * one the control plane serves.
 */
export interface ObservedEvent extends RecordedSpan {
  readonly seq: number;
  readonly at: string;
  readonly kind: "span" | "event";
  /**
   * The `seq` of the span this one hangs from, if it was started under a
   * parent. This is the recorder's whole trace structure: the OTel adapter
   * builds a real parent/child edge, and this records the same relationship so
   * a test can assert a run's nodes belong to the run.
   */
  readonly parentSeq?: number;
}

export interface MemoryObservability extends ObservabilityPort {
  readonly spans: readonly RecordedSpan[];
  readonly events: readonly RecordedSpan[];
  /** Spans and events interleaved, oldest first. */
  readonly timeline: readonly ObservedEvent[];
  names(): readonly string[];
}

interface MutableEntry {
  readonly seq: number;
  readonly at: string;
  readonly kind: "span" | "event";
  readonly name: string;
  readonly parentSeq?: number;
  attributes: SpanAttributes;
  ended: boolean;
}

/**
 * Redaction happens here rather than at the call sites (011 §5.2): a call site
 * that forgets is a silent disclosure, whereas an adapter that scrubs
 * everything it is handed cannot forget.
 */
export function createMemoryObservability(
  clock: ClockPort = { now: () => new Date() },
): MemoryObservability {
  const timeline: MutableEntry[] = [];
  const spans: RecordedSpan[] = [];
  const events: RecordedSpan[] = [];
  const contexts = createSpanContexts<number>();

  const record = (
    kind: "span" | "event",
    name: string,
    attributes: SpanAttributes,
    ended: boolean,
    parent: Span | undefined,
  ): MutableEntry => {
    const parentSeq = contexts.resolve(parent);
    const entry: MutableEntry = {
      seq: timeline.length,
      at: clock.now().toISOString(),
      kind,
      name,
      ...(parentSeq === undefined ? {} : { parentSeq }),
      attributes: redactAttributes(attributes),
      ended,
    };
    timeline.push(entry);
    (kind === "span" ? spans : events).push(entry);
    return entry;
  };

  const port: ObservabilityPort = {
    startSpan(
      name: string,
      attributes: SpanAttributes = {},
      parent?: Span,
    ): Span {
      const entry = record("span", name, attributes, false, parent);
      return {
        end(endAttributes?: SpanAttributes) {
          entry.ended = true;
          if (endAttributes !== undefined) {
            entry.attributes = {
              ...entry.attributes,
              ...redactAttributes(endAttributes),
            };
          }
        },
        context: contexts.issue(entry.seq),
      };
    },
    event(name: string, attributes: SpanAttributes = {}, parent?: Span) {
      record("event", name, attributes, true, parent);
    },
  };

  return {
    spans,
    events,
    timeline,
    names: () => spans.map((span) => span.name),
    // Telemetry fails open here too, not only where the runtime happens to
    // wrap it. An injected clock, or the next thing recorded through this
    // adapter, must not be able to fail a run by throwing.
    ...failOpen(port),
  };
}
