/**
 * Transport and worker scheduling (006 §6.2, ADR-004). Not the workflow
 * engine: the queue moves work between processes and nothing more. A vendor
 * job object must never appear above this port.
 */
export type ForgeJob =
  | {
      readonly type: "workflow.execute";
      readonly runId: string;
      readonly workflowVersionId: string;
      readonly attempt: number;
    }
  | {
      readonly type: "workflow.resume";
      readonly runId: string;
      readonly approvalId: string;
      readonly attempt: number;
    }
  | { readonly type: "workflow.cancel"; readonly runId: string }
  /**
   * Tell the system a run was asked for from where the run got to (015 Phase
   * 8).
   *
   * A queue job rather than an inline call because a third-party API is the
   * one dependency here that is expected to be down: publishing inline means a
   * Slack outage loses the notification, and losing it is the difference
   * between an operator being told and an operator finding out.
   */
  | {
      readonly type: "connector.publish";
      readonly runId: string;
      readonly channel: string;
      readonly attempt: number;
    };

/** Stable per intended operation, so at-least-once delivery is safe. */
export function operationKey(job: ForgeJob): string {
  if (job.type === "workflow.cancel") return `cancel:${job.runId}`;
  if (job.type === "workflow.resume")
    return `resume:${job.runId}:${job.approvalId}`;
  /**
   * The attempt is in the key deliberately. Every other job here is
   * deduplicated so a redelivery cannot act twice; a *retry* is the one case
   * where acting again is the whole point, and a key without the attempt would
   * make the second attempt look like a repeat of the first and be dropped.
   */
  if (job.type === "connector.publish")
    return `publish:${job.runId}:${job.channel}:${job.attempt}`;
  return `execute:${job.runId}:${job.attempt}`;
}

export interface EnqueueOptions {
  /**
   * Hold the job back for this long before any subscriber may take it.
   *
   * Backpressure, expressed at the port because it is the transport's job to
   * hold work rather than a caller's to sleep. A retry re-enqueued with no
   * delay is a spin: the third party that just refused is refusing still, and
   * a tight loop against it is worse than the outage.
   */
  readonly delayMs?: number;
}

export interface QueuePort {
  enqueue(job: ForgeJob, options?: EnqueueOptions): Promise<string>;
  /** Delivers each distinct operation at most once to the handler. */
  subscribe(handler: (job: ForgeJob) => Promise<void>): Promise<void>;
  /** Work waiting for a subscriber. Work already handled is not waiting. */
  depth(): Promise<number>;
  health(): Promise<{ readonly available: boolean }>;
  /**
   * Releases the transport. A queue with a live connection keeps a process
   * alive after its work is done, so shutting one down has to be expressible
   * at the port rather than only on the adapter that happens to need it.
   */
  close(): Promise<void>;
}
