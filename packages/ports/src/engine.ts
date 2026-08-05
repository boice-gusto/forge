declare const EnginePlanBrand: unique symbol;

/**
 * Opaque lowered plan. Only an engine adapter may construct or read one; the
 * runtime treats it as a token (004 §EnginePlan opacity).
 */
export type EnginePlan = { readonly [EnginePlanBrand]: true };

/** Effects the runtime has already authorised for this attempt. */
export type AuthorisedEffects = ReadonlySet<string>;

export type EngineExecutionResult =
  | { readonly kind: "succeeded"; readonly visited: readonly string[] }
  | {
      readonly kind: "interrupted";
      readonly nodeId: string;
      readonly effect: string;
      readonly gateIds: readonly string[];
      readonly visited: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly nodeId: string;
      readonly reason: string;
      readonly retryable: boolean;
    };

export interface EngineRunContext {
  readonly runId: string;
  /** Do something real. Only supplied for effects the runtime authorised. */
  perform(nodeId: string, effect: string): Promise<void>;
  /** Assert a capability before a privileged step. Rejecting stops the walk. */
  assertCapability(nodeId: string, capability: string): Promise<void>;
  /**
   * Must return one of `conditionIds`; anything else stops the walk. There is
   * no "run every arm" fallback — a workflow that says *block or publish* must
   * not do both.
   */
  chooseBranch(
    nodeId: string,
    conditionIds: readonly string[],
  ): Promise<string>;
  /** Run an agent step against the provider. Rejecting stops the walk. */
  invokeAgent(
    nodeId: string,
    promptRef: string,
    role: string | undefined,
  ): Promise<void>;
  /** Score an artifact. Fails closed: a verdict with no declared arm stops the walk. */
  judge(nodeId: string, judgeRef: string): Promise<JudgeVerdict>;
  /** Acquire disposable compute. Unavailable means stop, never host fallback. */
  enterSandbox(nodeId: string, profile: string): Promise<void>;
}

export interface GraphEnginePort {
  materialize(ir: unknown): Promise<EnginePlan>;
  /**
   * Executes from the start every time, so a later attempt re-walks
   * pre-interrupt nodes (006 §8): idempotent up to the first unauthorised
   * effect.
   */
  execute(
    plan: EnginePlan,
    context: EngineRunContext,
    authorised: AuthorisedEffects,
  ): Promise<EngineExecutionResult>;
}

/** Verdict a judge node returns. A verdict the judge declared no arm for stops the walk. */
export type JudgeVerdict = "pass" | "fail" | "review";
