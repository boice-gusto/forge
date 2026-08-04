import { describe, expect, test } from "vitest";

import { createMemoryCheckpointStore } from "./store.js";

describe("memory checkpoint store", () => {
  test("persists versioned checkpoint metadata by run", async () => {
    const store = createMemoryCheckpointStore();
    const checkpoint = await store.save({
      runId: "run_123",
      stepId: "approval",
      stateVersion: 1,
      resumeToken: "resume_123",
    });

    expect(await store.load(checkpoint.checkpointId)).toEqual(checkpoint);
    expect(await store.listByRun("run_123")).toEqual([checkpoint]);
  });
});
