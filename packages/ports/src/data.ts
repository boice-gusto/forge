/**
 * The run data plane (006 §8, 007 §3).
 *
 * A value a node produces is JSON, and nothing else. Not because JSON is
 * pleasant, but because a checkpoint has to be able to hold it: a run that
 * parks at a gate for a day and resumes in another process must resume on the
 * same values it parked on. A `Date`, a `Map` or a class instance does not
 * survive that trip, so it is refused at the point it is produced rather than
 * discovered missing on resume.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A read-only view of the values a run has produced so far, handed to the
 * engine the same way `AuthorisedEffects` is: the runtime owns the ledger, the
 * engine only consults it.
 *
 * `read` **throws** when the value is not there. A node that cannot see what it
 * was told to read stops the run; substituting a default would mean an effect
 * dispatched on data nobody supplied.
 */
export interface RunValues {
  /** The value at `path` inside `nodeId`'s output. Throws if it is absent. */
  read(nodeId: string, path: readonly string[]): JsonValue;
}
