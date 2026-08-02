import { describe, expect, test } from "vitest";

import { createForgeLogger } from "./logger.js";

describe("createForgeLogger", () => {
  test("binds Forge correlation identity and redacts logged fields", () => {
    const entries: unknown[] = [];
    const logger = createForgeLogger(
      { workflowId: "wf_123", traceId: "trace_123" },
      (entry) => entries.push(entry),
    );

    logger.info({ apiKey: "do-not-log", step: "research" }, "step started");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      workflowId: "wf_123",
      traceId: "trace_123",
      apiKey: "[REDACTED]",
      step: "research",
      msg: "step started",
    });
  });
});
