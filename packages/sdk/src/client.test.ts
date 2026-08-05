import { describe, expect, test } from "vitest";

import { createForgeClient, createForgeSessionClient } from "./client.js";

/**
 * A fetch double that records requests, so the client's contract can be
 * asserted without standing up a server. The API's own integration tests
 * cover the server side.
 */
function stubFetch(
  responder: (
    url: string,
    init: RequestInit,
  ) => { status: number; body: unknown },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchLike = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    calls.push({ url, init });
    const { status, body } = responder(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetchLike, calls };
}

const client = (
  responder: (
    url: string,
    init: RequestInit,
  ) => { status: number; body: unknown },
) => {
  const { fetchLike, calls } = stubFetch(responder);
  return {
    forge: createForgeClient({
      baseUrl: "http://localhost:3100/",
      token: "local-test",
      fetch: fetchLike,
    }),
    calls,
  };
};

describe("forge client", () => {
  test("sends the bearer token on every call", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.getRun("run_1");

    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer local-test",
    });
  });

  test("normalises a trailing slash on the base url", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.getRun("run_1");

    expect(calls[0]?.url).toBe("http://localhost:3100/v1/runs/run_1");
  });

  test("returns compile diagnostics as data rather than throwing", async () => {
    const { forge } = client(() => ({
      status: 422,
      body: {
        code: "WORKFLOW_COMPILE_FAILED",
        diagnostics: [{ code: "WF_CYCLE", message: "cycle", path: ["edges"] }],
      },
    }));
    const result = await forge.compile({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("WORKFLOW_COMPILE_FAILED");
    expect(result.diagnostics?.[0]?.code).toBe("WF_CYCLE");
  });

  test("unwraps the pending approvals envelope", async () => {
    const { forge } = client(() => ({
      status: 200,
      body: { pending: [{ approvalId: "approval_1", nodeId: "publish" }] },
    }));
    const result = await forge.pendingApprovals("run_1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.approvalId).toBe("approval_1");
  });

  test("a reject decision carries its reason", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.decide("run_1", "approval_1", {
      kind: "reject",
      reason: "off brand",
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      decision: "reject",
      reason: "off brand",
    });
  });

  test("an approve decision sends no extra fields", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.decide("run_1", "approval_1", { kind: "approve" });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      decision: "approve",
    });
  });

  test("an unreachable control plane is reported, not thrown", async () => {
    const forge = createForgeClient({
      baseUrl: "http://localhost:1",
      token: "local-test",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof globalThis.fetch,
    });
    const result = await forge.getRun("run_1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FORGE_UNREACHABLE");
  });

  test("a 401 surfaces the status rather than looking like success", async () => {
    const { forge } = client(() => ({
      status: 401,
      body: { status: "unauthorized" },
    }));
    const result = await forge.start({ workflow: {} });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
    expect(result.code).toBe("unauthorized");
  });
});

/**
 * The control plane accepts a run and enqueues it, so `start` returns a record
 * at `PENDING` and the outcome arrives later. `waitForRun` is the one place
 * that loop is written; these are the ways it can be got wrong.
 */
