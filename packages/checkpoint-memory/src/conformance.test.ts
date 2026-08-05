import { describeCheckpointStoreConformance } from "@forge/store-conformance";

import { createMemoryCheckpointStore } from "./store.js";

/**
 * The memory store answers the same contract as the Postgres one. Running the
 * shared suite here is what makes "behaviourally indistinguishable" a measured
 * claim rather than an intention — the two adapters cannot drift apart without
 * one of them failing.
 */
describeCheckpointStoreConformance({
  name: "checkpoint-memory",
  async create() {
    const store = createMemoryCheckpointStore();
    // A memory store *is* its own peer: the same object is the second handle,
    // which is exactly the durability the port promises at this tier.
    return { store, peer: async () => store };
  },
});
