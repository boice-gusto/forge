export type SpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;

export interface Span {
  end(attributes?: SpanAttributes): void;
}

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: SpanAttributes;
  readonly ended: boolean;
}

/**
 * Spans and audit events (011). Kept deliberately narrow: the runtime records
 * what happened, and an adapter decides where that goes. Redaction is the
 * adapter's job — nothing here should carry a payload.
 */
export interface ObservabilityPort {
  startSpan(name: string, attributes?: SpanAttributes): Span;
  event(name: string, attributes?: SpanAttributes): void;
}
