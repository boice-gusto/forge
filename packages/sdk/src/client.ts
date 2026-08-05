/**
 * Public client (004: `sdk` is a public package). It talks to the control
 * plane over HTTP and deliberately imports no internal package — not
 * `runtime`, not `compiler`, not `ir`, not an adapter. That is why the run and
 * approval shapes are restated here as the wire contract rather than
 * re-exported: the public surface must not widen when an internal type does.
 */

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "AWAITING_APPROVAL"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface RunView {
  readonly runId: string;
  readonly workflowId: string;
  readonly fingerprint: string;
  readonly status: RunStatus;
  readonly attempt: number;
  readonly performedEffects: readonly string[];
  readonly pendingApprovalId?: string;
  readonly error?: string;
}

export interface ApprovalView {
  readonly approvalId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly effect: string;
  /**
   * The binding: run + node + effect + artifact fingerprint, hashed. This —
   * not the run's fingerprint — is what the decision authorises, so it is what
   * an operator has to be shown. A screen that displays the fingerprint alone
   * is showing which artifact, not which action.
   */
  readonly effectHash: string;
  readonly policyId: string;
  readonly approvers: readonly string[];
  readonly expiresAt: string;
  readonly status: string;
  readonly createdAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly reason?: string;
}

/**
 * One entry of a run's ordered event stream (012 §4.3). `name` is the Forge
 * event name rather than a rendered sentence: a server-written label would be
 * a second, drifting copy of what the taxonomy already says (011 §4).
 */
export interface RunEventView {
  readonly seq: number;
  readonly at: string;
  readonly kind: "run" | "node" | "policy" | "approval" | "effect" | "other";
  readonly name: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface CompiledView {
  readonly workflowId: string;
  readonly fingerprint: string;
  readonly publicSurface: {
    readonly approvalGates: readonly string[];
    readonly declaredEffects: readonly string[];
    readonly requiredCapabilities: readonly string[];
    readonly roles: readonly string[];
  };
}

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: readonly string[];
  readonly suggestion?: string;
}

export type ForgeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly diagnostics?: readonly Diagnostic[];
    };

export type Decision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "edit"; readonly patch: unknown }
  | { readonly kind: "timeout" };

export interface ForgeClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Injected so callers can supply their own instrumented fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface StartRunInput {
  readonly workflow: unknown;
  readonly capabilities?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly policy?: unknown;
  readonly panel?: unknown;
  readonly review?: unknown;
}

export interface ForgeClient {
  compile(workflow: unknown): Promise<ForgeResult<CompiledView>>;
  start(input: StartRunInput): Promise<ForgeResult<RunView>>;
  getRun(runId: string): Promise<ForgeResult<RunView>>;
  /** Every run the control plane knows about, most recent first. */
  runs(): Promise<ForgeResult<readonly RunView[]>>;
  /**
   * Gates waiting on the authenticated caller, across every run. An inbox that
   * needed a run id first would not be an inbox.
   */
  inbox(): Promise<ForgeResult<readonly ApprovalView[]>>;
  pendingApprovals(
    runId: string,
  ): Promise<ForgeResult<readonly ApprovalView[]>>;
  /** Every gate this run opened, decided ones included. */
  approvals(runId: string): Promise<ForgeResult<readonly ApprovalView[]>>;
  runEvents(runId: string): Promise<ForgeResult<readonly RunEventView[]>>;
  decide(
    runId: string,
    approvalId: string,
    decision: Decision,
  ): Promise<ForgeResult<RunView>>;
}

export function createForgeClient(options: ForgeClientOptions): ForgeClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  async function call<Value>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ForgeResult<Value>> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        code: "FORGE_UNREACHABLE",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const text = await response.text();
    const payload: unknown = text === "" ? {} : JSON.parse(text);

    if (!response.ok) {
      const shape = payload as {
        code?: string;
        message?: string;
        status?: string;
        diagnostics?: readonly Diagnostic[];
      };
      return {
        ok: false,
        status: response.status,
        code: shape.code ?? shape.status ?? "FORGE_ERROR",
        message: shape.message ?? `Request failed with ${response.status}.`,
        ...(shape.diagnostics === undefined
          ? {}
          : { diagnostics: shape.diagnostics }),
      };
    }

    return { ok: true, value: payload as Value };
  }

  /** Unwraps the one-key envelope every collection route replies with. */
  async function collection<Item, Key extends string>(
    path: string,
    key: Key,
  ): Promise<ForgeResult<readonly Item[]>> {
    const result = await call<Record<Key, readonly Item[]>>("GET", path);
    return result.ok ? { ok: true, value: result.value[key] } : result;
  }

  return {
    compile: (workflow) =>
      call<CompiledView>("POST", "/v1/workflows/compile", { workflow }),
    start: (input) => call<RunView>("POST", "/v1/runs", input),
    getRun: (runId) => call<RunView>("GET", `/v1/runs/${runId}`),
    runs: () => collection<RunView, "runs">("/v1/runs", "runs"),
    inbox: () =>
      collection<ApprovalView, "pending">("/v1/approvals", "pending"),
    pendingApprovals: (runId) =>
      collection<ApprovalView, "pending">(
        `/v1/runs/${runId}/approvals`,
        "pending",
      ),
    approvals: (runId) =>
      collection<ApprovalView, "approvals">(
        `/v1/runs/${runId}/approvals`,
        "approvals",
      ),
    runEvents: (runId) =>
      collection<RunEventView, "events">(`/v1/runs/${runId}/events`, "events"),
    decide: (runId, approvalId, decision) =>
      call<RunView>(
        "POST",
        `/v1/runs/${runId}/approvals/${approvalId}/decision`,
        decision.kind === "reject"
          ? { decision: "reject", reason: decision.reason }
          : decision.kind === "edit"
            ? { decision: "edit", patch: decision.patch }
            : { decision: decision.kind },
      ),
  };
}
