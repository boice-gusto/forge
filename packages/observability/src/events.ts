/**
 * Every span and event name Forge emits.
 *
 * These are **wire values**. A name goes to a tracing backend, to a durable run
 * event row, and to the operator timeline the UI builds by matching on it —
 * three consumers in three packages that agree by all spelling the same string.
 * Renaming one at the emitter compiles cleanly and keeps the run healthy; what
 * it does is empty a dashboard panel and drop a step out of every timeline
 * rendered from that point on, which is the kind of break nobody notices until
 * they need the timeline.
 *
 * This list lives in `@forge/observability` rather than in `@forge/ports`
 * because a name belongs to the thing that emits it, not to the port that
 * carries it. `ObservabilityPort` takes `name: string` on purpose and keeps
 * doing so: an adapter has to stay able to carry a name from a company
 * extension, and narrowing the port to this union would make the core's
 * vocabulary the only vocabulary.
 *
 * Every value here is already in the stores of running deployments. Changing
 * one is a migration of historical rows, not an edit.
 */
export const FORGE_EVENTS = {
  /**
   * The root span of a run, opened at creation. Its traceparent is persisted
   * on the record, which is what lets the worker that takes the job and the
   * process that resumes after a decision record underneath it rather than
   * each starting a trace of its own.
   */
  runStart: "forge.run.start",
  runTransition: "forge.run.transition",
  /** An attempt was spent. Not a transition: a retrying run stays RUNNING. */
  runRetry: "forge.run.retry",
  runFailed: "forge.run.failed",
  runSucceeded: "forge.run.succeeded",
  /** A parked run was picked back up, possibly by a process that never saw it park. */
  runResumed: "forge.run.resumed",
  /** This process lost a race for the run and left it to whoever won. */
  runCeded: "forge.run.ceded",

  nodeAgent: "forge.node.agent",
  nodeJudge: "forge.node.judge",
  /** The arm a branch took, pinned. */
  nodeBranch: "forge.node.branch",
  /**
   * Covers both a lease taken and a lease refused; the `available` attribute
   * says which. One name because the question an operator asks is "did this
   * node get its isolation", and splitting it into two would mean querying for
   * the absence of one event to answer it.
   */
  nodeSandbox: "forge.node.sandbox",

  approvalRequested: "forge.approval.requested",
  approvalDecided: "forge.approval.decided",
  /** An amended action, which names the successor gate that authorises it. */
  approvalEdited: "forge.approval.edited",
  /** A deadline that passed. An expired gate is not a slow yes (006 §9). */
  approvalExpired: "forge.approval.expired",

  policyDecide: "forge.policy.decide",

  effectDispatched: "forge.effect.dispatched",
  /**
   * A gate opened over an action that was claimed and never seen to settle —
   * the question being decided is "did it already happen, and is doing it
   * again acceptable", which no policy rule answers.
   */
  effectRedriveRequested: "forge.effect.redrive-requested",
  /** A redrive a human authorised, carried out. */
  effectRedriven: "forge.effect.redriven",

  /** A job was taken off the queue, before anything was done with it. */
  workerJob: "forge.worker.job",
  /** The handler threw. The consumer stays subscribed; one bad job is not an outage. */
  workerJobFailed: "forge.worker.job_failed",
  workerExecuted: "forge.worker.executed",
  workerResumed: "forge.worker.resumed",
  workerCancelled: "forge.worker.cancelled",

  /** A delivery failed and was re-enqueued with backoff. */
  connectorPublishDeferred: "forge.connector.publish_deferred",
  /**
   * A delivery given up on after its attempts ran out, said out loud. A
   * notification abandoned in silence is discovered by somebody asking why
   * they were never told.
   */
  connectorPublishAbandoned: "forge.connector.publish_abandoned",
} as const;

export type ForgeEventName = (typeof FORGE_EVENTS)[keyof typeof FORGE_EVENTS];
