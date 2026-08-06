// `@forge/ports`'s barrel does not name the run-event types; this subpath is
// the same file it re-exports everything else in `observability.ts` from, and
// collapses to a plain `@forge/ports` import the day the barrel lists them.
import type {
  ClockPort,
  ObservabilityPort,
  RunEventStorePort,
  Span,
  SpanAttributes,
  SpanParent,
} from "@forge/ports";

import { failOpen } from "./fail-open.js";
import { redactAttributes } from "./redaction.js";

/**
 * Binds a tracing sink to a durable {@link RunEventStorePort}, so a run's
 * timeline outlives the process that recorded it.
 *
 * Three properties are the whole reason this exists rather than a store adapter
 * that also implements `ObservabilityPort`:
 *
 * - **Redaction runs here, before the write.** The store is the thing being
 *   protected — a row in Postgres is the one copy of run data that survives the
 *   process and sits behind no access control at rest — so it is never handed a
 *   payload to scrub. One writer, one scrubbing point, and a test can therefore
 *   aim at a store that does nothing at all and still prove the property.
 * - **Writes are serialised.** The store assigns the sequence at insert; two
 *   inserts racing would order a run's timeline by whichever socket answered
 *   first. Recording order is the order rows are offered.
 * - **Nothing here is awaited by the run.** A store that is down, slow or
 *   throwing costs a record and never a run.
 */
export interface RunEventRecorder extends ObservabilityPort {
  /**
   * Resolves once every write recorded so far has been offered to the store.
   *
   * Nothing in a run waits on this; a composition root awaits it on the way out.
   * The records that matter most are the last ones — the dispatch, the failure,
   * the decision — and those are exactly the ones a process that exits without
   * draining loses.
   */
  settled(): Promise<void>;
}

export function recordRunEvents(
  sink: ObservabilityPort,
  store: RunEventStorePort,
  clock: ClockPort = { now: () => new Date() },
): RunEventRecorder {
  /** No record was written, so there is no sequence to close later. */
  const UNWRITTEN: Promise<undefined> = Promise.resolve(undefined);

  /**
   * The queue every write joins, so the store assigns sequences in the order
   * the run recorded. It can never be rejected — each link swallows its own
   * failure and resolves to `undefined` — which is both why one write failing
   * does not strand the run's remaining events behind it, and why `settled()`
   * below is safe to await.
   */
  let tail: Promise<unknown> = Promise.resolve();

  function serially<T>(work: () => Promise<T>): Promise<T | undefined> {
    const next = tail.then(async (): Promise<T | undefined> => {
      try {
        return await work();
      } catch {
        return undefined;
      }
    });
    tail = next;
    return next;
  }

  function append(
    kind: "span" | "event",
    name: string,
    attributes: SpanAttributes,
  ): Promise<number | undefined> {
    try {
      const redacted = redactAttributes(attributes);
      const runId = redacted.runId;
      // A record with no run cannot be read back by run, so it is dropped
      // rather than filed under a placeholder that no query would ever find.
      if (typeof runId !== "string" || runId === "") return UNWRITTEN;
      const at = clock.now().toISOString();
      return serially(() =>
        store.append({ runId, kind, name, at, attributes: redacted }),
      );
    } catch {
      return UNWRITTEN;
    }
  }

  /**
   * The two halves fail independently. A collector that is down must not also
   * empty the operator's timeline, and a database that is down must not empty
   * the trace — so neither is inside the other's `try`.
   */
  function open(
    name: string,
    attributes: SpanAttributes,
    parent?: SpanParent,
  ): Span {
    try {
      return sink.startSpan(name, attributes, parent);
    } catch {
      return { end: () => undefined };
    }
  }

  const port: ObservabilityPort = {
    startSpan(
      name: string,
      attributes: SpanAttributes = {},
      parent?: SpanParent,
    ): Span {
      const span = open(name, attributes, parent);
      const appended = append("span", name, attributes);
      return {
        end(endAttributes?: SpanAttributes) {
          try {
            span.end(endAttributes);
          } catch {}
          if (endAttributes === undefined) return;
          const redacted = redactAttributes(endAttributes);
          void serially(async () => {
            const seq = await appended;
            if (seq !== undefined) await store.close(seq, redacted);
          });
        },
        ...(span.context === undefined ? {} : { context: span.context }),
      };
    },
    event(name: string, attributes: SpanAttributes = {}, parent?: SpanParent) {
      try {
        sink.event(name, attributes, parent);
      } catch {}
      void append("event", name, attributes);
    },
  };

  return {
    // Stated on the composed port too, not only inside each half. A caller who
    // binds this is binding one `ObservabilityPort`, and the guarantee has to
    // belong to the thing they bound.
    ...failOpen(port),
    settled: async () => {
      await tail;
    },
  };
}
