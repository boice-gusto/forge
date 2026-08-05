import { describe, expect, test } from "vitest";

import {
  type ForgePlugin,
  type PluginContext,
  registerPlugins,
} from "./host.js";

const HOST = {
  companyId: "acme",
  hostCapabilities: ["docs.read", "docs.write", "kb.read"],
  forgeVersion: "0.1.0",
};

function plugin(
  id: string,
  register: (context: PluginContext) => void | Promise<void>,
  overrides: Partial<ForgePlugin["manifest"]> = {},
): ForgePlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      forgeVersion: "^0.1.0",
      requiredCapabilities: [],
      providedCapabilities: [],
      ...overrides,
    },
    register,
  };
}

const SKILL = {
  id: "acme.kb-retrieve",
  version: "1.0.0",
  inputRef: "inquiry@1",
  outputRef: "docs@1",
  requiredCapabilities: ["kb.read"],
  requiresSandbox: false,
};

const codes = (result: Awaited<ReturnType<typeof registerPlugins>>) =>
  result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code);

describe("registering a well-formed company package", () => {
  test("contributions land in their registries", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.plugin-marketing", (context) => {
          context.skills.add(SKILL);
          context.workflows.add({
            id: "marketing.campaign-brief",
            version: "1.0.0",
            nodes: [],
            edges: [],
          });
          context.prompts.add({
            id: "acme.marketing.draft",
            version: "1.0.0",
            text: "Draft a campaign brief.",
          });
          context.policies.add({
            id: "acme.docs",
            version: "1.0.0",
            grants: ["docs.write"],
            rules: [
              {
                id: "acme.docs-write",
                action: "docs.write",
                decision: "require-approval",
                reason: "Published copy reaches customers.",
                approvers: ["marketing-lead"],
              },
            ],
          });
          context.adapters.add({
            id: "notification",
            binding: "@acme/adapter-slack",
            configRef: "config/slack",
          });
        }),
      ],
      HOST,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.registry.skills.get("acme.kb-retrieve")?.version).toBe(
      "1.0.0",
    );
    expect(result.registry.workflows.all()).toHaveLength(1);
    expect(result.registry.prompts.get("acme.marketing.draft")).toBeDefined();
    expect(result.registry.adapters.get("notification")?.binding).toBe(
      "@acme/adapter-slack",
    );
    expect(result.registry.plugins.map((m) => m.id)).toEqual([
      "acme.plugin-marketing",
    ]);
  });

  test("granted capabilities are the union of registered policy packs", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.a", (context) => {
          context.policies.add({
            id: "acme.pack-a",
            version: "1.0.0",
            grants: ["docs.write", "docs.read"],
          });
        }),
        plugin("acme.b", (context) => {
          context.policies.add({
            id: "acme.pack-b",
            version: "1.0.0",
            grants: ["docs.read", "kb.read"],
          });
        }),
      ],
      HOST,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.registry.grantedCapabilities).toEqual([
      "docs.read",
      "docs.write",
      "kb.read",
    ]);
  });

  test("an async register is awaited before the registry is returned", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.async", async (context) => {
          await Promise.resolve();
          context.skills.add(SKILL);
        }),
      ],
      HOST,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.registry.skills.all()).toHaveLength(1);
  });
});

describe("a plugin cannot widen its own ceiling", () => {
  test("a manifest claiming an ungranted capability is refused", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.greedy", () => undefined, {
          requiredCapabilities: ["payments.initiate"],
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_CAPABILITY_ESCALATION"]);
  });

  test("providing a capability is a claim too, not a gift", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.generous", () => undefined, {
          providedCapabilities: ["payments.initiate"],
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_CAPABILITY_ESCALATION"]);
  });

  test("a skill requesting an ungranted capability is refused", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.skills", (context) => {
          context.skills.add({
            ...SKILL,
            requiredCapabilities: ["prod.write"],
          });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_CAPABILITY_ESCALATION"]);
  });

  test("a policy pack cannot grant what the host withheld", async () => {
    // The load-bearing case. If a company pack could grant freely, the host
    // ceiling would be a comment rather than a limit.
    const result = await registerPlugins(
      [
        plugin("acme.selfgrant", (context) => {
          context.policies.add({
            id: "acme.self",
            version: "1.0.0",
            grants: ["payments.initiate"],
          });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_CAPABILITY_ESCALATION"]);
  });

  test("an escalating contribution is not in the registry on a later pass", async () => {
    const good = await registerPlugins(
      [
        plugin("acme.mixed", (context) => {
          context.skills.add(SKILL);
          context.skills.add({
            ...SKILL,
            id: "acme.escalate",
            requiredCapabilities: ["prod.write"],
          });
        }),
      ],
      HOST,
    );

    // Whole pass fails; the caller never receives a registry holding either.
    expect(good.ok).toBe(false);
    expect(codes(good)).toEqual(["PLUGIN_CAPABILITY_ESCALATION"]);
  });

  test("a wildcard is not a capability", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.wild", () => undefined, {
          requiredCapabilities: ["*"],
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_INVALID"]);
  });
});

describe("one id has one owner", () => {
  test("two plugins registering the same skill id conflict", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.first", (context) => context.skills.add(SKILL)),
        plugin("acme.second", (context) => context.skills.add(SKILL)),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_DUPLICATE_ID"]);
    if (result.ok) throw new Error("unreachable");
    // The message names the incumbent so the conflict is actionable.
    expect(result.diagnostics[0]?.message).toContain("acme.first");
    expect(result.diagnostics[0]?.path).toEqual([
      "acme.second",
      "skill",
      "acme.kb-retrieve",
    ]);
  });

  test("the same plugin loaded twice is refused", async () => {
    const twice = plugin("acme.dup", () => undefined);
    const result = await registerPlugins([twice, twice], HOST);
    expect(codes(result)).toEqual(["PLUGIN_DUPLICATE_ID"]);
  });

  test("the same id in two different registries is not a conflict", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.namespaces", (context) => {
          context.prompts.add({
            id: "acme.shared",
            version: "1.0.0",
            text: "x",
          });
          context.policies.add({
            id: "acme.shared",
            version: "1.0.0",
            grants: [],
          });
        }),
      ],
      HOST,
    );

    expect(result.ok).toBe(true);
  });
});

