import type { Role } from "@forge/ir";
import { describe, expect, test } from "vitest";

import {
  composePanel,
  globToRegExp,
  type PanelDefinition,
  resolveVerdict,
} from "./panel.js";

const roles: Record<string, Role> = {
  architect: {
    version: "1.0.0",
    capabilities: { requires: ["repo.read"], forbids: ["repo.merge"] },
    review: { weight: 1.5, blocking: false },
  },
  "domain-qa": {
    version: "1.0.0",
    capabilities: { requires: ["repo.read"], forbids: [] },
    review: { weight: 2, blocking: false },
  },
  "security-reviewer": {
    version: "1.0.0",
    capabilities: { requires: ["repo.read"], forbids: ["repo.merge"] },
    review: { weight: 2, blocking: true },
    summon: { anyPathMatches: ["**/namedCredentials/**", "**/*Callout*"] },
  },
};

const definition: PanelDefinition = {
  standing: ["architect", "domain-qa"],
  summonable: ["security-reviewer"],
  quorum: 0.66,
};

describe("glob translation", () => {
  test("a single star stays within one segment", () => {
    expect(globToRegExp("*.cls").test("Renewal.cls")).toBe(true);
    expect(globToRegExp("*.cls").test("classes/Renewal.cls")).toBe(false);
  });

  test("a double star crosses separators", () => {
    expect(
      globToRegExp("**/namedCredentials/**").test(
        "force-app/main/default/namedCredentials/HI.xml",
      ),
    ).toBe(true);
    expect(globToRegExp("**/*Callout*").test("classes/CalloutHelper.cls")).toBe(
      true,
    );
    expect(globToRegExp("**/*Callout*").test("classes/Renewal.cls")).toBe(
      false,
    );
  });

  test("regex metacharacters in a glob are literal", () => {
    expect(globToRegExp("a+b.txt").test("a+b.txt")).toBe(true);
    expect(globToRegExp("a+b.txt").test("aab.txt")).toBe(false);
  });
});

describe("panel composition", () => {
  test("a docs-only change draws only the standing panel", () => {
    const panel = composePanel(roles, definition, {
      paths: ["docs/README.md"],
    });

    expect(panel.members.map((member) => member.name)).toEqual([
      "architect",
      "domain-qa",
    ]);
    expect(panel.summoned).toEqual([]);
    expect(panel.totalWeight).toBe(3.5);
    expect(panel.quorumWeight).toBe(2.31);
  });

  test("touching credentials summons the security reviewer with a veto", () => {
    const panel = composePanel(roles, definition, {
      paths: ["force-app/main/default/namedCredentials/HI.xml"],
    });

    expect(panel.members).toHaveLength(3);
    expect(panel.summoned.map((member) => member.reason)).toEqual(["summoned"]);
    expect(panel.blocking).toEqual(["security-reviewer"]);
  });

  test("panel size is a consequence of the change, not a constant", () => {
    const small = composePanel(roles, definition, { paths: ["docs/x.md"] });
    const large = composePanel(roles, definition, {
      paths: ["classes/CalloutHelper.cls"],
    });

    expect(small.members).toHaveLength(2);
    expect(large.members).toHaveLength(3);
  });

  test("an undeclared role in the definition is skipped, not invented", () => {
    const panel = composePanel(
      roles,
      {
        ...definition,
        standing: ["architect", "phantom"],
      },
      { paths: [] },
    );

    expect(panel.members.map((member) => member.name)).toEqual(["architect"]);
  });

  test("a summonable role without a predicate never joins", () => {
    const panel = composePanel(
      { ...roles, "no-predicate": { ...roles.architect } as Role },
      { ...definition, summonable: ["no-predicate"] },
      { paths: ["anything"] },
    );

    expect(panel.members.map((member) => member.name)).not.toContain(
      "no-predicate",
    );
  });
});

describe("verdict resolution", () => {
  const standing = composePanel(roles, definition, { paths: ["docs/x.md"] });
  const withVeto = composePanel(roles, definition, {
    paths: ["classes/CalloutHelper.cls"],
  });

  test("enough weight voting pass clears quorum", () => {
    expect(
      resolveVerdict(standing, { architect: "pass", "domain-qa": "pass" })
        .verdict,
    ).toBe("pass");
  });

  test("below quorum escalates to review rather than failing", () => {
    expect(
      resolveVerdict(standing, { architect: "pass", "domain-qa": "fail" })
        .verdict,
    ).toBe("review");
  });

  test("a blocking role voting fail overrides quorum", () => {
    const verdict = resolveVerdict(withVeto, {
      architect: "pass",
      "domain-qa": "pass",
      "security-reviewer": "fail",
    });

    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toContain("blocking role");
  });

  test("a missing vote fails closed to review, never to pass", () => {
    expect(resolveVerdict(standing, { architect: "pass" }).verdict).toBe(
      "review",
    );
  });

  test("an errored vote fails closed to review", () => {
    expect(
      resolveVerdict(standing, { architect: "pass", "domain-qa": "error" })
        .verdict,
    ).toBe("review");
  });

  test("an empty panel is never a pass", () => {
    const empty = composePanel(
      roles,
      {
        standing: [],
        summonable: [],
        quorum: 0.5,
      },
      { paths: [] },
    );

    expect(resolveVerdict(empty, {}).verdict).toBe("review");
  });
});
