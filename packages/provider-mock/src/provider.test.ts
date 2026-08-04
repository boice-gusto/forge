import { describe, expect, test } from "vitest";

import { createMockProvider } from "./provider.js";

describe("mock provider", () => {
  test("normalizes scripted events and resumes a durable session", async () => {
    const provider = createMockProvider({
      providerId: "mock",
      events: [
        { type: "text-delta", text: "researching" },
        { type: "completed" },
      ],
    });
    const session = await provider.createSession({
      workspacePath: "/workspace",
      correlationId: "trace_123",
      capabilities: ["streaming"],
    });

    const events = [];
    for await (const event of provider.execute(session, {
      prompt: "Research the ticket.",
    })) {
      events.push(event);
    }
    const resumed = await provider.resumeSession({
      sessionId: session.sessionId,
    });

    expect(events).toEqual([
      { type: "text-delta", text: "researching" },
      { type: "completed" },
    ]);
    expect(resumed.sessionId).toBe(session.sessionId);
  });
});
