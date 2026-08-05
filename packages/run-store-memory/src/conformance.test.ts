import { describeRunStoreConformance } from "@forge/store-conformance";

import { createMemoryRunStore } from "./store.js";

/**
 * The same contract the Postgres store answers. Running the shared suite here
 * makes "behaviourally indistinguishable" a measured claim rather than an
 * intention — neither adapter can drift without one of them failing.
 */
describeRunStoreConformance({
  name: "run-store-memory",
  async create() {
    const store = createMemoryRunStore();
    return { store, peer: async () => store };
  },
});
