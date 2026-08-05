import { defineWorkflow } from "@forge/manifest";

/**
 * Acme marketing — brief approval.
 *
 * A generic company workflow: draft copy, then publish externally behind a
 * human gate. No Acme-specific machinery, and no Forge internals — the one
 * import is the public authoring surface, which resolves this workflow's own
 * references as it is written: an edge to a node that does not exist, a gate
 * naming a node that does not exist, an undeclared effect, or an unknown role
 * is a type error here rather than a diagnostic after a compile.
 */
export const briefApproval = defineWorkflow({
  id: "acme.marketing.brief-approval",
  version: "1.0.0",
  sideEffects: ["slack.post"],
  grantedCapabilities: ["repo.read", "docs.write", "slack.write"],
  roles: {
    "marketing-writer": {
      version: "1.0.0",
      capabilities: { requires: ["docs.write"], forbids: ["repo.merge"] },
      review: { weight: 1, blocking: false },
    },
  },
  nodes: [
    { id: "intake", kind: "input", schemaRef: "acme.brief@1" },
    { id: "assert-write", kind: "policy_check", capability: "docs.write" },
    {
      id: "draft",
      kind: "agent",
      promptRef: "acme.marketing.draft@1",
      role: "marketing-writer",
    },
    // The gate names the node it authorises. An approval that named the
    // workflow instead would authorise whatever the workflow later grew.
    {
      id: "gate",
      kind: "approval",
      gateSchemaRef: "acme.publish@1",
      gates: ["publish"],
    },
    {
      id: "publish",
      kind: "tool",
      skillRef: "acme.slack-post@1",
      effect: "slack.post",
    },
    { id: "result", kind: "output", schemaRef: "acme.brief-result@1" },
  ],
  edges: [
    { from: "intake", to: "assert-write" },
    { from: "assert-write", to: "draft" },
    { from: "draft", to: "gate" },
    { from: "gate", to: "publish" },
    { from: "publish", to: "result" },
  ],
});
