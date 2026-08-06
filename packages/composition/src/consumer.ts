import type { ProgressAnnouncer } from "@forge/intake";
import type {
  ForgeJob,
  ObservabilityPort,
  QueuePort,
  RunStorePort,
} from "@forge/ports";
import type { Runtime } from "@forge/runtime";

/**
 * The queue consumer, shared by every process that runs one.
 *
 * A worker must not hold a queue slot across human time (006 §2). Reaching a
 * gate does not block: the run is parked, this handler finishes, and the slot
 * is released. A decision later enqueues a separate `workflow.resume` job,
 * which may well arrive at a process that was not running when the run began.
 *
 * It lives here rather than in `apps/worker` because it is no longer only the
 * worker's. `POST /v1/runs` now persists and enqueues, so the control plane
 * runs one too — and a second copy of this mapping is a second answer to "what
 * does a `workflow.execute` job mean", which is exactly the kind of thing that
 * drifts once and is discovered in production.
 *
 * The consumer itself knows nothing about runtimes, stores or artifacts. It
 * maps one job to one host call and reports where it landed.
 */

export interface RunHost {
  /** Starts a run the control plane created. Returns its status. */
  execute(
    runId: string,
    workflowVersionId: string,
    attempt: number,
  ): Promise<string>;
  /**
   * Drives a run whose gate has been decided. The decision is already durable;
   * this only moves the resume off the request that made it.
   */
  resume(runId: string, approvalId: string): Promise<string>;
  cancel(runId: string): Promise<void>;
}

/**
 * A runtime, as the consumer sees it.
 *
 * All three verbs land on the same rehydration path: a run's state lives in
 * the store, so a job for a run this process never started is ordinary work
 * rather than a special case. `execute` and `resume` are the same call because
 * they are the same question — "continue this run from wherever it is" — and
 * `resume` answers it for a `PENDING` run by starting the walk.
 */
export function runtimeHost(runtime: Runtime): RunHost {
  return {
    async execute(runId) {
      return (await runtime.resume(runId))?.status ?? "UNKNOWN";
    },
    async resume(runId) {
      return (await runtime.resume(runId))?.status ?? "UNKNOWN";
    },
    async cancel(runId) {
      await runtime.cancel(runId);
    },
  };
}

export interface RunConsumerOptions {
  readonly queue: QueuePort;
  readonly host: RunHost;
  readonly observability: ObservabilityPort;
  /**
   * Telling the system a request came from where its run got to (015 Phase 8).
   *
   * Absent by default. A deployment with no connectors has nobody to tell, and
   * a run started at the API already has its answer in the response.
   *
   * Read from the store rather than from what the walk returned, deliberately:
   * the store is the record, and an announcement describing a process's belief
   * rather than the persisted state is a notification that can disagree with
   * `GET /v1/runs`. It also carries the origin, which the walk never sees.
   */
  readonly progress?: {
    readonly announcer: ProgressAnnouncer;
    readonly runs: RunStorePort;
    /** Turns a run id into somewhere a human can look, behind Forge's auth. */
    readonly runUrl: (runId: string) => string;
  };
}

export interface RunConsumer {
  /** Jobs handled, in order. */
  readonly handled: readonly ForgeJob[];
  start(): Promise<void>;
}

export function createRunConsumer(options: RunConsumerOptions): RunConsumer {
  const handled: ForgeJob[] = [];

  return {
    handled,
    async start() {
      await options.queue.subscribe(async (job) => {
        handled.push(job);
        options.observability.event("forge.worker.job", {
          type: job.type,
          runId: job.runId,
        });

        // One unservicable job must not stop the consumer processing others.
        try {
          await handle(job);
        } catch (error) {
          options.observability.event("forge.worker.job_failed", {
            type: job.type,
            runId: job.runId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  };

  /**
   * Announced after the work, never before, and never in its place.
   *
   * Failures are the announcer's to swallow — it fails open and is bounded, so
   * a Slack outage cannot fail a job that has already dispatched an effect a
   * human approved. What is enforced *here* is the ordering: a notification
   * that went out before the state was durable would be a promise the system
   * has not yet made.
   */
  async function announce(runId: string): Promise<void> {
    const progress = options.progress;
    if (progress === undefined) return;

    const persisted = await progress.runs.load(runId);
    const record = persisted?.record;
    // A run with no origin came from the API, which already has its answer.
    if (record?.origin === undefined) return;

    await progress.announcer.announce({
      origin: { ...record.origin, receivedAt: "" },
      runId: record.runId,
      status: record.status,
      ...(record.pendingApprovalId === undefined
        ? {}
        : { pendingApprovalId: record.pendingApprovalId }),
      runUrl: progress.runUrl(record.runId),
    });
  }

  async function handle(job: ForgeJob): Promise<void> {
    if (job.type === "workflow.cancel") {
      await options.host.cancel(job.runId);
      options.observability.event("forge.worker.cancelled", {
        runId: job.runId,
      });
      return;
    }

    if (job.type === "workflow.resume") {
      const status = await options.host.resume(job.runId, job.approvalId);
      options.observability.event("forge.worker.resumed", {
        runId: job.runId,
        approvalId: job.approvalId,
        status,
      });
      await announce(job.runId);
      return;
    }

    const status = await options.host.execute(
      job.runId,
      job.workflowVersionId,
      job.attempt,
    );
    options.observability.event("forge.worker.executed", {
      runId: job.runId,
      status,
      // Proof the slot is not held across a gate.
      parked: status === "AWAITING_APPROVAL",
    });
    await announce(job.runId);
  }
}
