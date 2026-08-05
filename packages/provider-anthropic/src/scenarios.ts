import type { ScriptedRoute, ScriptedSseEvent } from "./scripted-transport.js";

/**
 * The bytes a live Anthropic endpoint would put on the wire for each situation
 * the conformance suite needs an adapter to be able to reach.
 *
 * Everything below the transport is real: the SDK's SSE decoder, its error
 * classes, its abort handling. A run against a real key differs only in where
 * these frames come from.
 */

export const MESSAGES_PATH = "/v1/messages";
export const MODELS_PATH = "/v1/models";

const MESSAGE_START: ScriptedSseEvent = {
  event: "message_start",
  data: {
    type: "message_start",
    message: {
      id: "msg_conformance",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 0 },
    },
  },
};

const MESSAGE_STOP: ScriptedSseEvent = {
  event: "message_stop",
  data: { type: "message_stop" },
};

function messageDelta(stopReason: string): ScriptedSseEvent {
  return {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 12 },
    },
  };
}

function textBlockStart(index: number): ScriptedSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    },
  };
}

export function textDelta(index: number, text: string): ScriptedSseEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  };
}

export function blockStop(index: number): ScriptedSseEvent {
  return {
    event: "content_block_stop",
    data: { type: "content_block_stop", index },
  };
}

export function toolBlockStart(index: number, name: string): ScriptedSseEvent {
  return {
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: `toolu_${index}`,
        name,
        input: {},
      },
    },
  };
}

export function toolArgumentsDelta(
  index: number,
  partial: string,
): ScriptedSseEvent {
  return {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partial },
    },
  };
}

export const TEXT_STREAM: readonly ScriptedSseEvent[] = [
  MESSAGE_START,
  textBlockStart(0),
  textDelta(0, "drafting"),
  textDelta(0, " the brief"),
  blockStop(0),
  messageDelta("end_turn"),
  MESSAGE_STOP,
];

export const TOOL_ROUND_TRIP: readonly ScriptedSseEvent[] = [
  MESSAGE_START,
  textBlockStart(0),
  textDelta(0, "Checking the brief."),
  blockStop(0),
  toolBlockStart(1, "read_file"),
  toolArgumentsDelta(1, '{"path":'),
  toolArgumentsDelta(1, '"brief.md"}'),
  blockStop(1),
  messageDelta("tool_use"),
  MESSAGE_STOP,
];

/** Long enough, and slow enough, that a cancel has somewhere to land. */
export const CANCELLABLE_STREAM: readonly ScriptedSseEvent[] = [
  MESSAGE_START,
  textBlockStart(0),
  ...Array.from({ length: 12 }, (_unused, position) =>
    textDelta(0, `chunk ${position} `),
  ),
  blockStop(0),
  messageDelta("end_turn"),
  MESSAGE_STOP,
];

export function errorBody(type: string, message: string): unknown {
  return { type: "error", error: { type, message } };
}

/** Present on every scenario but `unavailable`, so `health()` can answer. */
export const MODELS_AVAILABLE: ScriptedRoute = {
  path: MODELS_PATH,
  json: { data: [], has_more: false, first_id: null, last_id: null },
};
