export type SpanAttributes = Readonly<
  Record<string, string | number | boolean>
>;

/**
 * An opaque handle to an open span, meaningful only to the adapter that issued
 * it. Anyone else — including a second adapter in the same process — sees an
 * object with nothing on it and starts a root instead.
 */
export type SpanContext = object;

/**
 * A W3C `traceparent` — `00-<trace id>-<span id>-<flags>` — as it travels
 * between processes.
 *
 * The portable form of a parent. A {@link SpanContext} is meaningful only to
 * the adapter that issued it and only for as long as that process lives, which
 * is exactly the lifetime a Forge run outlasts: a run is created by one
 * process, walked by another, and resumed by a third after a human decides.
 * A string on the run record is what makes those one trace instead of three.
 */
export type Traceparent = string;

/**
 * Where a span hangs from.
 *
 * Two forms of the same fact. In-process it is the span itself, which the
 * adapter recognises. Across a process boundary only the {@link Traceparent}
 * survives, so it is accepted directly rather than requiring the caller to
 * reconstitute a `Span` it has no way to build.
 */
export type SpanParent = Span | Traceparent;

export interface Span {
  end(attributes?: SpanAttributes): void;
  /**
   * This span in portable form, if the adapter can express it.
   *
   * Read by whoever persists the run, so a process that has never seen this
   * span can still record underneath it. Optional because an adapter that
   * traces nothing has nothing to hand over, and a missing edge costs a trace,
   * never a run.
   */
  readonly traceparent?: Traceparent;
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
 * thing here that fails open. Widening it to accept a {@link Traceparent} is
 * the same principle carried across a process boundary — still data, just the
 * only form of it that survives the trip.
 */
export interface ObservabilityPort {
  startSpan(
    name: string,
    attributes?: SpanAttributes,
    parent?: SpanParent,
  ): Span;
  event(name: string, attributes?: SpanAttributes, parent?: SpanParent): void;
}

/* -------------------------------------------------------------------------- */
/* Durable run events                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One record of a run's timeline, as the recorder hands it to the store.
 *
 * `attributes` arrive **already redacted**. The recorder is the single writer
 * and the only place scrubbing happens, so a store is a dumb log: it keeps what
 * it was handed. That is a checked property of the conformance suite, not a
 * convention — a store that quietly rewrote a record would make the proof that
 * nothing PII-bearing ever reached it unfalsifiable.
 */
export interface RunEventInput {
  /** The run this belongs to. A record with no run has no timeline to join. */
  readonly runId: string;
  /** Mirrors {@link ObservabilityPort}: `startSpan` or `event`. */
  readonly kind: "span" | "event";
  readonly name: string;
  readonly at: string;
  readonly attributes: SpanAttributes;
}

export interface RunEvent extends RunEventInput {
  /**
   * Total order within a run, assigned by the store on insert.
   *
   * A fact about the row, not about the clock that wrote it: two events in the
   * same millisecond would tie on `at`, and a tie is an event that swaps places
   * between two reads. The run stores order by a sequence for the same reason.
   */
  readonly seq: number;
}

/**
 * A run's timeline, durable and queryable — what an operator reads in the run
 * inspector (012 §4.3) about a run this process may never have seen.
 *
 * **Deliberately not part of {@link ObservabilityPort}.** That port is a
 * synchronous, fire-and-forget tracing sink whose adapters export and forget:
 * an OTLP exporter has no answer to "what happened in run X", and widening the
 * port would either force every sink to grow a query it cannot serve or make
 * `list` an optional method every caller has to test for. They also fail
 * differently — a sink drops a span and nobody notices, whereas a history that
 * silently drops a record is an audit gap. One is a report; this is a record.
 *
 * It is still telemetry, so it still fails open: `@forge/observability`'s
 * recorder is what binds a sink and a store together, and it never lets either
 * one reach the run.
 */
export interface RunEventStorePort {
  /** Appends one record and returns the sequence that orders it. */
  append(event: RunEventInput): Promise<number>;
  /**
   * Merges a span's closing attributes into the record `append` returned, so a
   * verdict or a final status lands on the span that opened rather than
   * arriving as a second row out of order. Unknown sequences are ignored.
   */
  close(seq: number, attributes: SpanAttributes): Promise<void>;
  /** One run's records, oldest first. Empty for a run with no timeline. */
  list(runId: string): Promise<readonly RunEvent[]>;
}
