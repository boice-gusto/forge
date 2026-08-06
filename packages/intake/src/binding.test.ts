import { describe, expect, test } from "vitest";

import { bindConnectors } from "./binding.js";
import type { Connector } from "./connector.js";
import { accept, reject } from "./request.js";

/**
 * Where a connector comes from, and where its secret does not.
 *
 * A company names the channels a deployment serves; the deployment holds the
 * signing secrets. The factory shape is what keeps those apart — a module that
 * exported a ready-made table would have had to contain a secret to build one,
 * and a secret in a company package is a secret in a git repository.
 */

const connector = (channel: string): Connector => ({
  channel,
  async verify() {
    return accept({
      origin: {
        channel,
        externalId: "1",
        externalActor: "u",
        receivedAt: "2026-08-04T00:00:00.000Z",
      },
      body: {},
    });
  },
  async normalise() {
    return reject("UNSUPPORTED", "not the subject of this file");
  },
});

const noSecrets = () => undefined;

describe("a company names its channels; the deployment holds the secrets", () => {
  test("a factory is called with the lookup and its table is bound", () => {
    const asked: string[] = [];
    const module = {
      default: (secret: (name: string) => string | undefined) => {
        asked.push("called");
        expect(secret("SLACK_SIGNING_SECRET")).toBe("from-the-environment");
        return { slack: connector("slack") };
      },
    };

    const bound = bindConnectors(module, (name) =>
      name === "SLACK_SIGNING_SECRET" ? "from-the-environment" : undefined,
    );

    expect(asked).toEqual(["called"]);
    expect(Object.keys(bound.connectors)).toEqual(["slack"]);
    expect(bound.problems).toEqual([]);
  });

  test("a module exporting a ready-made table is refused", () => {
    /**
     * Not pedantry. A table can only exist if something already built the
     * connectors, which means the secrets were already in hand — in a company
     * package, in a repository. The factory shape is what makes that
     * impossible rather than discouraged.
     */
    const bound = bindConnectors(
      { default: { slack: connector("slack") } },
      noSecrets,
    );

    expect(bound.connectors).toEqual({});
    expect(bound.problems[0]).toContain("factory");
  });

  test("a factory that throws for a missing secret says so plainly", () => {
    // The common deployment fault: the company asks for a secret the host was
    // never given. Worth a clear message rather than a stack trace at boot.
    const bound = bindConnectors(
      {
        default: (secret: (name: string) => string | undefined) => {
          const value = secret("SLACK_SIGNING_SECRET");
          if (value === undefined)
            throw new Error("SLACK_SIGNING_SECRET unset");
          return {};
        },
      },
      noSecrets,
    );

    expect(bound.problems[0]).toContain("SLACK_SIGNING_SECRET unset");
  });

  test("a key that disagrees with its connector's channel is refused", () => {
    /**
     * The key is what `/v1/intake/:channel` dispatches on; the field is what
     * deduplication keys on. If they disagree, a delivery to one channel
     * deduplicates against another's ids — and could suppress its events.
     */
    const bound = bindConnectors(
      { default: () => ({ slack: connector("jira") }) },
      noSecrets,
    );

    expect(bound.connectors).toEqual({});
    expect(bound.problems[0]).toContain("calls itself 'jira'");
  });

  test("something that is not a connector is named, not silently dropped", () => {
    const bound = bindConnectors(
      { default: () => ({ slack: { channel: "slack" } }) },
      noSecrets,
    );

    expect(bound.problems).toEqual(["'slack' is not a connector"]);
  });

  test("one bad channel does not take the good ones with it", () => {
    // A host refuses on any problem, but it should be able to say *which*.
    const bound = bindConnectors(
      {
        default: () => ({
          slack: connector("slack"),
          jira: { nope: true },
        }),
      },
      noSecrets,
    );

    expect(Object.keys(bound.connectors)).toEqual(["slack"]);
    expect(bound.problems).toEqual(["'jira' is not a connector"]);
  });

  test("a factory returning nothing at all is a problem, not an empty table", () => {
    const bound = bindConnectors({ default: () => undefined }, noSecrets);

    expect(bound.problems[0]).toContain("no table");
  });
});
