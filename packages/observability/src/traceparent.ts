import type { Traceparent } from "@forge/ports";

/**
 * W3C `traceparent`, parsed and formatted.
 *
 * Shared rather than reimplemented per adapter because the format is the one
 * thing two adapters must agree on exactly: a run created by a process using
 * one and resumed by a process using another still has to land in the same
 * trace. It is also the only part of tracing with a spec to be right or wrong
 * against, so it is worth testing once, here.
 *
 * https://www.w3.org/TR/trace-context/#traceparent-header
 */

/** `00-<32 hex>-<16 hex>-<2 hex>`, and nothing else. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** All-zero ids are explicitly invalid in the spec, not merely unlikely. */
const NULL_TRACE_ID = "0".repeat(32);
const NULL_SPAN_ID = "0".repeat(16);

export interface ParsedTraceparent {
  readonly traceId: string;
  readonly spanId: string;
  /** `01` when sampled. Carried verbatim so a resumed run samples alike. */
  readonly flags: string;
}

/**
 * The parse is strict on purpose. A traceparent arrives from a database column
 * written by another process and possibly another version, which is untrusted
 * input in the only sense that matters here: something malformed must produce
 * a root span, not a corrupt trace or a thrown error inside telemetry that
 * fails open.
 */
export function parseTraceparent(
  value: string | undefined,
): ParsedTraceparent | undefined {
  if (value === undefined) return undefined;
  const match = TRACEPARENT.exec(value);
  if (match === null) return undefined;
  const [, traceId, spanId, flags] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (traceId === NULL_TRACE_ID || spanId === NULL_SPAN_ID) return undefined;
  return { traceId, spanId, flags };
}

export function formatTraceparent(parsed: ParsedTraceparent): Traceparent {
  return `00-${parsed.traceId}-${parsed.spanId}-${parsed.flags}`;
}

/** `parent` in either form, reduced to the portable one. */
export function traceparentOf(
  parent: { readonly traceparent?: Traceparent } | Traceparent | undefined,
): Traceparent | undefined {
  if (parent === undefined) return undefined;
  return typeof parent === "string" ? parent : parent.traceparent;
}
