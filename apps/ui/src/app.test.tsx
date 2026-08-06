// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { createForgeClient } from "@forge/sdk";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ForgeApp } from "./app.js";

afterEach(cleanup);

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const FINGERPRINT = "sha256:9f2c4b1ad0e7315c8a6b2fd41e0c93875ab6d2e10f4c7b93a";
const BINDING =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

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
  effectHash: BINDING,
  policyId: "pol_external_publish",
  approvers: ["marketing-lead"],
  expiresAt: "2026-01-01T12:30:00.000Z",
  status: "PENDING",
  createdAt: "2026-01-01T11:30:00.000Z",
};

const OTHER_GATE = {
  ...GATE,
  approvalId: "apr_9",
  runId: "run_7",
  nodeId: "wire",
  effect: "payments.send",
};

const DECIDED_GATE = {
  ...GATE,
  status: "REJECTED",
  decidedBy: "marketing-lead",
  decidedAt: "2026-01-01T11:45:00.000Z",
  reason: "off brand",
};

const EVENTS = [
  {
    seq: 0,
    at: "2026-01-01T11:58:00.000Z",
    kind: "approval",
    name: "forge.approval.requested",
    attributes: {
      runId: "run_1",
      nodeId: "publish",
      effect: "slack.post",
      effectHash: BINDING,
      expiresAt: "2026-01-01T12:30:00.000Z",
    },
  },
];

interface Route {
  readonly status?: number;
  /** What the *stream* form of this route answers, when it differs. */
  readonly streamStatus?: number;
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
  /**
   * The open tails. A test drives them with `push`, which is what makes "the
   * screen learns about a record that did not exist when it connected"
   * something this suite can actually assert — as opposed to "the snapshot it
   * already had is still on screen", which passes against no stream at all.
   */
  const tails: ReadableStreamDefaultController<Uint8Array>[] = [];
  const resumedFrom: (string | undefined)[] = [];
  let closed = 0;
  /** Set to hold a stream connection open before it is answered. */
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;

  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const path = url.slice(url.indexOf("/v1"));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const streaming = headers.accept === "text/event-stream";
    calls.push({
      url: `${init?.method ?? "GET"} ${path}${streaming ? " (stream)" : ""}`,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const route = routes[path];
    if (route === undefined)
      return new Response(JSON.stringify({ status: "not_found" }), {
        status: 404,
      });

    if (streaming) {
      const code = route.streamStatus ?? route.status ?? 200;
      if (code !== 200) {
        return new Response(JSON.stringify(route.body), { status: code });
      }
      if (held !== undefined) await held;
      resumedFrom.push(headers["last-event-id"]);
      // Opens delivering nothing. The control plane replays from the cursor
      // the client sent, and the client sent the snapshot it already holds.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            tails.push(controller);
            // What the server sees when the client hangs up. The stub honours
            // the signal because that is the only thing a client can do to
            // end a stream, and "did it?" is otherwise unanswerable.
            init?.signal?.addEventListener("abort", () => {
              closed += 1;
              tails.splice(tails.indexOf(controller), 1);
              try {
                controller.close();
              } catch {}
            });
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }

    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
    });
  };

  return {
    fetchStub: fetchStub as unknown as typeof globalThis.fetch,
    calls,
    resumedFrom,
    /** How many tails the client has hung up on. */
    cancelled: () => closed,
    /** Make the next stream connection wait, so a test can outrun it. */
    hold() {
      held = new Promise<void>((settle) => {
        release = settle;
      });
    },
    releaseStream() {
      release?.();
      held = undefined;
    },
    /** Emit a record on every open tail, as the control plane would. */
    push(event: unknown) {
      const frame = new TextEncoder().encode(
        `data: ${JSON.stringify(event)}\n\n`,
      );
      for (const tail of tails) tail.enqueue(frame);
    },
  };
}

