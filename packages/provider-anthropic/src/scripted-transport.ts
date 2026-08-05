/**
 * A `fetch` the adapter can be pointed at instead of the network.
 *
 * The adapter's HTTP transport is injectable so that the conformance suite,
 * and every other test, exercises the *same* code path a live key would —
 * the real SDK, its real SSE decoder, its real error classes — with no network
 * and no credential. Only the bytes are scripted.
 */

export type AnthropicTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ScriptedSseEvent {
  readonly event: string;
  readonly data: unknown;
}

export interface ScriptedRoute {
  /** Request pathname, matched exactly (`/v1/messages`, `/v1/models`). */
  readonly path: string;
  readonly status?: number;
  /** A single JSON body. Use for non-streaming replies and for failures. */
  readonly json?: unknown;
  /** An SSE reply, delivered one frame per chunk so a cancel lands mid-stream. */
  readonly events?: readonly ScriptedSseEvent[];
  readonly chunkDelayMs?: number;
}

export interface ScriptedCall {
  readonly url: string;
  readonly method: string;
  /** Set when the request's signal fired — the proof that a cancel aborted it. */
  readonly aborted: boolean;
}

export interface ScriptedTransport {
  readonly fetch: AnthropicTransport;
  /** Every attempt, in order. One entry per HTTP request the SDK actually made. */
  readonly calls: readonly ScriptedCall[];
}

interface MutableCall {
  readonly url: string;
  readonly method: string;
  aborted: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function frame({ event, data }: ScriptedSseEvent): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseBody(
  events: readonly ScriptedSseEvent[],
  chunkDelayMs: number,
  signal: AbortSignal | null | undefined,
  call: MutableCall,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  let stopped = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = (): void => {
        if (stopped) return;
        stopped = true;
        call.aborted = true;
        // A real fetch rejects the body stream on abort; anything gentler
        // would let an adapter "cancel" by merely walking away from an open
        // request, which is the defect this transport exists to expose.
        controller.error(
          new DOMException("The operation was aborted.", "AbortError"),
        );
      };
      if (signal == null) return;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (chunkDelayMs > 0) await sleep(chunkDelayMs);
      if (stopped) return;
      const next = events[index];
      if (next === undefined) {
        stopped = true;
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(encoder.encode(frame(next)));
    },
  });
}

const NO_ROUTE_STATUS = 404;

function unmatched(url: string): ScriptedRoute {
  return {
    path: "",
    status: NO_ROUTE_STATUS,
    json: {
      type: "error",
      error: {
        type: "not_found_error",
        message: `the scripted transport has no route for ${url}`,
      },
    },
  };
}

export function createScriptedTransport(
  routes: readonly ScriptedRoute[],
): ScriptedTransport {
  const calls: MutableCall[] = [];

  return {
    calls,
    async fetch(input, init) {
      const url = String(input);
      const call: MutableCall = {
        url,
        method: init?.method ?? "GET",
        aborted: false,
      };
      calls.push(call);

      const { pathname } = new URL(url);
      const route =
        routes.find((candidate) => candidate.path === pathname) ??
        unmatched(url);
      const status = route.status ?? 200;

      if (route.events === undefined) {
        return new Response(JSON.stringify(route.json ?? {}), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        sseBody(route.events, route.chunkDelayMs ?? 0, init?.signal, call),
        { status, headers: { "content-type": "text/event-stream" } },
      );
    },
  };
}
