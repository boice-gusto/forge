import type { ForgeJob, QueuePort } from "@forge/ports";

/**
 * `peer()` is what makes the queue contract testable across processes, exactly
 * as `StoreHandle.peer()` does for the durable stores. A memory queue's state
 * *is* the object it returned, so it hands back itself; a Redis-backed queue
 * opens a second client onto the same Redis. Without it the suite cannot tell
 * a queue two workers share from one that only ever lived in an array.
 */
export interface QueueHandle {
  readonly queue: QueuePort;
  peer(): Promise<QueuePort>;
}

export interface QueueConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  /** An empty queue, isolated from every other one this harness hands out. */
  create(): Promise<QueueHandle>;
}

/** Narrowed rather than widened to `ForgeJob`, so a test may vary one field. */
export const CONFORMANCE_EXECUTE: Extract<
  ForgeJob,
  { type: "workflow.execute" }
> = {
  type: "workflow.execute",
  runId: "run_1",
  workflowVersionId: "wf@1.0.0",
  attempt: 1,
};

export const CONFORMANCE_RESUME: Extract<
  ForgeJob,
  { type: "workflow.resume" }
> = {
  type: "workflow.resume",
  runId: "run_1",
  approvalId: "approval_1",
  attempt: 2,
};