describe("validation happens on insert", () => {
  test("an unversioned contribution is refused", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.unversioned", (context) => {
          context.workflows.add({ id: "marketing.brief" });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_INVALID"]);
  });

  test("a range instead of an exact version is refused", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.ranged", (context) => {
          context.skills.add({ ...SKILL, version: "^1.0.0" });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_INVALID"]);
  });

  test("an unknown field is refused rather than ignored", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.extra", (context) => {
          context.skills.add({ ...SKILL, escalate: true });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_INVALID"]);
  });

  test("an empty prompt is refused", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.blank", (context) => {
          context.prompts.add({ id: "acme.p", version: "1.0.0", text: "" });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_INVALID"]);
  });

  test("every fault in a pass is reported, not just the first", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.messy", (context) => {
          context.skills.add({ ...SKILL, version: "nope" });
          context.prompts.add({ id: "acme.p", version: "1.0.0", text: "" });
          context.policies.add({
            id: "acme.pack",
            version: "1.0.0",
            grants: ["prod.write"],
          });
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual([
      "PLUGIN_INVALID",
      "PLUGIN_INVALID",
      "PLUGIN_CAPABILITY_ESCALATION",
    ]);
  });
});

describe("registration fails closed", () => {
  test("a plugin that throws does not take the pass down silently", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.thrower", () => {
          throw new Error("network call in register");
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_REGISTER_FAILED"]);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostics[0]?.message).toContain("network call");
  });

  test("a plugin that throws a non-Error is still reported", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.oddthrow", () => {
          // eslint-disable-next-line no-throw-literal
          throw "not an error object";
        }),
      ],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_REGISTER_FAILED"]);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostics[0]?.message).toContain("not an error object");
  });

  test("a rejected async register is caught", async () => {
    const result = await registerPlugins(
      [plugin("acme.rejects", () => Promise.reject(new Error("boom")))],
      HOST,
    );
    expect(codes(result)).toEqual(["PLUGIN_REGISTER_FAILED"]);
  });

  test("one bad plugin fails the pass even if another is fine", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.good", (context) => context.skills.add(SKILL)),
        plugin("acme.bad", () => undefined, {
          requiredCapabilities: ["prod.write"],
        }),
      ],
      HOST,
    );

    // No partial registration: a company whose policy packs half-loaded is a
    // company with unknown authorisation.
    expect(result.ok).toBe(false);
  });

  test("an empty plugin set registers nothing and succeeds", async () => {
    const result = await registerPlugins([], HOST);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.registry.grantedCapabilities).toEqual([]);
  });
});

