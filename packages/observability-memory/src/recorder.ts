import { redactAttributes } from "@forge/observability";
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

  const record = (
    kind: "span" | "event",
    name: string,
    attributes: SpanAttributes,
    ended: boolean,
  ): MutableEntry => {
    const entry: MutableEntry = {
      seq: timeline.length,
      at: clock.now().toISOString(),
      kind,
      name,
      attributes: redactAttributes(attributes),
      ended,
    };
    timeline.push(entry);
    (kind === "span" ? spans : events).push(entry);
    return entry;
  };

  return {
    spans,
    events,
    timeline,
    names: () => spans.map((span) => span.name),
    startSpan(name: string, attributes: SpanAttributes = {}): Span {
      const entry = record("span", name, attributes, false);
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
      };
    },
    event(name: string, attributes: SpanAttributes = {}) {
      record("event", name, attributes, true);
    },
  };
}
