import type { RunEventStorePort } from "@forge/observability";
import type {
  ApprovalPort,
  ObservabilityPort,
  QueuePort,
  RunStorePort,
} from "@forge/ports";
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
   * A run's timeline, durable and queryable, for a run this process may never
   * have started, which a per-process recorder could never answer.
   */
  readonly runEvents: RunEventStorePort;
  /**
   * Where a created run's `workflow.execute` job goes, and where the consumer
   * that walks it reads from. On the stack rather than on one root, because
   * `POST /v1/runs` persists and enqueues (006 §10.1) and must do exactly that
   * whichever root it was handed — a route whose semantics depend on the
   * deployment's persistence is a route nobody can write a client against.
   */
  readonly queue: QueuePort;
  /** Where the consumer reports the jobs it handled. */
  readonly observability: ObservabilityPort;
}
