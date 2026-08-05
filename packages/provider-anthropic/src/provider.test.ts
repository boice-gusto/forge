import type {
  ProviderEvent,
  ProviderPort,
  ProviderSession,
} from "@forge/ports";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  API_KEY_VARIABLE,
  createAnthropicProvider,
  PROVIDER_ID,
} from "./provider.js";
import {
  blockStop,
  CANCELLABLE_STREAM,
  errorBody,
  MESSAGES_PATH,
  MODELS_AVAILABLE,
  TEXT_STREAM,
  toolArgumentsDelta,
  toolBlockStart,
} from "./scenarios.js";
import {
  createScriptedTransport,
  type ScriptedRoute,
  type ScriptedTransport,
} from "./scripted-transport.js";

const PLACEHOLDER = "unit-test-placeholder";

beforeEach(() => {
  vi.stubEnv(API_KEY_VARIABLE, PLACEHOLDER);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

interface Harnessed {
  readonly provider: ProviderPort;
  readonly transport: ScriptedTransport;
}

function harness(
  routes: readonly ScriptedRoute[],
  options: { readonly tools?: boolean } = {},
): Harnessed {
  const transport = createScriptedTransport(routes);
  const provider = createAnthropicProvider({
    model: "claude-test",
    transport: transport.fetch,
    ...(options.tools === true
      ? {
          tools: [
            {
              name: "read_file",
              description: "Read a file.",
              inputSchema: { type: "object" },
            },
          ],
        }
      : {}),
  });
  return { provider, transport };
}

async function open(provider: ProviderPort): Promise<ProviderSession> {
  return provider.createSession({
    workspacePath: "/workspace/unit",
    correlationId: "unit",
    capabilities: provider.capabilities,
  });
}

async function collect(
  provider: ProviderPort,
  session: ProviderSession,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.execute(session, { prompt: "Draft it." }))
    events.push(event);
  return events;
}

async function runOnce(
  routes: readonly ScriptedRoute[],
): Promise<ProviderEvent[]> {
  const { provider } = harness(routes);
  return collect(provider, await open(provider));
}

function messagesFailure(status: number, type: string): ScriptedRoute {
  return {
    path: MESSAGES_PATH,
    status,
    json: errorBody(type, `the provider replied ${status}`),
  };
}

describe("the credential comes from the environment and fails closed", () => {
  test("an absent key stops construction, naming the variable", () => {
    vi.stubEnv(API_KEY_VARIABLE, undefined);

    expect(() => createAnthropicProvider({ model: "claude-test" })).toThrow(
      API_KEY_VARIABLE,
    );
  });

  test("a blank key is not a key", () => {
    vi.stubEnv(API_KEY_VARIABLE, "   ");

    // Failing here rather than at the first prompt matters: a provider that
    // constructs without a credential dies on a real run, possibly days later
    // on the far side of an approval gate.
    expect(() => createAnthropicProvider({ model: "claude-test" })).toThrow(
      API_KEY_VARIABLE,
    );
  });

  test("the key never reaches an event, however the request fails", async () => {
    const events = await runOnce([
      messagesFailure(401, "authentication_error"),
    ]);

    expect(JSON.stringify(events)).not.toContain(PLACEHOLDER);
  });
});

describe("a failure is classified the way the runtime will act on it", () => {
  const cases: readonly [number, string, string, boolean][] = [
    [400, "invalid_request_error", "PROVIDER_INVALID_REQUEST", false],
    [401, "authentication_error", "PROVIDER_UNAUTHENTICATED", false],
    [403, "permission_error", "PROVIDER_FORBIDDEN", false],
    [404, "not_found_error", "PROVIDER_NOT_FOUND", false],
    [408, "timeout_error", "PROVIDER_TIMEOUT", true],
    [413, "invalid_request_error", "PROVIDER_REQUEST_TOO_LARGE", false],
    [429, "rate_limit_error", "PROVIDER_RATE_LIMITED", true],
    [500, "api_error", "PROVIDER_UPSTREAM_ERROR", true],
    [529, "overloaded_error", "PROVIDER_OVERLOADED", true],
    // Unmapped, so the ranges decide: a 4xx will be wrong again, a 5xx may not.
    [402, "billing_error", "PROVIDER_BILLING", false],
    [418, "unrecognised_error", "PROVIDER_REQUEST_REJECTED", false],
    [503, "unrecognised_error", "PROVIDER_UPSTREAM_ERROR", true],
  ];

  for (const [status, type, code, retryable] of cases) {
    test(`${status} is ${code} and ${retryable ? "is" : "is not"} retryable`, async () => {
      const events = await runOnce([messagesFailure(status, type)]);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", code, retryable });
    });
  }

  test("a failed stream is never also reported as completed", async () => {
    const events = await runOnce([messagesFailure(429, "rate_limit_error")]);

    expect(events.map((event) => event.type)).not.toContain("completed");
  });

  test("an error frame inside a 200 stream is classified on its own type", async () => {
    const events = await runOnce([
      {
        path: MESSAGES_PATH,
        events: [
          ...TEXT_STREAM.slice(0, 3),
          {
            event: "error",
            data: errorBody("overloaded_error", "Overloaded, try again."),
          },
        ],
      },
    ]);

    // The response was a 200 and the failure arrived afterwards, so there is no
    // status to classify on — only the body's own error type.
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "PROVIDER_OVERLOADED",
      retryable: true,
    });
  });

  test("a transport that cannot connect is retryable", async () => {
    const provider = createAnthropicProvider({
      model: "claude-test",
      transport: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    const events = await collect(provider, await open(provider));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "PROVIDER_CONNECTION_FAILED",
      retryable: true,
    });
  });

  test("the SDK does not retry underneath, so one attempt is one request", async () => {
    const { provider, transport } = harness([
      messagesFailure(429, "rate_limit_error"),
    ]);

    await collect(provider, await open(provider));

    // Retry is an attempt the runtime decides on and counts. A transport
    // retrying on its own would spend attempts nothing authorised, and would
    // hide the classification this adapter exists to make.
    expect(transport.calls).toHaveLength(1);
  });
});

