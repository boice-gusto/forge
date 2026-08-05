import { describe, expect, test } from "vitest";

import {
  definePolicy,
  definePrompt,
  defineSkill,
  defineWorkflow,
} from "./define.js";

/**
 * The two-node minimum the schema enforces, used wherever the graph itself is
 * not what a test is about.
 */
const pair = [
  { id: "a", kind: "input", schemaRef: "s" },
  { id: "b", kind: "output", schemaRef: "s" },
] as const;

describe("defineWorkflow applies the defaults an author omitted", () => {
  test("a workflow declaring nothing optional comes back fully populated", () => {
    const workflow = defineWorkflow({
      id: "acme.minimal",
      version: "1.0.0",
      nodes: pair,
      edges: [{ from: "a", to: "b" }],
    });

    expect(workflow.sideEffects).toEqual([]);
    expect(workflow.roles).toEqual({});
    expect(workflow.grantedCapabilities).toEqual([]);
  });

  test("an approval without gates gates nothing rather than being invalid", () => {
    const workflow = defineWorkflow({
      id: "acme.ungated",
      version: "1.0.0",
      nodes: [
        { id: "a", kind: "input", schemaRef: "s" },
        { id: "g", kind: "approval", gateSchemaRef: "s" },
      ],
      edges: [{ from: "a", to: "g" }],
    });

    expect(workflow.nodes[1]).toEqual({
      id: "g",
      kind: "approval",
      gateSchemaRef: "s",
      gates: [],
    });
  });
});

describe("defineWorkflow refuses a malformed definition where it is written", () => {
  test("an invalid version throws rather than deferring to the compiler", () => {
    expect(() =>
      defineWorkflow({
        id: "acme.bad-version",
        version: "1.0",
        nodes: pair,
        edges: [],
      }),
    ).toThrow(/Invalid workflow definition/);
  });

  test("the message names the field and the reason", () => {
    expect(() =>
      defineWorkflow({
        id: "acme.bad-node",
        version: "1.0.0",
        nodes: [
          { id: "a", kind: "input", schemaRef: "s" },
          { id: "b", kind: "output", schemaRef: "" },
        ],
        edges: [],
      }),
    ).toThrow(/nodes\.1\.schemaRef/);
  });

  test("a non-object is refused with a root-level path", () => {
    expect(() =>
      // Callers from JavaScript get the same answer as callers from
      // TypeScript; the type checks below are a second line, not the only one.
      (defineWorkflow as (source: unknown) => unknown)(null),
    ).toThrow(/<root>/);
  });
});

/**
 * The reference checks are the reason `defineWorkflow` is a function rather
 * than a type annotation. Each workflow below is *schema-valid* — it parses,
 * and it would reach the compiler before anyone learned otherwise — so the
 * error being asserted can only come from the type system.
 */
