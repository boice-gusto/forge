import type { ProviderCapability, ProviderPort } from "@forge/ports";
import { describe, expect, test } from "vitest";

import {
  CONFORMANCE_REQUEST,
  drain,
  errorEvents,
  eventTypes,
  openSession,
  PROVIDER_CAPABILITIES,
  type ProviderConformanceHarness,
  runToEnd,
  type StreamOutcome,
  startStream,
  terminalEvents,
} from "./harness.js";

/**
 * The port does not say what an adapter should do when work arrives on a dead
 * session or after a cancellation. Where it is silent the suite requires the
 * safe reading: stop, and say so. Ending quietly is indistinguishable from
 * having nothing to say, and `completed` would be a lie.
 */
function expectRefused(outcome: StreamOutcome): void {
  expect(outcome.overran).toBe(false);
  expect(eventTypes(outcome.events)).not.toContain("completed");
  if (!outcome.threw) {
    expect(outcome.events.at(-1)).toMatchObject({
      type: "error",
      retryable: false,
    });
  }
}

function withoutCapability(
  capabilities: readonly ProviderCapability[],
  omitted: ProviderCapability,
): readonly ProviderCapability[] {
  return capabilities.filter((capability) => capability !== omitted);
}

function describeSessionLifecycle(harness: ProviderConformanceHarness): void {
  describe("a session is a lifecycle, not a bare handle", () => {
    test("a created session is tagged with the provider that owns it", async () => {
      const provider = await harness.create("text-stream");
      const first = await openSession(provider);
      const second = await openSession(provider);

      expect(first.providerId).toBe(provider.providerId);
      expect(first.sessionId).not.toBe("");
      expect(second.sessionId).not.toBe(first.sessionId);
    });

    test("a destroyed session cannot be executed again", async () => {
      const provider = await harness.create("text-stream");
      const session = await openSession(provider);
      await provider.destroySession(session);

      expectRefused(await runToEnd(provider, session));
    });

    test("destroying twice is safe, because the runtime closes in a finally", async () => {
      const provider = await harness.create("text-stream");
      const session = await openSession(provider);

      await provider.destroySession(session);
      await expect(provider.destroySession(session)).resolves.toBeUndefined();
    });
  });
}

function describeResume(harness: ProviderConformanceHarness): void {
  const resumes = harness.supports.includes("session-resume");

  describe("resume returns to the same session or refuses", () => {
    test.runIf(resumes)(
      "a live session resumes under its own id and can still be executed",
      async () => {
        const provider = await harness.create("text-stream");
        const session = await openSession(provider);

        const resumed = await provider.resumeSession({
          sessionId: session.sessionId,
        });

        expect(resumed).toEqual(session);
        expect(
          eventTypes((await runToEnd(provider, resumed)).events),
        ).toContain("completed");
      },
    );

    test("an unknown session id is refused rather than quietly minted", async () => {
      const provider = await harness.create("text-stream");

      await expect(
        provider.resumeSession({ sessionId: "session_that_never_existed" }),
      ).rejects.toThrow();
    });

    test("a destroyed session does not come back", async () => {
      const provider = await harness.create("text-stream");
      const session = await openSession(provider);
      await provider.destroySession(session);

      await expect(
        provider.resumeSession({ sessionId: session.sessionId }),
      ).rejects.toThrow();
    });

    test("an adapter that did not declare session-resume refuses to resume", async () => {
      const provider = await harness.createRestricted(
        withoutCapability(harness.supports, "session-resume"),
      );
      const session = await openSession(provider);

      expect(provider.capabilities).not.toContain("session-resume");
      await expect(
        provider.resumeSession({ sessionId: session.sessionId }),
      ).rejects.toThrow();
    });
  });
}

