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
  readonly policyId: string;
  readonly approvers: readonly string[];
  readonly expiresAt: string;
  readonly status: string;
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
  pendingApprovals(
    runId: string,
  ): Promise<ForgeResult<readonly ApprovalView[]>>;
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

  return {
    compile: (workflow) =>
      call<CompiledView>("POST", "/v1/workflows/compile", { workflow }),
    start: (input) => call<RunView>("POST", "/v1/runs", input),
    getRun: (runId) => call<RunView>("GET", `/v1/runs/${runId}`),
    async pendingApprovals(runId) {
      const result = await call<{ pending: readonly ApprovalView[] }>(
        "GET",
        `/v1/runs/${runId}/approvals`,
      );
      return result.ok ? { ok: true, value: result.value.pending } : result;
    },
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
