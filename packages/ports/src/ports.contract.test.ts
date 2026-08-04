import { describe, expect, test } from "vitest";

import { createApprovalProposal } from "./approval.js";
import { sandboxUnavailable } from "./sandbox.js";

describe("internal port contracts", () => {
  test("binds an approval to one exact effect", () => {
    const proposal = createApprovalProposal({
      approvalId: "approval_1",
      runId: "run_1",
      effectHash: "sha256:effect",
      expiresAt: "2026-08-02T00:00:00.000Z",
    });

    expect(proposal.effectHash).toBe("sha256:effect");
  });

  test("reports unavailable required sandbox without host fallback", () => {
    expect(sandboxUnavailable("docker").code).toBe("SANDBOX_UNAVAILABLE");
  });
});