describe("defineWorkflow resolves references at author time", () => {
  test("an edge may only name a declared node", () => {
    defineWorkflow({
      id: "acme.bad-edge",
      version: "1.0.0",
      nodes: pair,
      // @ts-expect-error "typo" is not a declared node id
      edges: [{ from: "a", to: "typo" }],
    });
  });

  test("a gate may only name a declared node", () => {
    defineWorkflow({
      id: "acme.bad-gate",
      version: "1.0.0",
      // @ts-expect-error "nope" is not a declared node id
      nodes: [
        { id: "a", kind: "input", schemaRef: "s" },
        { id: "g", kind: "approval", gateSchemaRef: "s", gates: ["nope"] },
      ],
      edges: [{ from: "a", to: "g" }],
    });
  });

  test("a parallel branch may only name a declared node", () => {
    defineWorkflow({
      id: "acme.bad-branch",
      version: "1.0.0",
      // @ts-expect-error "ghost" is not a declared node id
      nodes: [
        { id: "a", kind: "input", schemaRef: "s" },
        { id: "p", kind: "parallel", branches: ["a", "ghost"] },
      ],
      edges: [{ from: "a", to: "p" }],
    });
  });

  test("a node may only name a declared role", () => {
    defineWorkflow({
      id: "acme.bad-role",
      version: "1.0.0",
      roles: { writer: { version: "1.0.0" } },
      // @ts-expect-error "reviewer" is not a declared role
      nodes: [
        { id: "a", kind: "input", schemaRef: "s" },
        { id: "b", kind: "agent", promptRef: "p", role: "reviewer" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
  });

  test("a tool may only cause a declared side effect", () => {
    defineWorkflow({
      id: "acme.bad-effect",
      version: "1.0.0",
      sideEffects: ["slack.post"],
      // @ts-expect-error "email.send" is not in sideEffects
      nodes: [
        { id: "a", kind: "input", schemaRef: "s" },
        { id: "b", kind: "tool", skillRef: "s", effect: "email.send" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
  });

  test("references that do resolve are accepted", () => {
    const workflow = defineWorkflow({
      id: "acme.sound",
      version: "1.0.0",
      sideEffects: ["slack.post"],
      grantedCapabilities: ["docs.write"],
      roles: {
        writer: {
          version: "1.0.0",
          capabilities: { requires: ["docs.write"] },
        },
      },
      nodes: [
        { id: "intake", kind: "input", schemaRef: "s" },
        { id: "draft", kind: "agent", promptRef: "p", role: "writer" },
        { id: "gate", kind: "approval", gateSchemaRef: "s", gates: ["send"] },
        { id: "send", kind: "tool", skillRef: "s", effect: "slack.post" },
        { id: "done", kind: "output", schemaRef: "s" },
      ],
      edges: [
        { from: "intake", to: "draft" },
        { from: "draft", to: "gate" },
        { from: "gate", to: "send", conditionId: "approved" },
        { from: "send", to: "done" },
      ],
    });

    expect(workflow.roles.writer?.capabilities.forbids).toEqual([]);
  });
});

describe("defineSkill, definePrompt and definePolicy", () => {
  test("a policy rule with no approvers does not have to say so", () => {
    // This is the shape a company package actually writes. Annotating the
    // literal with `PolicyPack` instead would force `approvers: []` onto a
    // deny, which has no one to escalate to.
    const pack = definePolicy({
      id: "acme.publish",
      version: "1.0.0",
      rules: [
        {
          id: "acme.no-export",
          action: "pii.export",
          decision: "deny",
          reason: "Member data never leaves the boundary.",
        },
      ],
    });

    expect(pack.grants).toEqual([]);
    expect(pack.rules[0]?.approvers).toEqual([]);
  });

  test("a skill's optional fields default", () => {
    const skill = defineSkill({
      id: "acme.slack-post",
      version: "1.0.0",
      inputRef: "acme.publish@1",
      outputRef: "acme.publish-result@1",
    });

    expect(skill).toEqual({
      id: "acme.slack-post",
      version: "1.0.0",
      inputRef: "acme.publish@1",
      outputRef: "acme.publish-result@1",
      requiredCapabilities: [],
      requiresSandbox: false,
    });
  });

  test("a prompt is versioned and its text is not optional", () => {
    const prompt = definePrompt({
      id: "acme.marketing.draft",
      version: "1.0.0",
      text: "Draft campaign copy from the brief.",
    });

    expect(prompt.version).toBe("1.0.0");
    expect(() =>
      definePrompt({ id: "acme.marketing.draft", version: "1.0.0", text: "" }),
    ).toThrow(/Invalid prompt definition/);
  });

  test("an id that is not a Forge identifier is refused", () => {
    expect(() =>
      defineSkill({
        id: "Acme Slack Post",
        version: "1.0.0",
        inputRef: "a",
        outputRef: "b",
      }),
    ).toThrow(/Invalid skill definition/);
    expect(() =>
      definePolicy({ id: "Acme Publish", version: "1.0.0" }),
    ).toThrow(/Invalid policy pack definition/);
  });
});
