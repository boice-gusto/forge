import type { ObservedEvent } from "@forge/observability-memory";
import type { ApprovalPort, RunStorePort } from "@forge/ports";
import type { Runtime } from "@forge/runtime";

/**
 * What a control plane needs of a composition root.
 *
 * Both roots satisfy it — `createLocalStack` and `createDurableStack` — so
 * `apps/api` binds one stack at boot and never asks which kind it got. That is
 * the whole point of the type: before it existed the API built a *new stack per
 * request*, because the only thing it could name was the local one, and with
 * Postgres behind it that would have been a new connection pool and a new Redis
 * connection for every run started.
 */
export interface ControlPlaneStack {
  readonly runtime: Runtime;
  readonly approvals: ApprovalPort;
  /** The record of every run, which a Map of live runs is only a cache of. */
  readonly runs: RunStorePort;
  /**
   * The run telemetry **this process** recorded, oldest first.
   *
   * A method rather than a field, because it is not the whole history and must
   * not be mistaken for it: a stack whose sink only exports to a collector has
   * nothing to hand back, and a run that started in another process left its
   * events there. 012 §4.3's event stream is the answer to that; this is what
   * can honestly be served until one exists.
   */
  timeline(): readonly ObservedEvent[];
}