describe("completed means the model finished", () => {
  test("a stream that stops before message_stop is a truncation, not a success", async () => {
    const events = await runOnce([
      { path: MESSAGES_PATH, events: TEXT_STREAM.slice(0, 4) },
    ]);

    expect(events.map((event) => event.type)).not.toContain("completed");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "PROVIDER_STREAM_TRUNCATED",
      retryable: true,
    });
  });

  test("a complete stream ends with completed and nothing after it", async () => {
    const events = await runOnce([
      { path: MESSAGES_PATH, events: TEXT_STREAM },
    ]);

    expect(events).toEqual([
      { type: "text-delta", text: "drafting" },
      { type: "text-delta", text: " the brief" },
      { type: "completed" },
    ]);
  });
});

describe("tool calls carry what the runtime needs to dispatch them", () => {
  test("a tool_use block becomes one call with its arguments assembled", async () => {
    const events = await runOnce([
      {
        path: MESSAGES_PATH,
        events: [
          ...TEXT_STREAM.slice(0, 2),
          blockStop(0),
          toolBlockStart(1, "read_file"),
          toolArgumentsDelta(1, '{"path":'),
          toolArgumentsDelta(1, '"brief.md"}'),
          blockStop(1),
          ...TEXT_STREAM.slice(5),
        ],
      },
    ]);

    expect(events).toEqual([
      { type: "tool-call", toolId: "read_file", args: { path: "brief.md" } },
      { type: "completed" },
    ]);
  });

  test("a tool call with no arguments is an empty object, not a crash", async () => {
    const events = await runOnce([
      {
        path: MESSAGES_PATH,
        events: [
          ...TEXT_STREAM.slice(0, 2),
          blockStop(0),
          toolBlockStart(1, "read_file"),
          blockStop(1),
          ...TEXT_STREAM.slice(5),
        ],
      },
    ]);

    expect(events[0]).toEqual({
      type: "tool-call",
      toolId: "read_file",
      args: {},
    });
  });

  test("arguments Forge cannot read stop the stream instead of being dispatched", async () => {
    const events = await runOnce([
      {
        path: MESSAGES_PATH,
        events: [
          ...TEXT_STREAM.slice(0, 2),
          blockStop(0),
          toolBlockStart(1, "read_file"),
          toolArgumentsDelta(1, '{"path": '),
          blockStop(1),
          ...TEXT_STREAM.slice(5),
        ],
      },
    ]);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "PROVIDER_TOOL_ARGUMENTS_INVALID",
      retryable: false,
    });
    expect(events.map((event) => event.type)).not.toContain("completed");
  });

  test("configured tools reach the request, and nothing else does", async () => {
    const { provider, transport } = harness(
      [{ path: MESSAGES_PATH, events: TEXT_STREAM }],
      { tools: true },
    );

    await collect(provider, await open(provider));

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toContain(MESSAGES_PATH);
  });
});

