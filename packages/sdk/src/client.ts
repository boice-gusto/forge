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
  /**
   * Bearer credential for a programmatic caller — a CLI, a worker, a company's
   * acceptance suite. Nothing attaches it on the caller's behalf, so it needs
   * no CSRF token.
   */
  readonly token?: string;
  /**
   * Browser session. The session cookie travels with a same-origin request on
   * its own; this header is what proves the request came from the Forge UI and
   * not from another origin the browser also attached the cookie to (012 §8).
   */
  readonly csrfToken?: string;
  /** Injected so callers can supply their own instrumented fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * A credential for the bound identity provider, passed through untouched. Its
 * shape is the provider's business: `operator-secret` for the development
 * provider, an OIDC token for a deployment that has an IdP.
 */
export interface SessionCredential {
  readonly kind: string;
  readonly value: string;
}

/** An established session, as its owner is allowed to see it. */
export interface SessionView {
  readonly subject: string;
  /** Membership the server resolved. Reported, never asserted by the client. */
  readonly roles: readonly string[];
  readonly expiresAt: string;
  readonly csrfToken: string;
}

/**
 * Establishing a session, which is separate from using one: a client needs the
 * CSRF token before it can make an unsafe request, and only signing in yields
 * that token.
 */
export interface ForgeSessionClient {
  signIn(credential: SessionCredential): Promise<ForgeResult<SessionView>>;
  /** The session the cookie already names, so a reload need not sign in again. */
  current(): Promise<ForgeResult<SessionView>>;
  signOut(csrfToken: string): Promise<ForgeResult<{ readonly status: string }>>;
}

interface Wire {
  readonly baseUrl: string;
  readonly token?: string;
  readonly csrfToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One request, one place. Both clients go through here so an error envelope,
 * a credential and a CSRF header cannot be handled two subtly different ways.
 */
async function request<Value>(
  options: Wire,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ForgeResult<Value>> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/$/, "");

