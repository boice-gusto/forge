import { describe, expect, test } from "vitest";

import { MESSAGES_PATH, MODELS_PATH, textDelta } from "./scenarios.js";
import { createScriptedTransport } from "./scripted-transport.js";

const BASE = "https://api.anthropic.com";

async function read(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) throw new Error("the scripted reply had no body");
  return new Response(body).text();
}

describe("the scripted transport stands in for the network, and only for it", () => {
  test("a request with no route is refused in a way that will not be retried", async () => {
    const transport = createScriptedTransport([]);

    const response = await transport.fetch(`${BASE}${MESSAGES_PATH}`);

    // A mis-scripted test must read as a test bug, not as a provider outage
    // the runtime should keep re-attempting.
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain(MESSAGES_PATH);
  });

  test("a route without a body still answers, and the call is recorded", async () => {
    const transport = createScriptedTransport([{ path: MODELS_PATH }]);

    const response = await transport.fetch(`${BASE}${MODELS_PATH}`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});
    expect(transport.calls).toEqual([
      { url: `${BASE}${MODELS_PATH}`, method: "GET", aborted: false },
    ]);
  });

  test("a signal that has already fired never delivers a frame", async () => {
    const transport = createScriptedTransport([
      { path: MESSAGES_PATH, events: [textDelta(0, "never read")] },
    ]);

    const response = await transport.fetch(`${BASE}${MESSAGES_PATH}`, {
      method: "POST",
      signal: AbortSignal.abort(),
    });

    await expect(read(response.body)).rejects.toThrow(/abort/i);
    expect(transport.calls[0]?.aborted).toBe(true);
  });

  test("an unaborted stream delivers every frame in order", async () => {
    const transport = createScriptedTransport([
      {
        path: MESSAGES_PATH,
        events: [textDelta(0, "one"), textDelta(0, "two")],
      },
    ]);

    const response = await transport.fetch(`${BASE}${MESSAGES_PATH}`, {
      method: "POST",
    });
    const body = await read(response.body);

    expect(body.indexOf("one")).toBeLessThan(body.indexOf("two"));
    expect(transport.calls[0]).toMatchObject({
      method: "POST",
      aborted: false,
    });
  });
});
