import type { ProviderEvent } from "@forge/ports";
import { describe, expect, test } from "vitest";

import { drain, PROVIDER_CAPABILITIES } from "./harness.js";

async function* partialThenThrows(): AsyncGenerator<ProviderEvent> {
  yield { type: "text-delta", text: "partial" };
  throw new Error("the transport died mid-stream");
}

async function* neverStops(): AsyncGenerator<ProviderEvent> {
  for (;;) yield { type: "text-delta", text: "…" };
}

describe("the suite reports a misbehaving stream rather than being taken down by it", () => {
  test("a stream that throws is a stop, not a completion", async () => {
    const outcome = await drain(partialThenThrows());

    expect(outcome).toMatchObject({ threw: true, overran: false });
    expect(outcome.events).toHaveLength(1);
  });

  test("a stream that ignores its ending fails the suite instead of hanging it", async () => {
    const outcome = await drain(neverStops());

    expect(outcome).toMatchObject({ threw: false, overran: true });
  });

  test("every declared capability is exercised, so a new one cannot arrive unchecked", () => {
    expect([...PROVIDER_CAPABILITIES].sort()).toEqual([
      "session-resume",
      "streaming",
      "tool-calls",
    ]);
  });
});
