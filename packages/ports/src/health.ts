/**
 * How a deployment describes one of its dependencies to a probe.
 *
 * Three packages declared this independently — `apps/api`, `apps/worker` and
 * the browser status panel — with the same three values under two different
 * type names. Nothing had drifted yet, and nothing would have caught it: a
 * fourth value added in one place is a status the other two silently cannot
 * represent, and a readiness probe that disagrees with the page showing it is
 * how an outage gets argued about rather than fixed.
 *
 * Here rather than under `apps/` because there is no sane edge between three
 * sibling applications, and because a browser bundle can import it: this
 * package has no dependencies and no `node:` imports, and a type-only import
 * erases at build.
 */
export type DependencyStatus = "healthy" | "degraded" | "unavailable";
