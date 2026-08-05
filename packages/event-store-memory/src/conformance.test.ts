import { describeRunEventStoreConformance } from "@forge/event-store-conformance";

import { createMemoryRunEventStore } from "./store.js";

describeRunEventStoreConformance({
  name: "@forge/event-store-memory",
  async create() {
    const store = createMemoryRunEventStore();
    return {
      store,
      // A Map's state *is* the object it returned, so the second reader is the
      // same store. That is the honest limit of this adapter, and the reason
      // `@forge/event-store-postgres` runs the same suite.
      async peer() {
        return store;
      },
    };
  },
});
