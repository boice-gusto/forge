import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  CreateProviderSessionInput,
  ProviderCapability,
  ProviderEvent,
  ProviderExecutionRequest,
  ProviderPort,
  ProviderSession,
  ResumeProviderSessionInput,
} from "@forge/ports";

import { CANCELLED_CODE, classifyFailure, failure } from "./failure.js";
import type { AnthropicTransport } from "./scripted-transport.js";

export const PROVIDER_ID = "anthropic";

/**
 * The only place the credential is named. It is read from the environment and
 * nowhere else: never a literal, never a constructor default, never logged,
 * and never put on an event or a span.
 */
export const API_KEY_VARIABLE = "ANTHROPIC_API_KEY";

/**
 * `session-resume` is deliberately absent. The Messages API is stateless —
 * there is no server-side session to return to — so declaring it would let the
 * capability intersection in 008 §4 approve work this adapter cannot do. A
 * session here is a local lifecycle handle for cancellation and cleanup.
 */
const DECLARED: readonly ProviderCapability[] = ["streaming", "tool-calls"];

const DEFAULT_MAX_TOKENS = 4096;

/**
 * A tool the model may propose, in Forge's own shape. The vendor's `Tool` type
 * stops at this package's edge (008 §5.6), and the port carries no tool
 * definitions of its own, so tools are adapter configuration bound in a
 * composition root — exactly like the model id.
 */
export interface AnthropicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface AnthropicProviderOptions {
  readonly model: string;
  readonly maxTokens?: number;
  /**
   * Intersected with what the adapter can actually do, never added to it, so a
   * caller cannot widen the adapter's own claim by configuring it.
   */
  readonly capabilities?: readonly ProviderCapability[];
  readonly tools?: readonly AnthropicToolDefinition[];
  /** Defaults to the SDK's own `fetch`; supplied in tests and in CI. */
  readonly transport?: AnthropicTransport;
}

interface SessionState {
  readonly session: ProviderSession;
  status: "open" | "destroyed";
  cancelled: boolean;
  inFlight: AbortController | undefined;
}

interface PendingToolCall {
  readonly toolId: string;
  json: string;
}

const CANCELLED = failure(
  CANCELLED_CODE,
  "The session was cancelled before the stream completed.",
  false,
);

const SESSION_GONE = failure(
  "PROVIDER_SESSION_NOT_FOUND",
  "The session was destroyed or never existed.",
  false,
);

/**
 * A stream that stops before the model says it is done did not succeed, so it
 * is reported rather than closed with `completed`. A dropped connection is the
 * usual cause and a second attempt clears it.
 */
const TRUNCATED = failure(
  "PROVIDER_STREAM_TRUNCATED",
  "The provider stream ended before the message was complete.",
  true,
);

function toolParam(tool: AnthropicToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Tool["input_schema"],
  };
}

function parseToolArguments(json: string): unknown {
  if (json.trim() === "") return {};
  return JSON.parse(json) as unknown;
}

/**
 * One native stream event to at most one Forge event. Frames that carry no
 * Forge meaning — `message_start`, `message_delta`, the opening of a text
 * block — map to nothing; the terminal event still governs, so ignoring them
 * cannot turn a failure into a success.
 */
function mapStreamEvent(
  event: RawMessageStreamEvent,
  pending: Map<number, PendingToolCall>,
): ProviderEvent | undefined {
  switch (event.type) {
    case "content_block_start":
      if (event.content_block.type === "tool_use") {
        pending.set(event.index, {
          toolId: event.content_block.name,
          json: "",
        });
      }
      return undefined;
    case "content_block_delta": {
      if (event.delta.type === "text_delta")
        return { type: "text-delta", text: event.delta.text };
      if (event.delta.type === "input_json_delta") {
        const call = pending.get(event.index);
        if (call !== undefined) call.json += event.delta.partial_json;
      }
      return undefined;
    }
    case "content_block_stop": {
      const call = pending.get(event.index);
      if (call === undefined) return undefined;
      pending.delete(event.index);
      try {
        return {
          type: "tool-call",
          toolId: call.toolId,
          args: parseToolArguments(call.json),
        };
      } catch {
        // 008 §13.10 — a native frame Forge cannot read becomes a structured
        // error, and a tool call whose arguments cannot be read is never
        // dispatched.
        return failure(
          "PROVIDER_TOOL_ARGUMENTS_INVALID",
          `The provider sent arguments for ${call.toolId} that are not valid JSON.`,
          false,
        );
      }
    }
    default:
      return undefined;
  }
}

/**
 * Drains one native stream into Forge events, terminal event included. Exactly
 * one terminal event leaves here, and nothing follows it.
 */
