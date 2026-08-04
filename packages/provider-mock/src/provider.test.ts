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

describe("mock provider lifecycle", () => {
  test("reports itself available with its own id", async () => {
    const provider = createMockProvider({ providerId: "mock", events: [] });
    expect(await provider.health()).toEqual({
      available: true,
      providerId: "mock",
    });
    expect(provider.providerId).toBe("mock");
  });

  test("each session gets a distinct id", async () => {
    const provider = createMockProvider({ providerId: "mock", events: [] });
    const first = await provider.createSession({
      workspacePath: "/w",
      correlationId: "c",
      capabilities: [],
    });
    const second = await provider.createSession({
      workspacePath: "/w",
      correlationId: "c",
      capabilities: [],
    });

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  test("cancel and destroy are safe to call", async () => {
    const provider = createMockProvider({ providerId: "mock", events: [] });
    const session = await provider.createSession({
      workspacePath: "/w",
      correlationId: "c",
      capabilities: [],
    });

    await expect(provider.cancel(session)).resolves.toBeUndefined();
    await expect(provider.destroySession(session)).resolves.toBeUndefined();
  });

  test("an empty script completes without emitting", async () => {
    const provider = createMockProvider({ providerId: "mock", events: [] });
    const session = await provider.createSession({
      workspacePath: "/w",
      correlationId: "c",
      capabilities: [],
    });

    const seen = [];
    for await (const event of provider.execute(session, { prompt: "p" })) {
      seen.push(event);
    }
    expect(seen).toEqual([]);
  });

  test("an error event is delivered rather than thrown", async () => {
    const provider = createMockProvider({
      providerId: "mock",
      events: [
        {
          type: "error",
          code: "RATE_LIMIT",
          message: "slow down",
          retryable: true,
        },
      ],
    });
    const session = await provider.createSession({
      workspacePath: "/w",
      correlationId: "c",
      capabilities: [],
    });

    const seen = [];
    for await (const event of provider.execute(session, { prompt: "p" })) {
      seen.push(event);
    }
    expect(seen[0]).toMatchObject({ type: "error", code: "RATE_LIMIT" });
  });
});