function describeStreamTermination(harness: ProviderConformanceHarness): void {
  describe("a stream ends exactly once, and completed means it worked", () => {
    test("text deltas arrive before the completion that closes them", async () => {
      const provider = await harness.create("text-stream");
      const outcome = await runToEnd(provider, await openSession(provider));
      const types = eventTypes(outcome.events);

      expect(types).toContain("text-delta");
      expect(types.lastIndexOf("text-delta")).toBeLessThan(
        types.indexOf("completed"),
      );
    });

    test("nothing is emitted after completed", async () => {
      const provider = await harness.create("text-stream");
      const outcome = await runToEnd(provider, await openSession(provider));

      expect(outcome.threw).toBe(false);
      expect(outcome.overran).toBe(false);
      expect(outcome.events.at(-1)).toMatchObject({ type: "completed" });
    });

    test("a failing stream never also reports completed", async () => {
      for (const scenario of [
        "transient-failure",
        "permanent-failure",
      ] as const) {
        const provider = await harness.create(scenario);
        const outcome = await runToEnd(provider, await openSession(provider));

        expect(errorEvents(outcome.events)).toHaveLength(1);
        expect(eventTypes(outcome.events)).not.toContain("completed");
      }
    });

    test("every stream carries exactly one terminal event, and it is last", async () => {
      for (const scenario of [
        "text-stream",
        "tool-round-trip",
        "transient-failure",
        "permanent-failure",
      ] as const) {
        const provider = await harness.create(scenario);
        const outcome = await runToEnd(provider, await openSession(provider));
        const terminals = terminalEvents(outcome.events);

        expect(terminals).toHaveLength(1);
        expect(outcome.events.at(-1)).toBe(terminals[0]);
      }
    });
  });
}

function describeToolPairing(harness: ProviderConformanceHarness): void {
  describe("a tool result names a call that actually happened", () => {
    test("no result arrives before its call, and no call is answered twice", async () => {
      const provider = await harness.create("tool-round-trip");
      const outcome = await runToEnd(provider, await openSession(provider));

      const called = new Set<string>();
      const answered = new Set<string>();
      for (const event of outcome.events) {
        if (event.type === "tool-call") called.add(event.toolId);
        if (event.type !== "tool-result") continue;
        expect(called.has(event.toolId)).toBe(true);
        expect(answered.has(event.toolId)).toBe(false);
        answered.add(event.toolId);
      }

      expect(answered.size).toBeGreaterThan(0);
      expect([...answered]).toEqual([...called]);
    });
  });
}

function describeCancellation(harness: ProviderConformanceHarness): void {
  describe("cancel stops the stream and never claims success", () => {
    test("a cancelled stream stops instead of running to completion", async () => {
      const provider = await harness.create("cancellable-stream");
      const session = await openSession(provider);
      const stream = startStream(provider, session);

      const first = await stream.next();
      expect(first.done).toBe(false);
      await provider.cancel(session);

      const rest = await drain(stream);
      expect(rest.overran).toBe(false);
      expect(eventTypes(rest.events)).not.toContain("completed");
    });

    test("a cancelled stream reports the stop rather than ending silently", async () => {
      const provider = await harness.create("cancellable-stream");
      const session = await openSession(provider);
      const stream = startStream(provider, session);

      await stream.next();
      await provider.cancel(session);
      const rest = await drain(stream);

      // Retrying a deliberate stop would undo the stop, so cancellation is
      // never a retryable failure.
      expect(rest.events.at(-1)).toMatchObject({
        type: "error",
        retryable: false,
      });
    });

    test("cancelling an idle session resolves, so worker shutdown cannot wedge", async () => {
      const provider = await harness.create("cancellable-stream");
      const session = await openSession(provider);

      await expect(provider.cancel(session)).resolves.toBeUndefined();
    });
  });
}

async function classify(
  provider: ProviderPort,
): Promise<{ code: string; retryable: boolean }> {
  const outcome = await runToEnd(provider, await openSession(provider));
  const [failure] = errorEvents(outcome.events);
  if (failure === undefined)
    throw new Error("scenario produced no error event");
  return { code: failure.code, retryable: failure.retryable };
}