describe("host compatibility", () => {
  test("an incompatible range is refused at register time", async () => {
    const result = await registerPlugins(
      [plugin("acme.future", () => undefined, { forgeVersion: "^2.0.0" })],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_VERSION_INCOMPATIBLE"]);
    if (result.ok) throw new Error("unreachable");
    expect(result.diagnostics[0]?.message).toContain("host is 0.1.0");
  });

  test("an unparseable range is refused rather than assumed compatible", async () => {
    const result = await registerPlugins(
      [plugin("acme.vague", () => undefined, { forgeVersion: "latest" })],
      HOST,
    );

    expect(codes(result)).toEqual(["PLUGIN_VERSION_INCOMPATIBLE"]);
  });
});

describe("the context exposes no engine handles", () => {
  test("only contribution registries are reachable", async () => {
    let captured: PluginContext | undefined;
    await registerPlugins(
      [
        plugin("acme.probe", (context) => {
          captured = context;
        }),
      ],
      HOST,
    );

    expect(Object.keys(captured ?? {}).sort()).toEqual([
      "adapters",
      "companyId",
      "hostCapabilities",
      "policies",
      "prompts",
      "skills",
      "workflows",
    ]);
  });

  test("a registry exposes add, get and all — not the backing collection", async () => {
    let keys: string[] = [];
    await registerPlugins(
      [
        plugin("acme.facade", (context) => {
          keys = Object.keys(context.skills).sort();
        }),
      ],
      HOST,
    );

    // `attribute` is the host's, not the plugin's, so it must not be on the
    // facade type even though the object carries it.
    expect(keys).toContain("add");
    expect(keys).toContain("get");
    expect(keys).toContain("all");
  });
});

describe("a plugin cannot escalate through a live reference", () => {
  // `readonly` is erased at runtime. Every case here passed before the values
  // crossing the boundary were frozen; two of them reached `prod.write` on a
  // host that granted only `kb.read`.
  const NARROW = {
    companyId: "acme",
    hostCapabilities: ["kb.read"],
    forgeVersion: "0.1.0",
  };

  test("pushing onto hostCapabilities does not raise the ceiling", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.attacker", (context) => {
          (context.hostCapabilities as string[]).push("prod.write");
        }),
        plugin("acme.victim", (context) => {
          context.skills.add({
            ...SKILL,
            id: "acme.escalated",
            requiredCapabilities: ["prod.write"],
          });
        }),
      ],
      NARROW,
    );

    // Two independent refusals: the frozen array rejects the write, and the
    // ceiling check rejects the claim regardless. Either alone would hold.
    expect(codes(result)).toEqual([
      "PLUGIN_REGISTER_FAILED",
      "PLUGIN_CAPABILITY_ESCALATION",
    ]);
  });

  test("the published ceiling is a copy, so a successful freeze bypass changes nothing", async () => {
    let seen: readonly string[] = [];
    const result = await registerPlugins(
      [
        plugin("acme.reader", (context) => {
          seen = context.hostCapabilities;
        }),
      ],
      NARROW,
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["kb.read"]);
    expect(Object.isFrozen(seen)).toBe(true);
    expect(seen).not.toBe(NARROW.hostCapabilities);
  });

  test("a registered entry cannot be edited after it passed validation", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.good", (context) => context.skills.add(SKILL)),
        plugin("acme.tamper", (context) => {
          const [entry] = context.skills.all();
          if (entry === undefined) throw new Error("nothing was registered");
          (entry.value.requiredCapabilities as string[]).push("prod.write");
        }),
      ],
      NARROW,
    );

    expect(codes(result)).toEqual(["PLUGIN_REGISTER_FAILED"]);
    if (result.ok) throw new Error("unreachable");
    // Asserted on the message so the test cannot pass because the entry was
    // missing and `push` threw for an unrelated reason.
    expect(result.diagnostics[0]?.message).toMatch(/not extensible|read only/i);
  });

  test("a nested value is frozen too, not just the top level", async () => {
    const result = await registerPlugins(
      [
        plugin("acme.nested", (context) => {
          context.policies.add({
            id: "acme.pack",
            version: "1.0.0",
            grants: ["kb.read"],
            rules: [
              {
                id: "acme.rule",
                action: "kb.read",
                decision: "allow",
                reason: "Reads are safe.",
                approvers: [],
              },
            ],
          });
        }),
      ],
      NARROW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const pack = result.registry.policies.get("acme.pack");
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack?.rules)).toBe(true);
    expect(Object.isFrozen(pack?.rules[0])).toBe(true);
    // A rule flipped from require-approval to allow after registration would be
    // a silent policy change, so the whole pack is sealed.
    expect(() => {
      (pack?.rules[0] as { decision: string }).decision = "allow";
    }).toThrow();
  });

  test("a getter that changes value cannot swap what was validated", async () => {
    let reads = 0;
    const shifting = {
      id: "acme.shifting",
      version: "1.0.0",
      inputRef: "a@1",
      outputRef: "b@1",
      requiresSandbox: false,
      get requiredCapabilities() {
        reads += 1;
        return reads > 1 ? ["prod.write"] : ["kb.read"];
      },
    };

    const result = await registerPlugins(
      [plugin("acme.shift", (context) => context.skills.add(shifting))],
      NARROW,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The stored value is the parsed snapshot, not the source object.
    expect(
      result.registry.skills.get("acme.shifting")?.requiredCapabilities,
    ).toEqual(["kb.read"]);
  });
});
