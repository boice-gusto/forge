import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { loadDeploymentPolicy } from "@forge/company";
import {
  createLocalStack,
  type LocalStack,
  type LocalStackOptions,
} from "@forge/composition";
import { ANY_ROLE, type RunStatus, STOPPED_RUN_STATUSES } from "@forge/ports";
import { afterEach, describe, expect, test } from "vitest";

import { createDevelopmentIdentity } from "./identity-development.js";
import { createApiApp } from "./main.js";

/**
 * `GET /v1/runs/:runId/events` as a stream (012 §4.3).
 *
 * Over a real socket on a real port, not `inject`. A tail is a response that
 * has not finished, and the only honest way to show one is delivering is to
 * hold a connection open and watch a record arrive on it that did not exist
 * when the connection was made. An injected request that resolves to a buffer
 * proves the opposite of what is wanted here: that the response ended.
 *
 * Port 0, so the kernel chooses. A suite that named a port could not run twice
 * at once, and would happily adopt whatever was already listening.
 */

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../examples/acme/workflows/campaign-brief.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  workflow: unknown;
  capabilities: string[];
  panel: NonNullable<LocalStackOptions["panel"]>;
  review: { votes: ReturnType<NonNullable<LocalStackOptions["votesFor"]>> };
  branch: Record<string, string>;
  changedPaths: string[];
};

const acme = await loadDeploymentPolicy({
  root: fileURLToPath(new URL("../../../examples/acme", import.meta.url)),
  hostCapabilities: ["repo.read", "docs.write", "slack.write"],
  forgeVersion: "0.1.0",
});

const BEARER = "local-test";
const AUTH = { authorization: `Bearer ${BEARER}` };

const startBody = {
  workflow: fixture.workflow,
  capabilities: fixture.capabilities,
  changedPaths: fixture.changedPaths,
};

function acmeStack(overrides: LocalStackOptions = {}): LocalStack {
  return createLocalStack({
    rules: acme.rules,
    grants: acme.grants,
    environment: "production",
    panel: fixture.panel,
    votesFor: () => fixture.review.votes,
    branchFor: (nodeId: string) => fixture.branch[nodeId],
    ...overrides,
  });
}

/** Everything a test opened, closed after it whether or not it passed. */
const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
  // Last opened, first closed: a server asked to shut down while a stream is
  // still attached to it is a wait on a connection that by design does not end.
  for (const close of opened.splice(0).reverse()) await close();
});

/** A listening control plane, and the origin to reach it at. */
async function serving(stack: LocalStack): Promise<string> {
  const app = createApiApp({
    build: { version: "0.1.0", gitSha: "test", buildTime: "2026-01-01" },
    dependencies: { queue: "healthy", persistence: "healthy" },
    identity: createDevelopmentIdentity([
      { subject: "marketing-lead", secret: BEARER, roles: [ANY_ROLE] },
    ]),
    stack,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  opened.push(async () => {
    await app.close();
  });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

interface Delivered {
  readonly id: string;
  readonly seq: number;
  readonly name: string;
  readonly kind: string;
}

/**
 * One open SSE connection, decoded frame by frame.
 *
 * The wire is parsed here rather than through `@forge/sdk`, on purpose: a test
 * that read our own server with our own client could pass with both halves
 * agreeing on a format nothing else speaks.
 */
async function tail(
  url: string,
  headers: Record<string, string> = AUTH,
): Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly received: readonly Delivered[];
  /** Resolves when the server ends the stream. */
  readonly ended: Promise<void>;
  waitFor(
    condition: (received: readonly Delivered[]) => boolean,
    what: string,
  ): Promise<void>;
  close(): Promise<void>;
}> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });

  const received: Delivered[] = [];
  const read = (async () => {
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      for (
        let end = buffered.indexOf("\n\n");
        end !== -1;
        end = buffered.indexOf("\n\n")
      ) {
        const chunk = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const id = /^id: (.*)$/m.exec(chunk)?.[1] ?? "";
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (data === undefined) continue;
        received.push({ id, ...(JSON.parse(data) as Omit<Delivered, "id">) });
      }
    }
  })().catch(() => {});

  const close = async () => {
    controller.abort();
    await read;
  };
  opened.push(close);

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    received,
    ended: read,
    async waitFor(condition, what) {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (condition(received)) return;
        await new Promise((settle) => setTimeout(settle, 20));
      }
      throw new Error(
        `The stream never ${what}. It delivered: ${received
          .map((event) => event.name)
          .join(", ")}`,
      );
    },
    close,
  };
}

const named = (received: readonly Delivered[], name: string): boolean =>
  received.some((event) => event.name === name);

