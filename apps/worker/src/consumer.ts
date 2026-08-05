import type { LocalStack } from "@forge/composition";
import type { ForgeJob, ObservabilityPort, QueuePort } from "@forge/ports";

/**
 * A worker must not hold a queue slot across human time (006 §2). Reaching a
 * gate does not block: the run is parked, this handler finishes, and the slot
 * is released. A decision later enqueues a separate `workflow.resume` job.
 */

export interface ConsumerOptions {
  readonly queue: QueuePort;
  readonly stack: LocalStack;
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
      await options.stack.runtime.cancel(job.runId);
      return;
    }

    if (job.type === "workflow.resume") {
      // The control plane already recorded the decision; this job only moves
      // the resume off the request that made it.
      const run = options.stack.runtime.getRun(job.runId);
      options.observability.event("forge.worker.resumed", {
        runId: job.runId,
        status: run?.status ?? "unknown",
      });
      return;
    }

    // workflow.execute — started by the control plane, so there is nothing to
    // re-drive beyond reporting where it landed.
    const run = options.stack.runtime.getRun(job.runId);
    options.observability.event("forge.worker.executed", {
      runId: job.runId,
      status: run?.status ?? "unknown",
      // Proof the slot is not held across a gate.
      parked: run?.status === "AWAITING_APPROVAL",
    });
  }
}