function describeErrorTaxonomy(harness: ProviderConformanceHarness): void {
  describe("a failure is classified, not merely reported", () => {
    test("a transient failure is marked retryable, so a run that would work is not failed", async () => {
      const provider = await harness.create("transient-failure");
      const failure = await classify(provider);

      expect(failure.retryable).toBe(true);
      expect(failure.code).not.toBe("");
    });

    test("a permanent failure is not marked retryable, so the runtime does not spin", async () => {
      const provider = await harness.create("permanent-failure");
      const failure = await classify(provider);

      expect(failure.retryable).toBe(false);
      expect(failure.code).not.toBe("");
    });

    test("an error event carries a code and a message a human can act on", async () => {
      const provider = await harness.create("permanent-failure");
      const outcome = await runToEnd(provider, await openSession(provider));

      expect(outcome.events.at(-1)).toMatchObject({
        type: "error",
        retryable: false,
      });
      for (const failure of errorEvents(outcome.events)) {
        expect(failure.code.length).toBeGreaterThan(0);
        expect(failure.message.length).toBeGreaterThan(0);
      }
    });

    test("classification does not drift between attempts", async () => {
      for (const scenario of [
        "transient-failure",
        "permanent-failure",
      ] as const) {
        const provider = await harness.create(scenario);

        expect(await classify(provider)).toEqual(await classify(provider));
      }
    });
  });
}

function describeHealth(harness: ProviderConformanceHarness): void {
  describe("health reports unavailability instead of throwing", () => {
    test("a working adapter reports itself available under its own id", async () => {
      const provider = await harness.create("text-stream");

      expect(await provider.health()).toEqual({
        available: true,
        providerId: provider.providerId,
      });
    });

    test("an unavailable adapter resolves with available false", async () => {
      const provider = await harness.create("unavailable");

      // A rejected health() reads as a broken adapter rather than a provider
      // that is merely down, and the two need different operator responses.
      expect(await provider.health()).toEqual({
        available: false,
        providerId: provider.providerId,
      });
    });
  });
}

function describeCapabilityHonesty(harness: ProviderConformanceHarness): void {
  describe("an adapter accepts only the work it declared", () => {
    test("the adapter declares what the harness claims for it", async () => {
      const provider = await harness.create("text-stream");

      expect([...provider.capabilities].sort()).toEqual(
        [...harness.supports].sort(),
      );
    });

    test("a session is created for the capabilities the adapter declares", async () => {
      const provider = await harness.create("text-stream");

      await expect(
        provider.createSession({
          workspacePath: "/workspace/conformance",
          correlationId: "conformance",
          capabilities: provider.capabilities,
        }),
      ).resolves.toMatchObject({ providerId: provider.providerId });
    });

    for (const capability of PROVIDER_CAPABILITIES) {
      test(`work requiring an undeclared ${capability} is refused`, async () => {
        const provider = await harness.createRestricted(
          withoutCapability(harness.supports, capability),
        );

        expect(provider.capabilities).not.toContain(capability);
        await expect(
          provider.createSession({
            workspacePath: "/workspace/conformance",
            correlationId: "conformance",
            capabilities: [capability],
          }),
        ).rejects.toThrow();
      });
    }

    test("a declared capability mixed with an undeclared one is still refused", async () => {
      const omitted: ProviderCapability = "tool-calls";
      const provider = await harness.createRestricted(
        withoutCapability(harness.supports, omitted),
      );

      await expect(
        provider.createSession({
          workspacePath: "/workspace/conformance",
          correlationId: "conformance",
          capabilities: [...provider.capabilities, omitted],
        }),
      ).rejects.toThrow();
    });
  });
}

function describeRequestHandling(harness: ProviderConformanceHarness): void {
  describe("the prompt reaches the adapter without changing the contract", () => {
    test("two executions on one session are independent streams", async () => {
      const provider = await harness.create("text-stream");
      const session = await openSession(provider);

      const first = await drain(
        provider.execute(session, CONFORMANCE_REQUEST)[Symbol.asyncIterator](),
      );
      const second = await runToEnd(provider, session);

      expect(eventTypes(first.events)).toEqual(eventTypes(second.events));
      expect(second.events.at(-1)).toMatchObject({ type: "completed" });
    });
  });
}

/**
 * Runs the whole ProviderPort contract against one adapter. A new provider
 * proves itself by calling this with its own factory.
 */
export function describeProviderConformance(
  harness: ProviderConformanceHarness,
): void {
  describe(`${harness.name} · ProviderPort conformance`, () => {
    describeSessionLifecycle(harness);
    describeResume(harness);
    describeStreamTermination(harness);
    describeToolPairing(harness);
    describeCancellation(harness);
    describeErrorTaxonomy(harness);
    describeHealth(harness);
    describeCapabilityHonesty(harness);
    describeRequestHandling(harness);
  });
}
