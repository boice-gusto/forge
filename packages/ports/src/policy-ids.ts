/**
 * The `policyId` values a Forge policy adapter answers with when the decision
 * came from the evaluator itself rather than from a company's rule.
 *
 * A rule-driven decision carries the rule's own id; these three are the ones
 * no pack authored, so every adapter has to produce them itself. That is what
 * makes them a shared vocabulary rather than an implementation detail: an
 * operator reading a denial, and the panel grouping denials by cause, must get
 * the same id whichever adapter answered. Two adapters spelling one of these
 * differently is not a failure — it is a quiet split in the audit trail.
 *
 * Here rather than in an adapter because both adapters answer with these and
 * neither should depend on the other — the same reason `RUN_STORE_ERRORS`
 * sits beside `RunStorePort` rather than inside a store.
 *
 * There is a third copy, in `@forge/policy-opa`'s `policy/forge.rego`, that no
 * compiler can reach. `policy-ids.test.ts` in that package is what checks it.
 */
export const FORGE_POLICY_IDS = {
  /** No rule matched. The default, not a fallback the others declined into. */
  defaultDeny: "forge.policy.default-deny",
  /** A capability the host closure never granted. No rule can widen this. */
  capabilityClosure: "forge.policy.capability-closure",
  /**
   * The evaluator failed. Not produced by the Rego — it is what the adapter
   * answers when the module could not be asked, or answered unintelligibly.
   */
  evaluatorError: "forge.policy.evaluator-error",
  /**
   * A gate reopened to redrive an action nobody can account for. Not a
   * denial: it is the id on an approval the runtime synthesises, so an audit
   * can tell a redrive's gate from the one the run opened first.
   */
  redrive: "forge.policy.redrive",
} as const;

export type ForgePolicyId =
  (typeof FORGE_POLICY_IDS)[keyof typeof FORGE_POLICY_IDS];