/** A control plane with one gated run, wired end to end. */
function wholeEstate(overrides: Readonly<Record<string, Route>> = {}) {
  return stubApi({
    "/v1/approvals": { body: { pending: [GATE] } },
    "/v1/runs/run_1": { body: RUN },
    "/v1/runs/run_1/approvals": {
      body: { pending: [GATE], approvals: [GATE] },
    },
    "/v1/runs/run_1/events": { body: { events: EVENTS } },
    "/v1/runs/run_1/approvals/apr_1/decision": { body: RUN },
    ...overrides,
  });
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

describe("the inbox arrives without a run id, because an operator does", () => {
  test("gates load on their own and span more than one run", async () => {
    const { fetchStub, calls } = wholeEstate({
      "/v1/approvals": { body: { pending: [GATE, OTHER_GATE] } },
    });
    draw(fetchStub);

    const inbox = await screen.findByRole("region", { name: "Approval inbox" });

    expect(calls).toContainEqual({ url: "GET /v1/approvals", body: undefined });
    expect(
      within(inbox).getByText(/2 gates waiting on you, across 2 runs/),
    ).toBeInTheDocument();
  });

  test("no run has been opened, so nothing has been fetched for one", async () => {
    const { fetchStub, calls } = wholeEstate();
    draw(fetchStub);

    await screen.findByRole("region", { name: "Approval inbox" });

    expect(calls.map((call) => call.url)).toEqual(["GET /v1/approvals"]);
    expect(screen.queryByRole("region", { name: "Run inspector" })).toBeNull();
  });

  test("an operator sees the exact binding they are authorising", async () => {
    const { fetchStub } = wholeEstate();
    draw(fetchStub);

    const inbox = await screen.findByRole("region", { name: "Approval inbox" });

    // The binding, not the run fingerprint: the fingerprint names the compiled
    // workflow, the binding names the one action inside it.
    expect(within(inbox).getAllByText(BINDING).length).toBeGreaterThan(0);
    expect(within(inbox).queryByText(FINGERPRINT)).toBeNull();
  });

  test("an inbox that cannot load is an error, never an empty queue", async () => {
    const { fetchStub } = wholeEstate({
      "/v1/approvals": {
        status: 500,
        body: { code: "INTERNAL", message: "store unavailable" },
      },
    });
    draw(fetchStub);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "store unavailable",
    );
    expect(screen.queryByRole("region", { name: "Approval inbox" })).toBeNull();
  });
});

describe("opening a run shows its gates, its ledger and its events", () => {
  test("the inspector appears with the run's timeline", async () => {
    const { fetchStub } = wholeEstate();
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });

    await openRun();

    expect(
      await screen.findByRole("region", { name: "Run inspector" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Gate opened on publish for slack.post"),
    ).toBeInTheDocument();
  });

  test("a decided gate is still shown, with who decided it", async () => {
    const { fetchStub } = wholeEstate({
      "/v1/runs/run_1/approvals": {
        body: { pending: [], approvals: [DECIDED_GATE] },
      },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });

    await openRun();

    const gates = await screen.findByRole("list", { name: "Gates" });
    expect(
      within(gates).getByText(/Decided by marketing-lead/),
    ).toHaveTextContent("off brand");
  });

  test("nothing is fetched before a run id is given", async () => {
    const { fetchStub, calls } = wholeEstate();
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });

    await userEvent.click(screen.getByRole("button", { name: "Open run" }));

    expect(calls.map((call) => call.url)).toEqual(["GET /v1/approvals"]);
  });
});

describe("a control-plane failure is shown, never mistaken for an empty run", () => {
  test("an unknown run reports the error instead of an empty inspector", async () => {
    const { fetchStub } = wholeEstate({
      "/v1/runs/run_1": { status: 404, body: { status: "not_found" } },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });

    await openRun();

    expect(await screen.findByRole("alert")).toHaveTextContent("not_found");
    expect(screen.queryByRole("region", { name: "Run inspector" })).toBeNull();
  });

  test("a run whose gates do not load is an error, not zero gates", async () => {
    const { fetchStub } = wholeEstate({
      "/v1/runs/run_1/approvals": {
        status: 500,
        body: { code: "INTERNAL", message: "gates unavailable" },
      },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });

    await openRun();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "gates unavailable",
    );
    expect(screen.queryByRole("region", { name: "Run inspector" })).toBeNull();
  });

  test("a run whose events do not load is an error, not an empty timeline", async () => {
    const { fetchStub } = wholeEstate({
      "/v1/runs/run_1/events": {
        status: 500,
        body: { code: "INTERNAL", message: "events unavailable" },
      },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });

    await openRun();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "events unavailable",
    );
    expect(screen.queryByRole("region", { name: "Run inspector" })).toBeNull();
  });
});

/**
 * The run inspector tails its run (012 §4.3). Two things made this necessary:
 * the run walks in another process, and a decision now returns before it has
 * advanced — so the screen has no local moment at which the answer is known.
 */