async function* consume(
  native: AsyncIterable<RawMessageStreamEvent>,
  state: SessionState,
): AsyncGenerator<ProviderEvent> {
  const pending = new Map<number, PendingToolCall>();
  let complete = false;

  for await (const event of native) {
    if (event.type === "message_stop") {
      complete = true;
      continue;
    }
    const mapped = mapStreamEvent(event, pending);
    if (mapped === undefined) continue;
    yield mapped;
    // An error is terminal. Nothing follows it, and nothing may claim the
    // stream succeeded after it.
    if (mapped.type === "error") return;
  }

  // The SDK swallows an abort and ends the iteration quietly, so a stop the
  // caller asked for is only visible here.
  if (state.cancelled) {
    yield CANCELLED;
    return;
  }
  yield complete ? { type: "completed" } : TRUNCATED;
}

export function createAnthropicProvider(
  options: AnthropicProviderOptions,
): ProviderPort {
  const apiKey = process.env[API_KEY_VARIABLE] ?? "";
  // Fails closed here rather than at the first prompt: a provider that
  // constructs without a credential is one whose first real run dies, possibly
  // days later behind an approval gate.
  if (apiKey.trim() === "") {
    throw new Error(
      `@forge/provider-anthropic requires ${API_KEY_VARIABLE} in the environment; it is unset or empty.`,
    );
  }

  const requested = options.capabilities;
  const capabilities =
    requested === undefined
      ? DECLARED
      : DECLARED.filter((capability) => requested.includes(capability));

  const client = new Anthropic({
    apiKey,
    // Retry is the runtime's decision, not the SDK's (006). A transport that
    // retried underneath would hide the very classification this adapter is
    // responsible for, and would spend attempts the run never authorised.
    maxRetries: 0,
    ...(options.transport === undefined ? {} : { fetch: options.transport }),
  });

  const tools = options.tools?.map(toolParam);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Destroyed sessions stay as tombstones, so reuse is refused for the reason
  // it happened rather than mistaken for an id nobody ever minted.
  const sessions = new Map<string, SessionState>();
  let nextSession = 1;

  function live(session: ProviderSession): SessionState | undefined {
    const state = sessions.get(session.sessionId);
    return state?.status === "open" ? state : undefined;
  }

  async function* stream(
    state: SessionState,
    prompt: string,
  ): AsyncGenerator<ProviderEvent> {
    const controller = new AbortController();
    state.cancelled = false;
    state.inFlight = controller;

    const params: MessageCreateParamsStreaming = {
      model: options.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      ...(tools === undefined ? {} : { tools }),
    };

    try {
      yield* consume(
        await client.messages.create(params, { signal: controller.signal }),
        state,
      );
    } catch (error) {
      yield state.cancelled ? CANCELLED : classifyFailure(error);
    } finally {
      state.inFlight = undefined;
    }
  }

  return {
    providerId: PROVIDER_ID,
    capabilities,

    async createSession(
      input: CreateProviderSessionInput,
    ): Promise<ProviderSession> {
      const undeclared = input.capabilities.filter(
        (capability) => !capabilities.includes(capability),
      );
      if (undeclared.length > 0) {
        throw new Error(
          `${PROVIDER_ID} provider does not support ${undeclared.join(", ")}.`,
        );
      }
      const session = {
        providerId: PROVIDER_ID,
        sessionId: `${PROVIDER_ID}_session_${nextSession}`,
      };
      nextSession += 1;
      sessions.set(session.sessionId, {
        session,
        status: "open",
        cancelled: false,
        inFlight: undefined,
      });
      return session;
    },

    async resumeSession(
      input: ResumeProviderSessionInput,
    ): Promise<ProviderSession> {
      throw new Error(
        `${PROVIDER_ID} provider did not declare session-resume; ${input.sessionId} cannot be resumed.`,
      );
    },

    execute(
      session: ProviderSession,
      request: ProviderExecutionRequest,
    ): AsyncIterable<ProviderEvent> {
      const state = live(session);
      if (state === undefined) {
        return (async function* refuse() {
          yield SESSION_GONE;
        })();
      }
      return stream(state, request.prompt);
    },

    async cancel(session: ProviderSession): Promise<void> {
      const state = live(session);
      if (state === undefined) return;
      state.cancelled = true;
      // Aborting the request is the point. Merely stopping the read would leave
      // the connection open and the tokens being generated and paid for.
      state.inFlight?.abort();
    },

    async destroySession(session: ProviderSession): Promise<void> {
      const state = sessions.get(session.sessionId);
      if (state === undefined) return;
      state.status = "destroyed";
      state.inFlight?.abort();
    },

    async health() {
      try {
        // The cheapest authenticated call there is: no tokens, no model.
        await client.models.list({ limit: 1 });
        return { available: true, providerId: PROVIDER_ID };
      } catch {
        // A rejected health() reads as a broken adapter rather than a provider
        // that is merely down, and the two need different operator responses.
        return { available: false, providerId: PROVIDER_ID };
      }
    },
  };
}
