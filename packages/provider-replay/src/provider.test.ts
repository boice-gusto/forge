import { fileURLToPath } from "node:url";

import type { ProviderEvent, ProviderPort } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { createReplayProvider } from "./provider.js";
import { isRetryable, loadTranscript, parseTranscript } from "./transcript.js";

function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
}

function replay(name: string): ProviderPort {
  return createReplayProvider({
    providerId: "replay",
    transcriptPath: fixture(name),
  });
}

async function play(provider: ProviderPort): Promise<readonly ProviderEvent[]> {
  const session = await provider.createSession({
    workspacePath: "/workspace",
    correlationId: "trace_1",
    capabilities: ["streaming"],
  });
  const events: ProviderEvent[] = [];
  for await (const event of provider.execute(session, { prompt: "go" })) {
    events.push(event);
  }
  return events;
}

describe("a recording Forge cannot read stops the run instead of confusing it", () => {
  test("an unrecognised frame becomes a structured error, not a thrown exception", async () => {
    const events = await play(replay("unrecognised-frame"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      code: "PROVIDER_TRANSCRIPT_INVALID",
      retryable: false,
    });
    // The message must locate the bad frame; the exact prose is the parser's.
    expect((events[0] as { message: string }).message).toContain("frames.1");
  });

  test("a transcript that is not there is reported rather than crashing the worker", async () => {
    const events = await play(replay("no-such-recording"));

    expect(events).toMatchObject([
      { type: "error", code: "PROVIDER_TRANSCRIPT_INVALID", retryable: false },
    ]);
  });

  test("a recording that stops early is not treated as a completion", async () => {
    const events = await play(replay("truncated"));

    expect(events.map((event) => event.type)).toEqual(["text-delta", "error"]);
    expect(events.at(-1)).toMatchObject({
      code: "PROVIDER_TRANSCRIPT_TRUNCATED",
      retryable: false,
    });
  });

  test("a payload that is not a frame list is rejected before it is replayed", () => {
    for (const payload of [null, {}, { frames: "not a list" }, []]) {
      const parsed = parseTranscript(payload);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.reason).not.toBe("");
    }
  });

  test("a frame missing the field its kind requires is not guessed at", () => {
    const halfFrames: readonly unknown[] = [
      null,
      { kind: "text" },
      { kind: "tool-call", args: {} },
      { kind: "tool-result", result: {} },
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", message: "no code" },
    ];

    for (const frame of halfFrames) {
      const parsed = parseTranscript({ frames: [frame] });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      // Names the offending frame, so a long recording is debuggable.
      expect(parsed.reason).toContain("frames.0");
    }
  });

  test("a recording that is not JSON at all is reported, not thrown", async () => {
    const path = fileURLToPath(
      new URL("../fixtures/not-json.txt", import.meta.url),
    );

    expect(await loadTranscript(path)).toEqual({
      ok: false,
      reason: `the transcript at ${path} is not valid JSON`,
    });
  });
});

describe("retryability is the adapter's verdict, not the recording's", () => {
  test("only failures a later attempt could clear are retryable", () => {
    expect(isRetryable("RATE_LIMITED")).toBe(true);
    expect(isRetryable("TIMEOUT")).toBe(true);
    // Fail closed: a code nobody has classified must not make the runtime spin.
    expect(isRetryable("SOMETHING_NEW")).toBe(false);
    expect(isRetryable("INVALID_REQUEST")).toBe(false);
  });

  test("the recorded frame carries no verdict of its own", async () => {
    const parsed = parseTranscript({
      frames: [{ kind: "failure", code: "TIMEOUT", message: "slow" }],
    });

    expect(parsed).toEqual({
      ok: true,
      frames: [
        { kind: "failure", code: "TIMEOUT", message: "slow", delayMs: 0 },
      ],
    });
    expect(await play(replay("transient-failure"))).toContainEqual({
      type: "error",
      code: "RATE_LIMITED",
      message: "Upstream returned 429; the window resets shortly.",
      retryable: true,
    });
  });
});

describe("a destroyed session is refused for the reason it was refused", () => {
  test("a destroyed id is distinguished from one that was never issued", async () => {
    const provider = replay("text-stream");
    const session = await provider.createSession({
      workspacePath: "/workspace",
      correlationId: "trace_1",
      capabilities: [],
    });
    await provider.destroySession(session);

    await expect(
      provider.resumeSession({ sessionId: session.sessionId }),
    ).rejects.toThrow("was destroyed");
    await expect(
      provider.resumeSession({ sessionId: "replay_session_99" }),
    ).rejects.toThrow("never issued");
  });

  test("cleaning up a session the provider never issued is a no-op", async () => {
    const provider = replay("text-stream");
    const stranger = { providerId: "replay", sessionId: "replay_session_404" };

    await expect(provider.cancel(stranger)).resolves.toBeUndefined();
    await expect(provider.destroySession(stranger)).resolves.toBeUndefined();
  });

  test("cancelling a destroyed session is a no-op rather than an error", async () => {
    const provider = replay("text-stream");
    const session = await provider.createSession({
      workspacePath: "/workspace",
      correlationId: "trace_1",
      capabilities: [],
    });
    await provider.destroySession(session);

    await expect(provider.cancel(session)).resolves.toBeUndefined();
  });
});

describe("the recorded transcript is replayed as Forge events", () => {
  test("a tool round trip keeps its arguments and its result", async () => {
    const events = await play(replay("tool-round-trip"));

    expect(events).toEqual([
      { type: "text-delta", text: "Checking the brief." },
      { type: "tool-call", toolId: "read_file", args: { path: "brief.md" } },
      { type: "tool-result", toolId: "read_file", result: { bytes: 412 } },
      { type: "text-delta", text: "The brief is current." },
      { type: "completed" },
    ]);
  });
});