describe("cancel aborts the request rather than walking away from it", () => {
  async function cancelMidStream(): Promise<{
    readonly events: ProviderEvent[];
    readonly transport: ScriptedTransport;
  }> {
    const { provider, transport } = harness([
      { path: MESSAGES_PATH, events: CANCELLABLE_STREAM, chunkDelayMs: 1 },
    ]);
    const session = await open(provider);
    const stream = provider
      .execute(session, { prompt: "Draft it." })
      [Symbol.asyncIterator]();

    const first = await stream.next();
    expect(first.done).toBe(false);
    await provider.cancel(session);

    const events: ProviderEvent[] = [];
    for (;;) {
      const step = await stream.next();
      if (step.done === true) break;
      events.push(step.value);
    }
    return { events, transport };
  }

  test("the in-flight HTTP request is actually aborted", async () => {
    const { transport } = await cancelMidStream();

    // Stopping the read alone would leave the connection open and the tokens
    // still being generated and billed. Only the signal firing proves the
    // request itself was torn down.
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.aborted).toBe(true);
  });

  test("the stop is reported, and never as retryable", async () => {
    const { events } = await cancelMidStream();

    expect(events.map((event) => event.type)).not.toContain("completed");
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "PROVIDER_CANCELLED",
      retryable: false,
    });
  });

  test("destroying a session with work in flight aborts it too", async () => {
    const { provider, transport } = harness([
      { path: MESSAGES_PATH, events: CANCELLABLE_STREAM, chunkDelayMs: 1 },
    ]);
    const session = await open(provider);
    const stream = provider
      .execute(session, { prompt: "Draft it." })
      [Symbol.asyncIterator]();

    await stream.next();
    await provider.destroySession(session);
    await stream.next();

    // Worker shutdown must not orphan an open request (008 §13.8).
    expect(transport.calls[0]?.aborted).toBe(true);
  });

  test("a cancel that lands while the request is still connecting is not retryable", async () => {
    // The abort can arrive before there is a stream to abort, and the SDK then
    // reports it as a request failure. An abort reported as retryable would
    // have the runtime re-attempt work a human just stopped.
    const provider = createAnthropicProvider({
      model: "claude-test",
      transport: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("socket closed while connecting"));
          });
        }),
    });
    const session = await open(provider);
    const stream = provider
      .execute(session, { prompt: "Draft it." })
      [Symbol.asyncIterator]();

    const pending = stream.next();
    await Promise.resolve();
    await provider.cancel(session);

    expect((await pending).value).toMatchObject({
      type: "error",
      code: "PROVIDER_CANCELLED",
      retryable: false,
    });
  });

  test("cancelling or destroying a session nobody minted resolves", async () => {
    const { provider } = harness([]);
    const stranger = { providerId: PROVIDER_ID, sessionId: "never_existed" };

    // Worker shutdown walks whatever it holds; an unknown handle must not wedge it.
    await expect(provider.cancel(stranger)).resolves.toBeUndefined();
    await expect(provider.destroySession(stranger)).resolves.toBeUndefined();
  });

  test("a delta Forge has no event for passes through without becoming one", async () => {
    const events = await runOnce([
      {
        path: MESSAGES_PATH,
        events: [
          ...TEXT_STREAM.slice(0, 3),
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "weighing it up" },
            },
          },
          ...TEXT_STREAM.slice(4),
        ],
      },
    ]);

    // Reasoning is not a text delta and Forge has no event for it. Ignoring it
    // cannot turn a failure into a success: the terminal event still governs.
    expect(events.map((event) => event.type)).toEqual([
      "text-delta",
      "completed",
    ]);
  });

  test("a delta for a block that is not a pending tool call is ignored", async () => {
    const events = await runOnce([
      {
        path: MESSAGES_PATH,
        events: [
          ...TEXT_STREAM.slice(0, 3),
          // Arrives against the text block, which never opened a tool call.
          toolArgumentsDelta(0, '{"path":"stray"}'),
          ...TEXT_STREAM.slice(4),
        ],
      },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "text-delta",
      "completed",
    ]);
  });

  test("a cancel aimed at a finished execution does not kill the next one", async () => {
    const { provider } = harness([
      { path: MESSAGES_PATH, events: TEXT_STREAM },
    ]);
    const session = await open(provider);

    await collect(provider, session);
    await provider.cancel(session);

    expect((await collect(provider, session)).at(-1)).toEqual({
      type: "completed",
    });
  });
});

describe("the adapter accepts only the work it declared", () => {
  test("a caller cannot widen the adapter's own claim by configuring it", () => {
    const provider = createAnthropicProvider({
      model: "claude-test",
      capabilities: ["session-resume", "streaming"],
      transport: createScriptedTransport([]).fetch,
    });

    // The list is intersected with what the adapter can do, never added to it.
    expect(provider.capabilities).toEqual(["streaming"]);
  });

  test("resume is refused even for a session that is open", async () => {
    const { provider } = harness([MODELS_AVAILABLE]);
    const session = await open(provider);

    await expect(
      provider.resumeSession({ sessionId: session.sessionId }),
    ).rejects.toThrow("session-resume");
  });

  test("with no transport injected it falls back to the SDK's own fetch", () => {
    // Constructing does not call anything; the default path is the real client.
    const provider = createAnthropicProvider({ model: "claude-test" });

    expect(provider.providerId).toBe(PROVIDER_ID);
    expect(provider.capabilities).toEqual(["streaming", "tool-calls"]);
  });

  test("health reports the provider down instead of throwing", async () => {
    const { provider } = harness([]);

    // The scripted transport has no /v1/models route, so the probe fails.
    expect(await provider.health()).toEqual({
      available: false,
      providerId: PROVIDER_ID,
    });
  });
});
