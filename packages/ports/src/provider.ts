export type ProviderCapability = "streaming" | "tool-calls" | "session-resume";

export type ProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly toolId: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool-result";
      readonly toolId: string;
      readonly result: unknown;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly type: "completed" };

export interface ProviderSession {
  readonly sessionId: string;
  readonly providerId: string;
}

export interface CreateProviderSessionInput {
  readonly workspacePath: string;
  readonly correlationId: string;
  readonly capabilities: readonly ProviderCapability[];
}

export interface ResumeProviderSessionInput {
  readonly sessionId: string;
}

export interface ProviderExecutionRequest {
  readonly prompt: string;
}

export interface ProviderPort {
  readonly providerId: string;
  /**
   * What this adapter can actually do. The capability intersection in 008 §4
   * is only as good as this list: an adapter that quietly accepts work it
   * cannot perform turns a compile-time check into a runtime surprise, so a
   * request naming a capability absent from here must be refused.
   */
  readonly capabilities: readonly ProviderCapability[];
  createSession(input: CreateProviderSessionInput): Promise<ProviderSession>;
  resumeSession(input: ResumeProviderSessionInput): Promise<ProviderSession>;
  execute(
    session: ProviderSession,
    request: ProviderExecutionRequest,
  ): AsyncIterable<ProviderEvent>;
  cancel(session: ProviderSession): Promise<void>;
  destroySession(session: ProviderSession): Promise<void>;
  health(): Promise<{
    readonly available: boolean;
    readonly providerId: string;
  }>;
}
