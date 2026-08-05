import type { RunEventStorePort } from "@forge/observability";

/**
 * `peer()` is what makes durability testable, exactly as it is in
 * `@forge/store-conformance`: it stands for the second API process, or the same
 * process after a restart. A memory adapter's state *is* the object it
 * returned, so it hands back the same store; a Postgres adapter opens a second
 * pool onto the same database. Without it the suite cannot tell a durable
 * record from one that only ever lived in an array.
 */
export interface EventStoreHandle {
  readonly store: RunEventStorePort;
  peer(): Promise<RunEventStorePort>;
}

export interface EventStoreConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  /** An empty store, isolated from every other one this harness hands out. */
  create(): Promise<EventStoreHandle>;
}

export const CONFORMANCE_RUN_ID = "run_conformance";

/** A second run, so "one run's events" is a claim with something to exclude. */
export const OTHER_RUN_ID = "run_other";

/**
 * One instant, shared by every record the ordering tests write.
 *
 * The point of the suite: a store that ordered by this would tie on every row,
 * and a tie is a record that swaps place between two reads.
 */
export const CONFORMANCE_AT = "2026-08-04T00:00:00.000Z";
