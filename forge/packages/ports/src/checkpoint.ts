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
}

export interface CheckpointRecord extends CheckpointInput {
  readonly checkpointId: string;
}

export interface CheckpointStorePort {
  save(input: CheckpointInput): Promise<CheckpointRecord>;
  load(checkpointId: string): Promise<CheckpointRecord | undefined>;
  listByRun(runId: string): Promise<readonly CheckpointRecord[]>;
}
