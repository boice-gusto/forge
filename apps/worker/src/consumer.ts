import type { ForgeJob, ObservabilityPort, QueuePort } from "@forge/ports";

/**
 * A worker must not hold a queue slot across human time (006 §2). Reaching a
 * gate does not block: the run is parked, this handler finishes, and the slot
 * is released. A decision later enqueues a separate `workflow.resume` job,
 * which may well arrive at a process that was not running when the run began.
 *
 * The consumer knows nothing about runtimes, stores or artifacts. It maps one
 * job to one host call and reports where it landed — everything about *how* a
 * run is rebuilt lives in the composition root.
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

export interface ConsumerOptions {
  readonly queue: QueuePort;
  readonly host: RunHost;
  readonly observability: ObservabilityPort;
}

export interface WorkerConsumer {
  /** Jobs handled, in order. */
  readonly handled: readonly ForgeJob[];
  start(): Promise<void>;
}

export function createWorkerConsumer(options: ConsumerOptions): WorkerConsumer {
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
  }
}
