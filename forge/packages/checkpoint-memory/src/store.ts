import type { CheckpointRecord, CheckpointStorePort } from "@forge/ports";

export function createMemoryCheckpointStore(): CheckpointStorePort {
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