describe("waiting for a run the control plane only accepted", () => {
  /** A run whose status is whatever the sequence says on the nth read. */
  const readingBack = (statuses: readonly string[]) => {
    let read = 0;
    return client(() => {
      const status = statuses[Math.min(read, statuses.length - 1)];
      read += 1;
      return {
        status: 200,
        body: { runId: "run_1", status, performedEffects: [] },
      };
    });
  };

  test("settles on a gate, which is not a terminal state", async () => {
    // The trap this helper exists to avoid. A default of "wait until the run
    // is finished" would spin here until the deadline and then report a
    // timeout for a run that had been sitting at its gate the whole time.
    const { forge } = readingBack(["PENDING", "RUNNING", "AWAITING_APPROVAL"]);
    const result = await forge.waitForRun("run_1", { intervalMs: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.status).toBe("AWAITING_APPROVAL");
  });

  test("does not report a status the run has not reached", async () => {
    // It keeps reading while the run is PENDING or RUNNING, so a caller that
    // asserts on a gate is asserting on one that exists.
    const { forge, calls } = readingBack(["PENDING", "PENDING", "SUCCEEDED"]);
    const result = await forge.waitForRun("run_1", { intervalMs: 0 });

    expect(result.ok && result.value.status).toBe("SUCCEEDED");
    expect(calls).toHaveLength(3);
  });

  test("a caller can name its own condition", async () => {
    const { forge } = readingBack(["PENDING", "RUNNING"]);
    const result = await forge.waitForRun("run_1", {
      intervalMs: 0,
      until: (run) => run.status === "RUNNING",
    });

    expect(result.ok && result.value.status).toBe("RUNNING");
  });

  test("a run that never moves is a failed result naming what it was", async () => {
    // Not a throw and, more importantly, not a success. A helper that returned
    // the last record it saw would let a gate assertion pass on a PENDING run.
    const { forge } = readingBack(["PENDING"]);
    const result = await forge.waitForRun("run_1", {
      intervalMs: 0,
      timeoutMs: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FORGE_RUN_NOT_SETTLED");
    expect(result.message).toContain("PENDING");
  });

  test("a read that fails is the answer, not something to retry past", async () => {
    const { forge, calls } = client(() => ({
      status: 404,
      body: { status: "not_found" },
    }));
    const result = await forge.waitForRun("run_nope", { intervalMs: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  test("an accepted start is a PENDING record, and 202 is a success", async () => {
    const { forge } = client(() => ({
      status: 202,
      body: { runId: "run_1", status: "PENDING", performedEffects: [] },
    }));
    const result = await forge.start({ workflow: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.status).toBe("PENDING");
  });
});

describe("decision encoding", () => {
  test("an edit carries its patch", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.decide("run_1", "approval_1", {
      kind: "edit",
      patch: { copy: "reworded" },
    });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      decision: "edit",
      patch: { copy: "reworded" },
    });
  });

  test("a timeout sends only its kind", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.decide("run_1", "approval_1", { kind: "timeout" });

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      decision: "timeout",
    });
  });

  test("compile posts the workflow under a workflow key", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.compile({ id: "w" });

    expect(calls[0]?.url).toContain("/v1/workflows/compile");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      workflow: { id: "w" },
    });
  });

  test("an empty response body is not a parse failure", async () => {
    const forge = createForgeClient({
      baseUrl: "http://localhost:3100",
      token: "local-test",
      fetch: (async () =>
        new Response("", {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    });

    const result = await forge.getRun("run_1");
    expect(result.ok).toBe(true);
  });

  test("an error without a code falls back to a generic one", async () => {
    const { forge } = client(() => ({ status: 500, body: {} }));
    const result = await forge.getRun("run_1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("FORGE_ERROR");
    expect(result.message).toContain("500");
  });

  test("a GET sends no content-type, since it has no body", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.getRun("run_1");

    expect(calls[0]?.init.headers).not.toHaveProperty("content-type");
  });
});

/**
 * The routes that let an operator surface exist at all: an inbox that needs no
 * run id, a run's whole gate history, and the run's own event stream.
 */
describe("cross-run and history queries", () => {
  test("the inbox is a route of its own, not a per-run query", async () => {
    const { forge, calls } = client(() => ({
      status: 200,
      body: { pending: [{ approvalId: "approval_1", runId: "run_9" }] },
    }));
    const result = await forge.inbox();

    expect(calls[0]?.url).toBe("http://localhost:3100/v1/approvals");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.runId).toBe("run_9");
  });

  test("the run list unwraps its envelope", async () => {
    const { forge, calls } = client(() => ({
      status: 200,
      body: { runs: [{ runId: "run_2" }, { runId: "run_1" }] },
    }));
    const result = await forge.runs();

    expect(calls[0]?.url).toBe("http://localhost:3100/v1/runs");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.map((run) => run.runId)).toEqual(["run_2", "run_1"]);
  });

  test("a run's gate history is the full set, not only what is pending", async () => {
    const { forge } = client(() => ({
      status: 200,
      body: {
        pending: [],
        approvals: [{ approvalId: "approval_1", status: "REJECTED" }],
      },
    }));
    const result = await forge.approvals("run_1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.status).toBe("REJECTED");
  });

  test("run events unwrap in order", async () => {
    const { forge, calls } = client(() => ({
      status: 200,
      body: { events: [{ seq: 0, name: "forge.run.transition" }] },
    }));
    const result = await forge.runEvents("run_1");

    expect(calls[0]?.url).toBe("http://localhost:3100/v1/runs/run_1/events");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.name).toBe("forge.run.transition");
  });

  test("a failed collection query is reported, not turned into an empty list", async () => {
    const { forge } = client(() => ({
      status: 401,
      body: { status: "unauthorized" },
    }));

    for (const result of await Promise.all([
      forge.inbox(),
      forge.runs(),
      forge.approvals("run_1"),
      forge.runEvents("run_1"),
    ])) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("unauthorized");
    }
  });

  test("the binding is part of the approval the SDK exposes", async () => {
    const { forge } = client(() => ({
      status: 200,
      body: { pending: [{ approvalId: "approval_1", effectHash: "abc123" }] },
    }));
    const result = await forge.inbox();

    if (!result.ok) throw new Error("unreachable");
    expect(result.value[0]?.effectHash).toBe("abc123");
  });
});

