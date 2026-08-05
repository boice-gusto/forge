import { describeApprovalStoreConformance } from "@forge/store-conformance";

import { createMemoryApprovalStore } from "./store.js";

/**
 * The same contract the Postgres store answers. Single use, expiry, and
 * "an edit authorises nothing" have to mean the same thing at both tiers, or
 * swapping the adapter changes what an approval is.
 */
describeApprovalStoreConformance({
  name: "approval-memory",
  async create(clock, ids) {
    const store = createMemoryApprovalStore(clock, ids);
    return { store, peer: async () => store };
  },
});
