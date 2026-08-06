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

/**
 * The `type` discriminants, for the places that handle one as a string rather
 * than as a `ForgeJob`.
 *
 * {@link ForgeJob} stays the contract and is not derived from this — the union
 * carries each job's payload and the compiler already checks it at every site
 * that builds or narrows one. What this is for is the sites where the type has
 * been separated from its payload and the compiler has nothing to check: a
 * transport's wire schema listing the discriminants it accepts, an observability
 * attribute, a dead-letter dashboard's filter. A job type added to the union and
 * missed in one of those is a job that enqueues cleanly and is refused on
 * arrival, with nothing to fail at build time: `connector.publish` is in the
 * union and absent from `@forge/queue-bullmq`'s wire schema today.
 */
export type ForgeJobType = ForgeJob["type"];

export const FORGE_JOB_TYPES = {
  execute: "workflow.execute",
  resume: "workflow.resume",
  cancel: "workflow.cancel",
  publish: "connector.publish",
} as const satisfies Record<string, ForgeJobType>;

/**
 * The failures a queue adapter raises, as codes rather than prose — for the
 * same reason as `RUN_STORE_ERRORS`: they are control flow across a package
 * boundary, carried as a message prefix because a queue failure crosses a
 * process boundary in a job's failure text as often as it crosses a call.
 */
export const QUEUE_ERRORS = {
  /**
   * A second `subscribe` on one transport. An adapter holds one consumer, and
   * that reference is what `close` releases and what `health` reads to answer
   * whether this process is still taking jobs. Replacing it would leave the
   * first consumer running, unclosable and invisible to the probe — so the
   * second call is refused rather than accepted.
   */
  alreadySubscribed: "FORGE_QUEUE_ALREADY_SUBSCRIBED",
  /**
   * A payload the transport does not recognise. Fails closed: coercing it into
   * the nearest job it resembles is how a cancel becomes an execute.
   */
  invalidJob: "FORGE_QUEUE_INVALID_JOB",
} as const;

export type QueueErrorCode = (typeof QUEUE_ERRORS)[keyof typeof QUEUE_ERRORS];

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
