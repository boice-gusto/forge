import type { JsonValue } from "./data.js";

/**
 * Forge-level checkpoint metadata (006 §6.3). Engine state blobs stay inside
 * the engine adapter; this port carries only what the runtime and the control
 * plane need to reason about progress and resumption.
 */
export interface CheckpointInput {
  readonly runId: string;
  readonly stepId: string;
  readonly stateVersion: number;
  /** Opaque to the runtime; binds a resume to one exact action. */
  readonly resumeToken: string;
  /**
   * The values the run's nodes had produced when it parked, keyed by node id.
   * A gate can stay open for days: resuming on freshly computed values would
   * dispatch an action nobody approved, so the data is checkpointed with the
   * position. JSON only — this record has to survive a durable store.
   */
  readonly values?: Readonly<Record<string, JsonValue>>;
}

export interface CheckpointRecord extends CheckpointInput {
  readonly checkpointId: string;
}

/**
 * The failures a checkpoint store raises, as codes rather than prose — control
 * flow across a package boundary, in the same form as `RUN_STORE_ERRORS` and
 * for the same reason.
 */
export const CHECKPOINT_ERRORS = {
  /**
   * `save` wrote no row. Returning a record the store does not hold would hand
   * back a `checkpointId` that resumes nothing, and the position it was meant
   * to pin is lost at the moment the process that knew it exits.
   */
  notWritten: "FORGE_CHECKPOINT_NOT_WRITTEN",
} as const;

export type CheckpointErrorCode =
  (typeof CHECKPOINT_ERRORS)[keyof typeof CHECKPOINT_ERRORS];

export interface CheckpointStorePort {
  save(input: CheckpointInput): Promise<CheckpointRecord>;
  load(checkpointId: string): Promise<CheckpointRecord | undefined>;
  listByRun(runId: string): Promise<readonly CheckpointRecord[]>;
}
