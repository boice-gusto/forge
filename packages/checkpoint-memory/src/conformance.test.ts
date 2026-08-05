import { describeCheckpointStoreConformance } from "@forge/store-conformance";

import { createMemoryCheckpointStore } from "./store.js";

/**
 * The same contract the Postgres store answers. Running the shared suite here
 * makes "behaviourally indistinguishable" a measured claim rather than an
 * intention — neither adapter can drift without one of them failing.
 */
describeCheckpointStoreConformance({
  name: "checkpoint-memory",
  async create() {
    const store = createMemoryCheckpointStore();
    return { store, peer: async () => store };
  },
});
