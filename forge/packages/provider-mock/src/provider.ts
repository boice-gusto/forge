import type {
  CreateProviderSessionInput,
  ProviderEvent,
  ProviderExecutionRequest,
  ProviderPort,
  ProviderSession,
  ResumeProviderSessionInput,
} from "@forge/ports";

export interface MockProviderOptions {
  readonly providerId: string;
  readonly events: readonly ProviderEvent[];
}

export function createMockProvider(options: MockProviderOptions): ProviderPort {
  const sessions = new Map<string, ProviderSession>();
  let nextSession = 1;

  return {
    providerId: options.providerId,
    async createSession(
      _input: CreateProviderSessionInput,
    ): Promise<ProviderSession> {
      const session = {
        providerId: options.providerId,
        sessionId: `mock_session_${nextSession}`,
      };
      nextSession += 1;
      sessions.set(session.sessionId, session);
      return session;
    },
    async resumeSession(
      input: ResumeProviderSessionInput,
    ): Promise<ProviderSession> {
      const session = sessions.get(input.sessionId);
      if (session === undefined)
        throw new Error("Mock provider session was not found.");
      return session;
    },
    async *execute(
      _session: ProviderSession,
      _request: ProviderExecutionRequest,
    ): AsyncIterable<ProviderEvent> {
      yield* options.events;
    },
    async cancel(_session: ProviderSession): Promise<void> {},
    async destroySession(session: ProviderSession): Promise<void> {
      sessions.delete(session.sessionId);
    },
    async health() {
      return { available: true, providerId: options.providerId };
    },
  };
}