describe("an open run keeps up with itself", () => {
  const DISPATCHED = {
    seq: 4,
    at: "2026-01-01T12:01:00.000Z",
    kind: "effect",
    name: "forge.effect.dispatched",
    attributes: { runId: "run_1", nodeId: "publish", effect: "slack.post" },
  };

  const TRANSITION = {
    seq: 5,
    at: "2026-01-01T12:01:01.000Z",
    kind: "run",
    name: "forge.run.transition",
    attributes: { runId: "run_1", from: "RUNNING", to: "SUCCEEDED" },
  };

  test("a record written after the screen connected appears on the timeline", async () => {
    // The assertion that separates a tail from a replay. Nothing about the
    // snapshot changes; a record that did not exist when the connection was
    // made has to arrive on it.
    const { fetchStub, push } = wholeEstate();
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    await screen.findByRole("region", { name: "Run inspector" });

    expect(
      screen.queryByText(/Effect slack.post dispatched at publish/),
    ).toBeNull();

    push(DISPATCHED);

    expect(
      await screen.findByText(/Effect slack.post dispatched at publish/),
    ).toBeInTheDocument();
  });

  test("the tail resumes from the snapshot, so history is not shown twice", async () => {
    const { fetchStub, resumedFrom } = wholeEstate();
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    await screen.findByRole("region", { name: "Run inspector" });

    // `EVENTS` ends at seq 0, which is where the snapshot left the screen.
    await vi.waitFor(() => {
      expect(resumedFrom).toEqual(["0"]);
    });
  });

  test("a run event re-reads the record rather than being believed", async () => {
    // The stream says *when*; the control plane says *what*. A screen that
    // read a status out of an event attribute would be a second, weaker copy
    // of the lifecycle — and the effect ledger is only on the record.
    let served: Record<string, unknown> = RUN;
    const { fetchStub, push } = stubApi({
      "/v1/approvals": { body: { pending: [] } },
      "/v1/runs/run_1": {
        get body() {
          return served;
        },
      },
      "/v1/runs/run_1/approvals": { body: { pending: [], approvals: [GATE] } },
      "/v1/runs/run_1/events": { body: { events: EVENTS } },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    const inspector = await screen.findByRole("region", {
      name: "Run inspector",
    });
    expect(
      within(inspector).getAllByText("AWAITING_APPROVAL").length,
    ).toBeGreaterThan(0);

    served = {
      ...RUN,
      status: "SUCCEEDED",
      performedEffects: ["draft", "publish"],
      pendingApprovalId: undefined,
    };
    push(TRANSITION);

    // The status and the ledger both come from the record, not the event.
    expect(await screen.findAllByText("SUCCEEDED")).not.toHaveLength(0);
    const ledger = await screen.findByRole("list", {
      name: "Effects dispatched",
    });
    expect(within(ledger).getByText("publish")).toBeInTheDocument();
  });

  test("a record the screen already holds is not listed twice", async () => {
    // A reload underneath an open tail, or a redelivered frame, must not put
    // the same entry on the timeline again — React would also key it twice.
    const { fetchStub, push } = wholeEstate();
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    await screen.findByRole("region", { name: "Run inspector" });

    push(DISPATCHED);
    await screen.findByText(/Effect slack.post dispatched at publish/);
    push(DISPATCHED);

    await vi.waitFor(() => {
      expect(
        screen.getAllByText(/Effect slack.post dispatched at publish/),
      ).toHaveLength(1);
    });
  });

  test("a re-read that fails leaves the last good record on screen", async () => {
    // The record is what carries the status and the ledger. A refresh the
    // control plane refused must not blank them: an operator reading "no
    // effects dispatched" because a GET timed out is being told something
    // untrue about what reached the outside world.
    let failing = false;
    const { fetchStub, push } = stubApi({
      "/v1/approvals": { body: { pending: [] } },
      "/v1/runs/run_1": {
        get status() {
          return failing ? 500 : 200;
        },
        get body() {
          return failing ? { code: "INTERNAL", message: "gone" } : RUN;
        },
      },
      "/v1/runs/run_1/approvals": { body: { pending: [], approvals: [GATE] } },
      "/v1/runs/run_1/events": { body: { events: EVENTS } },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    const inspector = await screen.findByRole("region", {
      name: "Run inspector",
    });

    failing = true;
    push(TRANSITION);
    await screen.findByText(/Run RUNNING → SUCCEEDED/);

    // The timeline moved; the record did not, and it is still the old one
    // rather than an empty inspector.
    expect(
      within(inspector).getAllByText("AWAITING_APPROVAL").length,
    ).toBeGreaterThan(0);
  });

  test("a stream the control plane refuses leaves the rest of the screen alone", async () => {
    // A tail is an enhancement over a snapshot the screen already has. Losing
    // it must not turn a correct run inspector into an error banner.
    const { fetchStub } = wholeEstate({
      // The snapshot still answers; only the tail is refused.
      "/v1/runs/run_1/events": { streamStatus: 403, body: { events: EVENTS } },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();

    expect(
      await screen.findByRole("region", { name: "Run inspector" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a stream that arrives after the screen is gone is closed at once", async () => {
    // The connection is asynchronous and the operator is not. Between asking
    // for a tail and getting one, they can navigate away — and the handle
    // arrives with nobody left to close it.
    const { fetchStub, cancelled, hold, releaseStream } = wholeEstate();
    hold();
    const { unmount } = render(
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
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    await screen.findByRole("region", { name: "Run inspector" });

    unmount();
    expect(cancelled()).toBe(0);
    releaseStream();

    await vi.waitFor(() => {
      expect(cancelled()).toBe(1);
    });
  });

  test("leaving the screen closes the stream it opened", async () => {
    // A tab left open on a run nobody is watching is a connection and a
    // server-side poll that never end — one per tab, forever. Unmounting has
    // to reach the socket, and only the socket can say whether it did.
    const { fetchStub, cancelled } = wholeEstate();
    const { unmount } = render(
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
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();
    await screen.findByRole("region", { name: "Run inspector" });
    expect(cancelled()).toBe(0);

    unmount();

    await vi.waitFor(() => {
      expect(cancelled()).toBe(1);
    });
  });
});

describe("a decision goes to the control plane and the screen is re-read", () => {
  async function approveFromInbox(): Promise<void> {
    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise slack.post" }),
    );
  }

  test("approving posts the decision for that run and gate", async () => {
    const { fetchStub, calls } = wholeEstate();
    draw(fetchStub);

    await approveFromInbox();

    expect(calls).toContainEqual({
      url: "POST /v1/runs/run_1/approvals/apr_1/decision",
      body: { decision: "approve" },
    });
  });

  test("the inbox is re-read after a decision rather than patched locally", async () => {
    const { fetchStub, calls } = wholeEstate();
    draw(fetchStub);

    await approveFromInbox();

    await vi.waitFor(() => {
      expect(
        calls.filter((call) => call.url === "GET /v1/approvals"),
      ).toHaveLength(2);
    });
  });

  test("an open run is re-read too, so its ledger cannot go stale", async () => {
    const { fetchStub, calls } = wholeEstate();
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();

    await approveFromInbox();

    await vi.waitFor(() => {
      expect(
        calls.filter((call) => call.url === "GET /v1/runs/run_1"),
      ).toHaveLength(2);
    });
  });

  test("deciding a gate on a run that is not open leaves the inspector alone", async () => {
    const { fetchStub, calls } = wholeEstate({
      "/v1/approvals": { body: { pending: [OTHER_GATE] } },
      "/v1/runs/run_7/approvals/apr_9/decision": { body: RUN },
    });
    draw(fetchStub);
    await screen.findByRole("region", { name: "Approval inbox" });
    await openRun();

    await userEvent.click(
      await screen.findByRole("button", { name: "Approve" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Yes, authorise payments.send" }),
    );

    await vi.waitFor(() => {
      expect(
        calls.filter((call) => call.url === "GET /v1/approvals"),
      ).toHaveLength(2);
    });
    expect(
      calls.filter((call) => call.url === "GET /v1/runs/run_1"),
    ).toHaveLength(1);
  });

  test("a refused decision is reported on the gate", async () => {
    const { fetchStub } = wholeEstate({
      "/v1/runs/run_1/approvals/apr_1/decision": {
        status: 409,
        body: {
          code: "DECISION_REFUSED",
          message: "Approval apr_1 is not pending.",
        },
      },
    });
    draw(fetchStub);

    await approveFromInbox();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "DECISION_REFUSED",
    );
  });
});