async function post(
  origin: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function getRun(origin: string, runId: string): Promise<ParkedRun> {
  return (await (
    await fetch(`${origin}/v1/runs/${runId}`, { headers: AUTH })
  ).json()) as ParkedRun;
}

/**
 * One definition, in `@forge/ports`. This copy was missing `CANCELLED` — the
 * drift these constants exist to stop, sitting in the tree unnoticed.
 */
const SETTLED = STOPPED_RUN_STATUSES;

interface ParkedRun {
  readonly runId: string;
  readonly status: string;
  readonly pendingApprovalId: string;
}

async function startAndPark(origin: string): Promise<ParkedRun> {
  const accepted = (await (
    await post(origin, "/v1/runs", startBody)
  ).json()) as ParkedRun;
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const run = await getRun(origin, accepted.runId);
    if (SETTLED.has(run.status as RunStatus)) return run;
    await new Promise((settle) => setTimeout(settle, 1));
  }
  throw new Error(`Run ${accepted.runId} never settled.`);
}

/**
 * A provider that will not answer until it is let go, so the walk can be held
 * *before* the gate — which is the only way to open a stream on a run whose
 * gate does not exist yet.
 */
function latched() {
  let release: (() => void) | undefined;
  const answered = new Promise<void>((settle) => {
    release = settle;
  });
  return {
    release: () => release?.(),
    provider: {
      providerId: "latched",
      capabilities: ["streaming"] as const,
      async createSession() {
        await answered;
        return { sessionId: "session_1", providerId: "latched" };
      },
      async resumeSession(input: { sessionId: string }) {
        return { sessionId: input.sessionId, providerId: "latched" };
      },
      async *execute() {
        yield { type: "completed" } as const;
      },
      async cancel() {},
      async destroySession() {},
      async health() {
        return { available: true, providerId: "latched" };
      },
    },
  };
}

describe("an operator watching a run sees it move, without asking again", () => {
  test("a gate that did not exist when the stream opened is delivered on it", async () => {
    /**
     * The assertion the whole feature is for, and the one a weaker test
     * quietly avoids: "some events arrived" passes against a stream that
     * replays history and then goes silent forever. So the run is held before
     * its gate, the connection is made, the *absence* of the gate is asserted
     * on that connection, and only then is the walk released.
     */
    const latch = latched();
    const stack = acmeStack({ provider: latch.provider });
    const origin = await serving(stack);

    const accepted = (await (
      await post(origin, "/v1/runs", startBody)
    ).json()) as ParkedRun;
    const stream = await tail(`${origin}/v1/runs/${accepted.runId}/events`);

    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain("text/event-stream");

    // The history so far, which reaches the agent and stops there.
    await stream.waitFor(
      (received) => named(received, "forge.node.agent"),
      "delivered the history it opened with",
    );
    expect(named(stream.received, "forge.approval.requested")).toBe(false);

    latch.release();

    await stream.waitFor(
      (received) => named(received, "forge.approval.requested"),
      "delivered the gate",
    );
  });

  test("a decision recorded after the connection is delivered on it too", async () => {
    // The other half of the change: a decision returns before the run
    // advances, so the stream is what tells the operator it did.
    const stack = acmeStack();
    const origin = await serving(stack);
    const parked = await startAndPark(origin);

    const stream = await tail(`${origin}/v1/runs/${parked.runId}/events`);
    await stream.waitFor(
      (received) => named(received, "forge.approval.requested"),
      "delivered the history it opened with",
    );
    expect(named(stream.received, "forge.effect.dispatched")).toBe(false);

    const decided = await post(
      origin,
      `/v1/runs/${parked.runId}/approvals/${parked.pendingApprovalId}/decision`,
      { decision: "approve" },
    );
    expect(decided.status).toBe(202);

    await stream.waitFor(
      (received) => named(received, "forge.effect.dispatched"),
      "delivered the dispatch",
    );
    // And the run really did advance elsewhere, not inside the request.
    expect((await getRun(origin, parked.runId)).status).toBe("SUCCEEDED");
  });

  test("what the stream delivers is exactly what the snapshot serves", async () => {
    // Two representations of one resource. If they could differ, the timeline
    // an operator watches and the timeline they reload would be two stories.
    const origin = await serving(acmeStack());
    const parked = await startAndPark(origin);

    const stream = await tail(`${origin}/v1/runs/${parked.runId}/events`);
    const snapshot = (await (
      await fetch(`${origin}/v1/runs/${parked.runId}/events`, {
        headers: AUTH,
      })
    ).json()) as { events: { seq: number; kind: string }[] };

    await stream.waitFor(
      (received) => received.length >= snapshot.events.length,
      "delivered the whole history",
    );
    expect(stream.received.map((event) => event.seq)).toEqual(
      snapshot.events.map((event) => event.seq),
    );
    expect(stream.received.map((event) => event.kind)).toEqual(
      snapshot.events.map((event) => event.kind),
    );
    // `id:` is the store's sequence, which is what makes resumption mean
    // "after this record" rather than "somewhere around here".
    expect(stream.received.map((event) => event.id)).toEqual(
      stream.received.map((event) => String(event.seq)),
    );
  });

  test("the same URL without the header is still the snapshot", async () => {
    // Content negotiation, so nothing that reads this route today changes.
    const origin = await serving(acmeStack());
    const parked = await startAndPark(origin);

    const response = await fetch(`${origin}/v1/runs/${parked.runId}/events`, {
      headers: { ...AUTH, accept: "*/*" },
    });

    const body = (await response.json()) as { events: unknown[] };
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.events.length).toBeGreaterThan(0);
  });

  test("Last-Event-ID resumes after a record rather than replaying it", async () => {
    const origin = await serving(acmeStack());
    const parked = await startAndPark(origin);
    const snapshot = (await (
      await fetch(`${origin}/v1/runs/${parked.runId}/events`, { headers: AUTH })
    ).json()) as { events: { seq: number }[] };
    const half = snapshot.events[2]?.seq ?? 0;

    const stream = await tail(`${origin}/v1/runs/${parked.runId}/events`, {
      ...AUTH,
      "last-event-id": String(half),
    });
    await stream.waitFor(
      (received) => received.length === snapshot.events.length - 3,
      "delivered only what followed the cursor",
    );

    expect(stream.received.every((event) => event.seq > half)).toBe(true);
  });
});

