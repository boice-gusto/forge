import { describeIntakeLedgerConformance } from "./ledger-conformance.js";
import { createMemoryIntakeLedger } from "./ledger-memory.js";

describeIntakeLedgerConformance({
  name: "intake-memory",
  // A Set in one process. Two control planes each hold their own, so each
  // accepts the same delivery once — which is twice. The cross-process tests
  // are skipped rather than passed, because this cannot make that claim.
  sharedAcrossProcesses: false,
  async create() {
    const ledger = createMemoryIntakeLedger();
    return { ledger, peer: async () => ledger };
  },
});
