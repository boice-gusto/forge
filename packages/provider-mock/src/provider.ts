import type {
  CreateProviderSessionInput,
  ProviderCapability,
  ProviderEvent,
  ProviderExecutionRequest,
  ProviderPort,
  ProviderSession,
  ResumeProviderSessionInput,
} from "@forge/ports";

const EVERY_CAPABILITY: readonly ProviderCapability[] = [
  "streaming",
  "tool-calls",
  "session-resume",
];

export interface MockProviderOptions {
  readonly providerId: string;
  readonly events: readonly ProviderEvent[];
  /** Defaults to everything — the mock stands in for a full provider. */
  readonly capabilities?: readonly ProviderCapability[];
  readonly available?: boolean;
}

interface MockSessionState {
  readonly session: ProviderSession;
  cancelled: boolean;
}

/**
 * A cancelled stream stops and says so. Ending quietly would be
 * indistinguishable from a stream that simply had nothing left to emit, and
 * retrying a deliberate stop would undo the stop.
 */
const CANCELLED: ProviderEvent = {
  type: "error",
  code: "PROVIDER_CANCELLED",
  message: "The session was cancelled before the stream completed.",
  retryable: false,
};

const SESSION_GONE: ProviderEvent = {
  type: "error",
  code: "PROVIDER_SESSION_NOT_FOUND",
  message: "The session was destroyed or never existed.",
  retryable: false,
};

function isTerminal(event: ProviderEvent): boolean {
  return event.type === "completed" || event.type === "error";
}

export function createMockProvider(options: MockProviderOptions): ProviderPort {
  const capabilities = options.capabilities ?? EVERY_CAPABILITY;
  const sessions = new Map<string, MockSessionState>();
  let nextSession = 1;

  return {
    providerId: options.providerId,
    capabilities,
    async createSession(
      input: CreateProviderSessionInput,
    ): Promise<ProviderSession> {
      const undeclared = input.capabilities.filter(
        (capability) => !capabilities.includes(capability),
      );
      if (undeclared.length > 0) {
        throw new Error(
          `Mock provider does not support ${undeclared.join(", ")}.`,
        );
      }
      const session = {
        providerId: options.providerId,
        sessionId: `mock_session_${nextSession}`,
      };
      nextSession += 1;
      sessions.set(session.sessionId, { session, cancelled: false });
      return session;
    },
    async resumeSession(
      input: ResumeProviderSessionInput,
    ): Promise<ProviderSession> {
      if (!capabilities.includes("session-resume"))
        throw new Error("Mock provider did not declare session-resume.");
      const state = sessions.get(input.sessionId);
      if (state === undefined)
        throw new Error("Mock provider session was not found.");
      return state.session;
    },
    async *execute(
      session: ProviderSession,
      _request: ProviderExecutionRequest,
    ): AsyncIterable<ProviderEvent> {
      const state = sessions.get(session.sessionId);
      if (state === undefined) {
        yield SESSION_GONE;
        return;
      }
      // A fresh execution is fresh work, so a stop aimed at the previous one
      // must not silently kill it.
      state.cancelled = false;
      for (const event of options.events) {
        if (state.cancelled) {
          yield CANCELLED;
          return;
        }
        yield event;
        // A script that keeps going past its own ending would let a consumer
        // see events after `completed`.
        if (isTerminal(event)) return;
      }
    },
    async cancel(session: ProviderSession): Promise<void> {
      const state = sessions.get(session.sessionId);
      if (state !== undefined) state.cancelled = true;
    },
    async destroySession(session: ProviderSession): Promise<void> {
      sessions.delete(session.sessionId);
    },
    async health() {
      return {
        available: options.available ?? true,
        providerId: options.providerId,
      };
    },
  };
}