describe("a stream is not a way around the check the snapshot passes", () => {
  test("every credential gets the same answer from both representations", async () => {
    const origin = await serving(acmeStack());
    const parked = await startAndPark(origin);

    const cases: readonly [string, string, Record<string, string>, number][] = [
      ["no credential", parked.runId, {}, 401],
      [
        "a credential the directory does not know",
        parked.runId,
        { authorization: "Bearer not-a-real-credential" },
        401,
      ],
      ["a run that does not exist", "run_nope", AUTH, 404],
    ];

    for (const [why, runId, headers, code] of cases) {
      const url = `${origin}/v1/runs/${runId}/events`;
      const snapshot = await fetch(url, { headers });
      const streamed = await fetch(url, {
        headers: { ...headers, accept: "text/event-stream" },
      });
      // Read the bodies so the sockets are not left open.
      await snapshot.text();
      await streamed.text();

      expect(`${why} snapshot ${snapshot.status}`).toBe(
        `${why} snapshot ${code}`,
      );
      expect(`${why} stream ${streamed.status}`).toBe(`${why} stream ${code}`);
      // And a refusal is a refusal, not an empty stream held open.
      expect(streamed.headers.get("content-type")).not.toContain(
        "text/event-stream",
      );
    }
  });

  test("a session revoked mid-stream stops the stream", async () => {
    /**
     * A snapshot answers and is gone, so its check is a moment. A stream lasts
     * as long as the operator leaves the tab open, and "authenticated once, an
     * hour ago" is not the same claim. Signing out has to reach the socket, or
     * a revoked session keeps reading the run for as long as it is held.
     */
    const origin = await serving(acmeStack());
    const parked = await startAndPark(origin);

    const login = await post(
      origin,
      "/v1/auth/session",
      { credential: { kind: "operator-secret", value: BEARER } },
      {},
    );
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { csrfToken } = (await login.json()) as { csrfToken: string };

    const stream = await tail(`${origin}/v1/runs/${parked.runId}/events`, {
      cookie,
    });
    await stream.waitFor(
      (received) => received.length > 0,
      "delivered anything at all",
    );

    await fetch(`${origin}/v1/auth/session`, {
      method: "DELETE",
      headers: { cookie, "x-forge-csrf": csrfToken },
    });

    // The server ends it; nothing was aborted from this side.
    await stream.ended;
  });
});

describe("a closed stream stops reading", () => {
  test("the tail asks the store nothing once the client has gone", async () => {
    /**
     * The leak a stream makes easy: the reader disconnects, the poll does not
     * notice, and the process keeps querying for a run nobody is watching —
     * once per open tab, forever. Counted at the store, because that is where
     * the cost actually lands.
     */
    const stack = acmeStack();
    let reads = 0;
    const counting: LocalStack["runEvents"] = {
      append: (event) => stack.runEvents.append(event),
      close: (seq, attributes) => stack.runEvents.close(seq, attributes),
      list: (runId) => {
        reads += 1;
        return stack.runEvents.list(runId);
      },
    };
    const origin = await serving({ ...stack, runEvents: counting });
    const parked = await startAndPark(origin);

    const stream = await tail(`${origin}/v1/runs/${parked.runId}/events`);
    await stream.waitFor(
      (received) => received.length > 0,
      "delivered anything at all",
    );
    await stream.close();

    // Long enough for several more polls, had anything still been polling.
    const settled = reads;
    await new Promise((wait) => setTimeout(wait, 900));
    expect(reads).toBe(settled);
  });
});
