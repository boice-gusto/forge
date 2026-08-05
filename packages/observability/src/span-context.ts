import type { Span, SpanContext } from "@forge/ports";

export interface SpanContexts<T> {
  /** A handle the caller can pass back as `parent`. */
  issue(value: T): SpanContext;
  /** What `parent` points at, or nothing if this adapter did not issue it. */
  resolve(parent?: Span): T | undefined;
}

/**
 * Parent handles, issued and resolved by one adapter.
 *
 * The handle is an empty token, not the adapter's own span object: `failOpen`
 * necessarily returns a different `Span`, so identity on the span cannot
 * survive, but the token it copies across can. Resolution is a lookup in a
 * `WeakMap`, which makes the two ways a parent can be wrong both harmless —
 * a handle from another adapter is simply absent, and a `context` that throws
 * when read is caught. Either way the span becomes a root, and telemetry that
 * cannot parent still records.
 */
export function createSpanContexts<T>(): SpanContexts<T> {
  const issued = new WeakMap<SpanContext, T>();
  return {
    issue(value) {
      const token: SpanContext = {};
      issued.set(token, value);
      return token;
    },
    resolve(parent) {
      try {
        const token = parent?.context;
        return token === undefined ? undefined : issued.get(token);
      } catch {
        return undefined;
      }
    },
  };
}
