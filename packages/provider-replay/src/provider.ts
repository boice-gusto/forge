import type {
  CreateProviderSessionInput,
  ProviderCapability,
  ProviderEvent,
  ProviderExecutionRequest,
  ProviderPort,
  ProviderSession,
  ResumeProviderSessionInput,
} from "@forge/ports";

import {
  isRetryable,
  loadTranscript,
  type TranscriptFrame,
} from "./transcript.js";

const EVERY_CAPABILITY: readonly ProviderCapability[] = [
  "streaming",
  "tool-calls",
  "session-resume",
];

export interface ReplayProviderOptions {
  readonly providerId: string;
  /** A recorded session on disk, read afresh on every execution. */
  readonly transcriptPath: string;
  readonly capabilities?: readonly ProviderCapability[];
  readonly available?: boolean;
}

type ReplaySessionStatus = "open" | "destroyed";

interface ReplaySessionState {
  readonly session: ProviderSession;
  status: ReplaySessionStatus;
  cancelled: boolean;
}

function failure(code: string, message: string): ProviderEvent {
  return { type: "error", code, message, retryable: isRetryable(code) };
}

function frameToEvent(frame: TranscriptFrame): ProviderEvent | undefined {
  switch (frame.kind) {
    case "text":
      return { type: "text-delta", text: frame.text };
    case "tool-call":
      return { type: "tool-call", toolId: frame.toolId, args: frame.args };
    case "tool-result":
      return {
        type: "tool-result",
        toolId: frame.toolId,
        result: frame.result,
      };
    case "failure":
      return failure(frame.code, frame.message);
    case "end":
      return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createReplayProvider(
  options: ReplayProviderOptions,
): ProviderPort {
  const capabilities = options.capabilities ?? EVERY_CAPABILITY;
  // Destroyed sessions stay as tombstones so that a reuse is refused for the
  // reason it happened rather than being mistaken for an id nobody minted.
  const sessions = new Map<string, ReplaySessionState>();
  let nextSession = 1;

  function live(session: ProviderSession): ReplaySessionState | undefined {
    const state = sessions.get(session.sessionId);
    return state?.status === "open" ? state : undefined;
  }

  return {
    providerId: options.providerId,
    capabilities,
    async createSession(
      input: CreateProviderSessionInput,
    ): Promise<ProviderSession> {
      for (const capability of input.capabilities) {
        if (!capabilities.includes(capability))
          throw new Error(
            `Replay provider ${options.providerId} does not support ${capability}.`,
          );
      }
      const session = {
        providerId: options.providerId,
        sessionId: `${options.providerId}_session_${nextSession}`,
      };
      nextSession += 1;
      sessions.set(session.sessionId, {
        session,
        status: "open",
        cancelled: false,
      });
      return session;
    },
    async resumeSession(
      input: ResumeProviderSessionInput,
    ): Promise<ProviderSession> {
      if (!capabilities.includes("session-resume"))
        throw new Error(
          `Replay provider ${options.providerId} did not declare session-resume.`,
        );
      const state = sessions.get(input.sessionId);
      if (state === undefined)
        throw new Error(`Replay provider never issued ${input.sessionId}.`);
      if (state.status === "destroyed")
        throw new Error(
          `Replay session ${input.sessionId} was destroyed and cannot be resumed.`,
        );
      return state.session;
    },
    async *execute(
      session: ProviderSession,
      _request: ProviderExecutionRequest,
    ): AsyncIterable<ProviderEvent> {
      const state = live(session);
      if (state === undefined) {
        yield failure(
          "PROVIDER_SESSION_NOT_FOUND",
          `Session ${session.sessionId} was destroyed or never existed.`,
        );
        return;
      }
      state.cancelled = false;

      const transcript = await loadTranscript(options.transcriptPath);
      if (!transcript.ok) {
        // 008 §13.10 — a native stream Forge cannot read becomes a structured
        // error, never an exception the runtime has to interpret.
        yield failure("PROVIDER_TRANSCRIPT_INVALID", transcript.reason);
        return;
      }

      for (const frame of transcript.frames) {
        await sleep(frame.delayMs);
        if (state.cancelled) {
          yield failure(
            "PROVIDER_CANCELLED",
            "The session was cancelled before the stream completed.",
          );
          return;
        }
        const event = frameToEvent(frame);
        if (event === undefined) {
          yield { type: "completed" };
          return;
        }
        yield event;
        if (event.type === "error") return;
      }

      // A recording that stops without an ending is not a success.
      yield failure(
        "PROVIDER_TRANSCRIPT_TRUNCATED",
        "The recorded session ended without a completion frame.",
      );
    },
    async cancel(session: ProviderSession): Promise<void> {
      const state = live(session);
      if (state !== undefined) state.cancelled = true;
    },
    async destroySession(session: ProviderSession): Promise<void> {
      const state = sessions.get(session.sessionId);
      if (state !== undefined) state.status = "destroyed";
    },
    async health() {
      return {
        available: options.available ?? true,
        providerId: options.providerId,
      };
    },
  };
}
