/** Injected so runtime behaviour stays deterministic under test (006 §3). */
export interface ClockPort {
  now(): Date;
}

export interface IdPort {
  next(prefix: string): string;
}

export function createFixedClock(iso: string): ClockPort {
  const instant = new Date(iso);
  return { now: () => new Date(instant) };
}

export function createSequentialIds(): IdPort {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const value = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, value);
      return `${prefix}_${value}`;
    },
  };
}