/**
 * The browser's credential is the session cookie, which the SDK never sees and
 * never sets: it travels with a same-origin request on its own. What the SDK
 * has to carry is the CSRF token, because that is the part another origin
 * cannot obtain.
 */
describe("a browser session, rather than a bearer token", () => {
  test("a client with no token sends no Authorization header at all", async () => {
    const { fetchLike, calls } = stubFetch(() => ({ status: 200, body: {} }));
    const forge = createForgeClient({
      baseUrl: "http://localhost:3100",
      csrfToken: "csrf-1",
      fetch: fetchLike,
    });
    await forge.getRun("run_1");

    expect(calls[0]?.init.headers).not.toHaveProperty("authorization");
    expect(calls[0]?.init.headers).toMatchObject({ "x-forge-csrf": "csrf-1" });
  });

  test("the CSRF token rides on unsafe calls, which are the ones that matter", async () => {
    const { fetchLike, calls } = stubFetch(() => ({ status: 200, body: {} }));
    const forge = createForgeClient({
      baseUrl: "http://localhost:3100",
      csrfToken: "csrf-1",
      fetch: fetchLike,
    });
    await forge.decide("run_1", "approval_1", { kind: "approve" });

    expect(calls[0]?.init.headers).toMatchObject({ "x-forge-csrf": "csrf-1" });
  });

  test("a bearer client sends no CSRF header, having no ambient credential", async () => {
    const { forge, calls } = client(() => ({ status: 200, body: {} }));
    await forge.getRun("run_1");

    expect(calls[0]?.init.headers).not.toHaveProperty("x-forge-csrf");
  });
});

describe("establishing a session", () => {
  const sessions = (
    responder: (
      url: string,
      init: RequestInit,
    ) => { status: number; body: unknown },
  ) => {
    const { fetchLike, calls } = stubFetch(responder);
    return {
      forge: createForgeSessionClient({
        baseUrl: "http://localhost:3100",
        fetch: fetchLike,
      }),
      calls,
    };
  };

  const SESSION = {
    subject: "sam@example.test",
    roles: ["role-a"],
    expiresAt: "2026-01-01T20:00:00.000Z",
    csrfToken: "csrf-1",
  };

  test("signing in posts the credential untouched and returns the resolved principal", async () => {
    const { forge, calls } = sessions(() => ({ status: 201, body: SESSION }));
    const result = await forge.signIn({
      kind: "operator-secret",
      value: "sam-cred",
    });

    expect(calls[0]?.url).toBe("http://localhost:3100/v1/auth/session");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      credential: { kind: "operator-secret", value: "sam-cred" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Roles come back from the server. The client never asserts its own.
    expect(result.value.roles).toEqual(["role-a"]);
  });

  test("a refused credential is a result, not a thrown error", async () => {
    const { forge } = sessions(() => ({
      status: 401,
      body: { status: "unauthorized" },
    }));
    const result = await forge.signIn({ kind: "operator-secret", value: "no" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });

  test("the current session is read with no credential of its own", async () => {
    const { forge, calls } = sessions(() => ({ status: 200, body: SESSION }));
    await forge.current();

    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).not.toHaveProperty("authorization");
  });

  test("signing out is an unsafe call and carries the CSRF token", async () => {
    const { forge, calls } = sessions(() => ({
      status: 200,
      body: { status: "signed_out" },
    }));
    const result = await forge.signOut("csrf-1");

    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.init.headers).toMatchObject({ "x-forge-csrf": "csrf-1" });
    expect(result.ok).toBe(true);
  });
});
