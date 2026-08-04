import { describe, expect, test } from "vitest";

import { createForgeClient } from "./client.js";

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
