import { describeQueueConformance } from "@forge/queue-conformance";

import { createMemoryQueue } from "./queue.js";

describeQueueConformance({
  name: "queue-memory",
  async create() {
    const queue = createMemoryQueue();
    return {
      queue,
      // A memory queue's state is the object it returned, so the second
      // "client" onto it is itself. The suite still learns something: the
      // idempotency ledger has to be shared, and here that is free.
      async peer() {
        return queue;
      },
    };
  },
});