  let response: Response;
  try {
    response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.token === undefined
          ? {}
          : { authorization: `Bearer ${options.token}` }),
        ...(options.csrfToken === undefined
          ? {}
          : { "x-forge-csrf": options.csrfToken }),
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

export function createForgeSessionClient(options: {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): ForgeSessionClient {
  return {
    signIn: (credential) =>
      request<SessionView>(options, "POST", "/v1/auth/session", { credential }),
    current: () => request<SessionView>(options, "GET", "/v1/auth/session"),
    signOut: (csrfToken) =>
      request<{ status: string }>(
        { ...options, csrfToken },
        "DELETE",
        "/v1/auth/session",
      ),
  };
}

export interface StartRunInput {
  readonly workflow: unknown;
  /** Checked against the deployment's closure, so it can only narrow. */
  readonly capabilities?: readonly string[];
  readonly changedPaths?: readonly string[];
  // No `policy`, `panel` or `review`. Policy is the deployment's, resolved
  // from its company package — and a caller naming the judge's votes or a
  // branch arm would steer the decision it is asking a human to approve.
}

/**
 * The statuses at which no queued job is outstanding: the run is waiting on a
 * human, or it is over. Deliberately *not* "terminal" — a helper that only
 * settled on a finished run would quietly turn every gate assertion into a
 * timeout, and a double-dispatch test written against it would drive the run
 * past the node it was guarding before redelivering anything.
 */
const SETTLED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "AWAITING_APPROVAL",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export interface WaitForRunOptions {
  /**
   * What "done waiting" means. Defaults to "the queue owes this run nothing":
   * it has reached a gate or a terminal state.
   */
  readonly until?: (run: RunView) => boolean;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export interface StreamRunEventsOptions {
  /** Called once per record, in the order the store assigned. */
  readonly onEvent: (event: RunEventView) => void;
  /**
   * Where to resume from — the `seq` of the last record already held. The
   * server replays only what follows, which is what lets a caller read the
   * snapshot first and then tail without seeing its own history twice.
   */
  readonly lastEventId?: number;
}

export interface RunEventStream {
  /** Stops the tail and releases the connection. Safe to call twice. */
  close(): void;
}

export interface ForgeClient {
  compile(workflow: unknown): Promise<ForgeResult<CompiledView>>;
  /**
   * Creates a run and returns immediately. The control plane persists it and
   * enqueues the work, so the reply is a run at `PENDING` — the record, not
   * the outcome. Follow it with `waitForRun`.
   */
  start(input: StartRunInput): Promise<ForgeResult<RunView>>;
  getRun(runId: string): Promise<ForgeResult<RunView>>;
  /**
   * Polls `getRun` until the run stops moving, or the deadline passes.
   *
   * One helper, because the alternative is the same loop written slightly
   * differently in every caller — and the version that waits for a *terminal*
   * status is both the easiest to write and the one that makes a gate
   * assertion unfalsifiable. A timeout is a failed result naming the last
   * status seen, not a throw and not a silent success.
   */
  waitForRun(
    runId: string,
    options?: WaitForRunOptions,
  ): Promise<ForgeResult<RunView>>;
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
  /**
   * The same timeline, tailed instead of sampled: every record already stored
   * arrives first, then each new one as the control plane writes it.
   *
   * Over `fetch` rather than `EventSource`, deliberately. `EventSource` cannot
   * set a request header, so a programmatic caller could only present its
   * bearer credential in the query string — and a credential in a URL is a
   * credential in an access log, a proxy trace and a `Referer`. `fetch` carries
   * `Authorization` for a token client and the session cookie for a
   * same-origin browser one, so both transports authenticate exactly as they
   * do on every other route rather than through a second, weaker path. The
   * wire is still plain SSE, so an `EventSource` a cookie already authenticates
   * works against it unchanged.
   *
   * The result resolves once the control plane has accepted the connection, so
   * a 401, a 403 or a 404 is an ordinary failed result. Records arrive after
   * that, on `onEvent`, until the caller closes the stream.
   */
  streamRunEvents(
    runId: string,
    options: StreamRunEventsOptions,
  ): Promise<ForgeResult<RunEventStream>>;
  decide(
    runId: string,
    approvalId: string,
    decision: Decision,
  ): Promise<ForgeResult<RunView>>;
}

export function createForgeClient(options: ForgeClientOptions): ForgeClient {
  const call = <Value>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ForgeResult<Value>> => request<Value>(options, method, path, body);

  /** Unwraps the one-key envelope every collection route replies with. */
  async function collection<Item, Key extends string>(
    path: string,
    key: Key,
  ): Promise<ForgeResult<readonly Item[]>> {
    const result = await call<Record<Key, readonly Item[]>>("GET", path);
    return result.ok ? { ok: true, value: result.value[key] } : result;
  }

  const getRun = (runId: string) => call<RunView>("GET", `/v1/runs/${runId}`);

  async function waitForRun(
    runId: string,
    waitOptions: WaitForRunOptions = {},
  ): Promise<ForgeResult<RunView>> {
    const until =
      waitOptions.until ?? ((run: RunView) => SETTLED.has(run.status));
    const intervalMs = waitOptions.intervalMs ?? 25;
    const timeoutMs = waitOptions.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const result = await getRun(runId);
      // A read that failed is the answer. Retrying past a 404 or a 401 would
      // turn "this run does not exist" into "this run is slow".
      if (!result.ok) return result;
      if (until(result.value)) return result;
      if (Date.now() >= deadline) {
        return {
          ok: false,
          status: 0,
          code: "FORGE_RUN_NOT_SETTLED",
          message: `Run ${runId} was still ${result.value.status} after ${timeoutMs}ms.`,
        };
      }
      await new Promise((settle) => setTimeout(settle, intervalMs));
    }
  }

  /**
   * SSE, decoded. Frames are separated by a blank line and the only field this
   * client reads is `data:` — `id:` is echoed back by the *server's* notion of
   * resumption, not tracked here, because a caller that wants to resume already
   * holds the `seq` of the last record it saw.
   */
  async function pump(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: RunEventView) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      for (; boundary !== -1; boundary = buffered.indexOf("\n\n")) {
        const payload = buffered
          .slice(0, boundary)
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        buffered = buffered.slice(boundary + 2);
        // A comment or a keep-alive frame carries no data and is not an event.
        if (payload !== "") onEvent(JSON.parse(payload) as RunEventView);
      }
    }
  }

  async function streamRunEvents(
    runId: string,
    streamOptions: StreamRunEventsOptions,
  ): Promise<ForgeResult<RunEventStream>> {
    const doFetch = options.fetch ?? globalThis.fetch;
    const controller = new AbortController();

    let response: Response;
    try {
      response = await doFetch(
        `${options.baseUrl.replace(/\/$/, "")}/v1/runs/${runId}/events`,
        {
          method: "GET",
          headers: {
            accept: "text/event-stream",
            ...(options.token === undefined
              ? {}
              : { authorization: `Bearer ${options.token}` }),
            ...(streamOptions.lastEventId === undefined
              ? {}
              : { "last-event-id": String(streamOptions.lastEventId) }),
          },
          signal: controller.signal,
        },
      );
    } catch (error) {
      return {
        ok: false,
        status: 0,
        code: "FORGE_UNREACHABLE",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (!response.ok || response.body === null) {
      const text = await response.text();
      const shape = (text === "" ? {} : JSON.parse(text)) as {
        code?: string;
        message?: string;
        status?: string;
      };
      return {
        ok: false,
        status: response.status,
        code: shape.code ?? shape.status ?? "FORGE_ERROR",
        message: shape.message ?? `Stream refused with ${response.status}.`,
      };
    }

    // Read on its own, off the caller's stack. An abort surfaces here as a
    // rejection and means the caller closed the stream, which is not an error.
    void pump(response.body, streamOptions.onEvent).catch(() => {});

    return { ok: true, value: { close: () => controller.abort() } };
  }

  return {
    compile: (workflow) =>
      call<CompiledView>("POST", "/v1/workflows/compile", { workflow }),
    start: (input) => call<RunView>("POST", "/v1/runs", input),
    getRun,
    waitForRun,
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
    streamRunEvents,
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
