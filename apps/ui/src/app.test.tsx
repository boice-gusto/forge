// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { createForgeClient } from "@forge/sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ForgeApp } from "./app.js";

afterEach(cleanup);

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const FINGERPRINT = "sha256:9f2c4b1ad0e7315c8a6b2fd41e0c93875ab6d2e10f4c7b93a";

const RUN = {
  runId: "run_1",
  workflowId: "campaign-brief",
  fingerprint: FINGERPRINT,
  status: "AWAITING_APPROVAL",
  attempt: 1,
  performedEffects: ["draft"],
  pendingApprovalId: "apr_1",
};

const GATE = {
  approvalId: "apr_1",
  runId: "run_1",
  nodeId: "publish",
  effect: "slack.post",
  policyId: "pol_external_publish",
  approvers: ["marketing-lead"],
  expiresAt: "2026-01-01T12:30:00.000Z",
  status: "PENDING",
};

interface Route {
  readonly status?: number;
  readonly body: unknown;
}

interface Call {
  readonly url: string;
  readonly body: unknown;
}

/**
 * The app is exercised through a real `createForgeClient` over a stub fetch,
 * so the wire shape the API actually returns is part of what these tests
 * defend — not a hand-written client double that could drift from it.
 */
function stubApi(routes: Readonly<Record<string, Route>>) {
  const calls: Call[] = [];

  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const path = url.slice(url.indexOf("/v1"));
    calls.push({
      url: `${init?.method ?? "GET"} ${path}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const route = routes[path];
    if (route === undefined)
      return new Response(JSON.stringify({ status: "not_found" }), {
        status: 404,
      });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  };

  return { fetchStub: fetchStub as unknown as typeof globalThis.fetch, calls };
}

function draw(fetchStub: typeof globalThis.fetch) {
  render(
    <ForgeApp
      client={createForgeClient({
        baseUrl: "http://api.test",
        token: "t",
        fetch: fetchStub,
      })}
      dependencies={[{ name: "api", status: "healthy" }]}
      now={NOW}
    />,
  );
}

async function openRun(): Promise<void> {
  await userEvent.type(screen.getByLabelText("Run id"), "run_1");
  await userEvent.click(screen.getByRole("button", { name: "Open run" }));
}

describe("opening a run shows its gates and what it has dispatched", () => {
  test("the inbox and the inspector both appear for a gated run", async () => {
    const { fetchStub } = stubApi({
      "/v1/runs/run_1": { body: RUN },
      "/v1/runs/run_1/approvals": { body: { pending: [GATE] } },
    });
    draw(fetchStub);

    await openRun();

    expect(
      await screen.findByRole("region", { name: "Approval inbox" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Run inspector" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Effect dispatched at node draft"),
    ).toBeInTheDocument();
  });

  test("nothing is fetched before a run id is given", async () => {
    const { fetchStub, calls } = stubApi({});
    draw(fetchStub);

    await userEvent.click(screen.getByRole("button", { name: "Open run" }));

    expect(calls).toEqual([]);
  });
});

describe("a control-plane failure is shown, never mistaken for an empty queue", () => {
  test("an unknown run reports the error instead of no gates", async () => {
    const { fetchStub } = stubApi({
      "/v1/runs/run_1": { status: 404, body: { status: "not_found" } },
    });
    draw(fetchStub);

    await openRun();

    expect(await screen.findByRole("alert")).toHaveTextContent("not_found");
    expect(screen.queryByRole("region", { name: "Approval inbox" })).toBeNull();
  });

  test("a run that loads but whose gates do not is an error, not zero gates", async () => {
    const { fetchStub } = stubApi({
      "/v1/runs/run_1": { body: RUN },
      "/v1/runs/run_1/approvals": {
        status: 500,
        body: { code: "INTERNAL", message: "store unavailable" },
      },
    });
    draw(fetchStub);

    await openRun();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "store unavailable",
    );
    expect(screen.queryByRole("region", { name: "Approval inbox" })).toBeNull();
  });
});

describe("a decision goes to the control plane and the screen is re-read", () => {
  test("approving posts the decision for that run and gate", async () => {
    const { fetchStub, calls } = stubApi({
      "/v1/runs/run_1": { body: RUN },
      "/v1/runs/run_1/approvals": { body: { pending: [GATE] } },
      "/v1/runs/run_1/approvals/apr_1/decision": { body: RUN },
    });
    draw(fetchStub);
    await openRun();

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    );

    expect(calls).toContainEqual({
      url: "POST /v1/runs/run_1/approvals/apr_1/decision",
      body: { decision: "approve" },
    });
  });

  test("the run is re-read after a decision rather than patched locally", async () => {
    const { fetchStub, calls } = stubApi({
      "/v1/runs/run_1": { body: RUN },
      "/v1/runs/run_1/approvals": { body: { pending: [GATE] } },
      "/v1/runs/run_1/approvals/apr_1/decision": { body: RUN },
    });
    draw(fetchStub);
    await openRun();

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    );

    await vi.waitFor(() => {
      expect(
        calls.filter((call) => call.url === "GET /v1/runs/run_1"),
      ).toHaveLength(2);
    });
  });

  test("a refused decision is reported on the gate", async () => {
    const { fetchStub } = stubApi({
      "/v1/runs/run_1": { body: RUN },
      "/v1/runs/run_1/approvals": { body: { pending: [GATE] } },
      "/v1/runs/run_1/approvals/apr_1/decision": {
        status: 409,
        body: {
          code: "DECISION_REFUSED",
          message: "Approval apr_1 is not pending.",
        },
      },
    });
    draw(fetchStub);
    await openRun();

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "DECISION_REFUSED",
    );
  });
});
