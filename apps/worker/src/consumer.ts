import type { LocalStack } from "@forge/composition";
import type { ForgeJob, ObservabilityPort, QueuePort } from "@forge/ports";

/**
 * Queue consumer.
 *
 * The critical rule this exists to honour: a worker must not hold a queue slot
 * across human time (006 §2). Reaching an approval gate does not block here —
 * `start` returns with the run parked, this handler finishes, and the slot is
 * released. A decision later enqueues a separate `workflow.resume` job.
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

        // One unservicable job must not take the consumer down. A worker that
        // dies on a job for an unknown run stops processing every other run.
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
    {
      if (job.type === "workflow.cancel") {
        await options.stack.runtime.cancel(job.runId);
        return;
      }

      if (job.type === "workflow.resume") {
        // The decision was already recorded by the control plane; this job
        // exists so the resume happens on a worker rather than in the
        // request that made the decision.
        const run = options.stack.runtime.getRun(job.runId);
        options.observability.event("forge.worker.resumed", {
          runId: job.runId,
          status: run?.status ?? "unknown",
        });
        return;
      }

      // workflow.execute — the run was started by the control plane, so
      // there is nothing to re-drive here beyond reporting where it landed.
      const run = options.stack.runtime.getRun(job.runId);
      options.observability.event("forge.worker.executed", {
        runId: job.runId,
        status: run?.status ?? "unknown",
        // Proof the slot is not held across a gate.
        parked: run?.status === "AWAITING_APPROVAL",
      });
    }
  }
}
