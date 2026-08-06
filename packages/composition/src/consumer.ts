import type { ProgressAnnouncer } from "@forge/intake";
import { FORGE_EVENTS } from "@forge/observability";
import {
  FORGE_JOB_TYPES,
  type ForgeJob,
  type ObservabilityPort,
  type QueuePort,
  type RunStatus,
  type RunStorePort,
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

/**
 * What a host can report about a job it was handed.
 *
 * A run's status, or `UNKNOWN` — which is not a status and never appears on a
 * record: it means the job named a run the store has never heard of. That
 * answer was previously smuggled through a bare `string` return, where it
 * looked exactly like a lifecycle state and nothing could tell them apart.
 * Naming it is the difference between "this run failed" and "there is no such
 * run", which are very different pages for somebody to be woken up by.
 */
export type HostOutcome = RunStatus | "UNKNOWN";

export interface RunHost {
  /** Starts a run the control plane created. Returns its status. */
  execute(
    runId: string,
    workflowVersionId: string,
    attempt: number,
  ): Promise<HostOutcome>;
  /**
   * Drives a run whose gate has been decided. The decision is already durable;
   * this only moves the resume off the request that made it.
   */
  resume(runId: string, approvalId: string): Promise<HostOutcome>;
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

  /**
   * How many times a notification is worth trying, and how long between.
   *
   * Exponential from a second, so a brief blip is invisible and a real outage
   * backs off to minutes rather than hammering a service that is already
   * struggling. Six attempts is a little over an hour: long enough to cover an
   * incident, short enough that a queue does not fill with news nobody wants
   * any more.
   *
   * Declared *above* the `return`, and that placement is load-bearing. The
   * handlers below are function declarations, so they hoist and run later; a
   * `const` written after the `return` is never initialised at all, and every
   * publish job died on the temporal dead zone. The retry tests caught it and
   * nothing else would have — the happy path never reads these.
   */
  const MAX_PUBLISH_ATTEMPTS = 6;
  const backoffMs = (attempt: number): number => 1_000 * 2 ** (attempt - 1);

  return {
    handled,
    async start() {
      await options.queue.subscribe(async (job) => {
        handled.push(job);
        options.observability.event(FORGE_EVENTS.workerJob, {
          type: job.type,
          runId: job.runId,
        });

        // One unservicable job must not stop the consumer processing others.
        try {
          await handle(job);
        } catch (error) {
          options.observability.event(FORGE_EVENTS.workerJobFailed, {
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

    /**
     * Enqueued rather than published here.
     *
     * A third-party API is the one dependency in this system that is expected
     * to be down, and publishing inline means a Slack outage loses the
     * notification outright. Putting it on the queue makes it work like every
     * other piece of work: durable, retried, and visible in the depth an
     * operator reads.
     *
     * It also keeps the walk's slot free. Waiting on Slack inside a job that
     * has just finished a run is holding a worker for somebody else's latency.
     */
    await options.queue.enqueue({
      type: FORGE_JOB_TYPES.publish,
      runId: record.runId,
      channel: record.origin.channel,
      attempt: 1,
    });
  }

  async function publish(
    runId: string,
    channel: string,
    attempt: number,
  ): Promise<void> {
    const progress = options.progress;
    if (progress === undefined) return;

    const persisted = await progress.runs.load(runId);
    const record = persisted?.record;
    if (record?.origin === undefined) return;

    /**
     * Read again, at the moment of publishing rather than when the job was
     * made. A retry an hour later should say where the run is *now* — a
     * notification that arrives late saying "awaiting approval" about a run
     * that was approved and finished is worse than one that never arrives.
     */
    const delivered = await progress.announcer.announce({
      origin: { ...record.origin, receivedAt: "" },
      runId: record.runId,
      status: record.status,
      ...(record.pendingApprovalId === undefined
        ? {}
        : { pendingApprovalId: record.pendingApprovalId }),
      runUrl: progress.runUrl(record.runId),
    });
    if (delivered) return;

    if (attempt >= MAX_PUBLISH_ATTEMPTS) {
      /**
       * Given up on, and said so. A notification quietly abandoned after an
       * hour of failures is the kind of thing nobody discovers until somebody
       * asks why they were never told.
       */
      options.observability.event(FORGE_EVENTS.connectorPublishAbandoned, {
        runId,
        channel,
        attempt,
      });
      return;
    }

    options.observability.event(FORGE_EVENTS.connectorPublishDeferred, {
      runId,
      channel,
      attempt,
    });
    await options.queue.enqueue(
      { type: FORGE_JOB_TYPES.publish, runId, channel, attempt: attempt + 1 },
      { delayMs: backoffMs(attempt) },
    );
  }

  async function handle(job: ForgeJob): Promise<void> {
    if (job.type === "workflow.cancel") {
      await options.host.cancel(job.runId);
      options.observability.event(FORGE_EVENTS.workerCancelled, {
        runId: job.runId,
      });
      return;
    }

    if (job.type === "connector.publish") {
      await publish(job.runId, job.channel, job.attempt);
      return;
    }

    if (job.type === "workflow.resume") {
      const status = await options.host.resume(job.runId, job.approvalId);
      options.observability.event(FORGE_EVENTS.workerResumed, {
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
    options.observability.event(FORGE_EVENTS.workerExecuted, {
      runId: job.runId,
      status,
      // Proof the slot is not held across a gate.
      parked: status === "AWAITING_APPROVAL",
    });
    await announce(job.runId);
  }
}
