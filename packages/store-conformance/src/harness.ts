import type {
  ApprovalPort,
  ApprovalRequest,
  CheckpointInput,
  CheckpointStorePort,
  ClockPort,
  IdPort,
} from "@forge/ports";

/**
 * A store plus a second way in to the same state.
 *
 * `peer()` is the whole reason durability is testable: it is the second API
 * process, or the same process after a restart. An in-memory adapter's state
 * *is* the object it returned, so it hands back the same store; a Postgres
 * adapter opens a second pool onto the same database. Without it the suite
 * cannot tell a durable record from one that only ever lived in a Map.
 */
export interface StoreHandle<Port> {
  readonly store: Port;
  peer(): Promise<Port>;
}

export interface CheckpointConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  /** An empty store, isolated from every other one this harness hands out. */
  create(): Promise<StoreHandle<CheckpointStorePort>>;
}

export interface ApprovalConformanceHarness {
  readonly name: string;
  /**
   * Clock and ids are injected rather than taken from the adapter so the suite
   * can assert on exact timestamps and identifiers instead of on their shape.
   */
  create(clock: ClockPort, ids: IdPort): Promise<StoreHandle<ApprovalPort>>;
}

export const CONFORMANCE_NOW = "2026-08-04T00:00:00.000Z";

export const CONFORMANCE_APPROVAL: ApprovalRequest = {
  runId: "run_1",
  nodeId: "publish",
  effect: "slack.post",
  effectHash: "sha256:effect",
  policyId: "acme.publish.external",
  approvers: ["marketing-lead"],
  expiresAt: "2026-08-11T00:00:00.000Z",
};

export const CONFORMANCE_CHECKPOINT: CheckpointInput = {
  runId: "run_123",
  stepId: "approval",
  stateVersion: 1,
  resumeToken: "resume_123",
};
