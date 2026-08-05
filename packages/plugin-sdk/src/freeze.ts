/**
 * `readonly` is a compile-time annotation. A plugin is ordinary JavaScript at
 * runtime and can cast it away, so anything handed across the plugin boundary
 * is frozen for real. The two escapes this closed are noted at their call
 * sites in `registry.ts` and `host.ts`.
 */

type Freezable = Record<string, unknown> | readonly unknown[];

function isFreezable(value: unknown): value is Freezable {
  return typeof value === "object" && value !== null;
}

/** Freeze a value and everything reachable from it. Cycles are tolerated. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!isFreezable(value) || seen.has(value)) return value;
  seen.add(value);

  for (const inner of Object.values(value)) deepFreeze(inner, seen);

  return Object.freeze(value) as T;
}
