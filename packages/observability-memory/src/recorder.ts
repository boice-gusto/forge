import {
  createSpanContexts,
  failOpen,
  formatTraceparent,
  parseTraceparent,
  redactAttributes,
  traceparentOf,
} from "@forge/observability";
import type {
  ClockPort,
  ObservabilityPort,
  RecordedSpan,
  Span,
  SpanAttributes,
  SpanParent,
  Traceparent,
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
  /**
   * The trace this entry landed in.
   *
   * Real ids, in the real format, even though nothing here exports them. A
   * recorder that invented a shape of its own would let the conformance suite
   * pass on both adapters while they disagreed about the one thing they have
   * to agree on — and disagreeing about a traceparent is invisible until an
   * incident, when half a run is missing from the trace.
   */
  readonly traceId: string;
  readonly spanId: string;
  /**
   * The span this hangs from, whether it was recorded here or named by a
   * traceparent from another process. `parentSeq` covers only the first, and
   * a resumed run's parent has no `seq` here because it never happened here.
   */
  readonly parentSpanId?: string;
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
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  attributes: SpanAttributes;
  ended: boolean;
}

/**
 * Ids derived from a counter rather than a random source.
 *
 * This recorder is what tests assert against, and a test that has to match a
 * random id can only match it loosely. Deterministic ids are also the reason
 * this cannot be mistaken for a production tracer: they are unique within a
 * recorder and nowhere else, which is exactly the scope of what it records.
 */
const hexId = (seed: number, width: number): string =>
  seed.toString(16).padStart(width, "0");

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
  /**
   * The trace a span with no usable parent starts. Incremented per root, so
   * two unrelated runs recorded through one instance do not silently merge.
   */
  let roots = 0;

  const record = (
    kind: "span" | "event",
    name: string,
    attributes: SpanAttributes,
    ended: boolean,
    parent: SpanParent | undefined,
  ): MutableEntry => {
    const parentSeq = contexts.resolve(parent);
    const seq = timeline.length;

    /**
     * Three cases, in the order they are trusted.
     *
     * A handle this recorder issued is exact. Failing that, a traceparent —
     * which is how a run resumed in another process finds its way back into
     * the trace it started in, and the case this whole mechanism exists for.
     * Failing both, a new root, because a span that cannot find its parent
     * still has to be recorded.
     */
    const local = parentSeq === undefined ? undefined : timeline[parentSeq];
    const remote =
      local === undefined ? parseTraceparent(traceparentOf(parent)) : undefined;
    const inherited = local ?? remote;
    const traceId = inherited?.traceId ?? hexId(++roots, 32);

    const entry: MutableEntry = {
      seq,
      at: clock.now().toISOString(),
      kind,
      name,
      ...(parentSeq === undefined ? {} : { parentSeq }),
      ...(inherited === undefined ? {} : { parentSpanId: inherited.spanId }),
      traceId,
      // `seq + 1`: a span id of all zeroes is invalid per the spec, and the
      // first entry recorded has seq 0.
      spanId: hexId(seq + 1, 16),
      attributes: redactAttributes(attributes),
      ended,
    };
    timeline.push(entry);
    (kind === "span" ? spans : events).push(entry);
    return entry;
  };

  const traceparentFor = (entry: MutableEntry): Traceparent =>
    // Always sampled: this recorder keeps everything it is handed, so claiming
    // otherwise would misdescribe it to whoever resumes under it.
    formatTraceparent({
      traceId: entry.traceId,
      spanId: entry.spanId,
      flags: "01",
    });

  const port: ObservabilityPort = {
    startSpan(
      name: string,
      attributes: SpanAttributes = {},
      parent?: SpanParent,
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
        traceparent: traceparentFor(entry),
      };
    },
    event(name: string, attributes: SpanAttributes = {}, parent?: SpanParent) {
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
