export type SpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;

/**
 * An opaque handle to an open span, meaningful only to the adapter that issued
 * it. Anyone else — including a second adapter in the same process — sees an
 * object with nothing on it and starts a root instead.
 */
export type SpanContext = object;

export interface Span {
  end(attributes?: SpanAttributes): void;
  /**
   * Hand back as `parent` to start a child under this span.
   *
   * Carried as a value on the handle rather than kept in ambient state, so a
   * run holding its span across an `await` cannot have a concurrent run's span
   * adopted underneath it, and the fail-open wrapper — which necessarily
   * returns a different `Span` object — can pass it along unchanged.
   */
  readonly context?: SpanContext;
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
 *
 * `parent` is data, never a continuation. A port that took the caller's
 * callback so it could establish an ambient context would be a port that can
 * drop the run it was only supposed to report on, and telemetry is the one
 * thing here that fails open.
 */
export interface ObservabilityPort {
  startSpan(name: string, attributes?: SpanAttributes, parent?: Span): Span;
  event(name: string, attributes?: SpanAttributes, parent?: Span): void;
}
