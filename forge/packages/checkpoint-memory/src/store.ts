export interface CheckpointInput {
  readonly runId: string;
  readonly stepId: string;
  readonly stateVersion: number;
  readonly resumeToken: string;
}

export interface CheckpointRecord extends CheckpointInput {
  readonly checkpointId: string;
}

export interface MemoryCheckpointStore {
  save(input: CheckpointInput): Promise<CheckpointRecord>;
  load(checkpointId: string): Promise<CheckpointRecord | undefined>;
  listByRun(runId: string): Promise<readonly CheckpointRecord[]>;
}

export function createMemoryCheckpointStore(): MemoryCheckpointStore {
  const records = new Map<string, CheckpointRecord>();
  let nextCheckpoint = 1;

  return {
    async save(input) {
      const checkpoint = {
        ...input,
        checkpointId: `checkpoint_${nextCheckpoint}`,
      };
      nextCheckpoint += 1;
      records.set(checkpoint.checkpointId, checkpoint);
      return checkpoint;
    },
    async load(checkpointId) {
      return records.get(checkpointId);
    },
    async listByRun(runId) {
      return [...records.values()].filter((record) => record.runId === runId);
    },
  };
}
