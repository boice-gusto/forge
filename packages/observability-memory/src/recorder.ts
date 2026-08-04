import type {
  ObservabilityPort,
  RecordedSpan,
  Span,
  SpanAttributes,
} from "@forge/ports";

export interface MemoryObservability extends ObservabilityPort {
  readonly spans: readonly RecordedSpan[];
  readonly events: readonly RecordedSpan[];
  names(): readonly string[];
}

/**
 * Records spans and events in order so a test can assert what the runtime
 * reported, rather than trusting that it reported anything.
 */
export function createMemoryObservability(): MemoryObservability {
  const spans: (RecordedSpan & { ended: boolean })[] = [];
  const events: RecordedSpan[] = [];

  return {
    spans,
    events,
    names: () => spans.map((span) => span.name),
    startSpan(name: string, attributes: SpanAttributes = {}): Span {
      const record = { name, attributes, ended: false };
      spans.push(record);
      return {
        end(endAttributes?: SpanAttributes) {
          record.ended = true;
          if (endAttributes !== undefined) {
            Object.assign(
              record.attributes as Record<string, unknown>,
              endAttributes,
            );
          }
        },
      };
    },
    event(name: string, attributes: SpanAttributes = {}) {
      events.push({ name, attributes, ended: true });
    },
  };
}
