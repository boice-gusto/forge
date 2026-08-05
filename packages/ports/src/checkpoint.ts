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

export interface CheckpointStorePort {
  save(input: CheckpointInput): Promise<CheckpointRecord>;
  load(checkpointId: string): Promise<CheckpointRecord | undefined>;
  listByRun(runId: string): Promise<readonly CheckpointRecord[]>;
}
