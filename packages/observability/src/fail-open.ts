import type { ObservabilityPort, Span } from "@forge/ports";

const NOOP_SPAN: Span = { end: () => undefined };

/**
 * Telemetry is a report, never a dependency (011 §2): alone among the ports it
 * fails **open**, because a throwing or unreachable sink must not fail a run
 * that would otherwise have succeeded, nor abort one midway and leave a gate
 * open.
 *
 * This lives beside redaction rather than inside one adapter so that every
 * `ObservabilityPort` carries the guarantee itself. A wrapper applied only by
 * the caller protects the callers that remembered; a run started from a test,
 * a CLI, or a company harness that binds the port directly gets nothing.
 */
export function failOpen(port: ObservabilityPort): ObservabilityPort {
  return {
    startSpan(name, attributes, parent) {
      try {
        const span = port.startSpan(name, attributes, parent);
        return {
          end(endAttributes) {
            try {
              span.end(endAttributes);
            } catch {}
          },
          // The wrapper is a different object from the span the adapter made,
          // so a child parented on it would find nothing unless the handle
          // travels with it. Both forms travel: the in-process handle, and the
          // portable one that is all a resuming process will have.
          ...(span.context === undefined ? {} : { context: span.context }),
          ...(span.traceparent === undefined
            ? {}
            : { traceparent: span.traceparent }),
        };
      } catch {
        return NOOP_SPAN;
      }
    },
    event(name, attributes, parent) {
      try {
        port.event(name, attributes, parent);
      } catch {}
    },
  };
}
