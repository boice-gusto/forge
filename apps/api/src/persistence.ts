/**
 * Which composition root this deployment serves runs from.
 *
 * A whole function for one comparison, because the comparison is the one that
 * decides whether a run outlives the process that started it, and a typo in it
 * fails *open*: a host that meant to be durable and silently was not would look
 * perfectly healthy right up until a restart emptied the run list.
 *
 * So an unrecognised value is refused rather than defaulted. `postgres` selects
 * the durable root; absent, or the explicit `memory`, keeps the in-memory one,
 * which is what a contributor with no container runtime gets.
 */
export type Persistence = "memory" | "postgres";

export function persistenceFrom(value: string | undefined): Persistence {
  if (value === undefined || value === "") return "memory";
  if (value === "memory" || value === "postgres") return value;
  throw new Error(
    `FORGE_PERSISTENCE must be "memory" or "postgres"; got "${value}". ` +
      "It is not defaulted, because a deployment that meant to be durable and " +
      "silently was not would look healthy until a restart emptied the run list.",
  );
}
