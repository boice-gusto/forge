import type { Role } from "@forge/ir";

/**
 * Panel composition (ADR-009). A review panel is a consequence of what changed,
 * not a constant: standing roles sit on every panel, specialty roles are
 * summoned when their predicate matches — the routing idea CODEOWNERS applies
 * to human reviewers, extended to the agent panel.
 *
 * Pure: roles and a change description in, a panel out.
 */

export interface PanelDefinition {
  readonly standing: readonly string[];
  readonly summonable: readonly string[];
  /** Fraction of total weight that must vote pass. */
  readonly quorum: number;
}

export interface ChangeDescription {
  readonly paths: readonly string[];
}

export type MemberReason = "standing" | "summoned";

export interface PanelMember {
  readonly name: string;
  readonly weight: number;
  /** A blocking member's `fail` overrides quorum. */
  readonly blocking: boolean;
  readonly reason: MemberReason;
}

export interface ComposedPanel {
  readonly members: readonly PanelMember[];
  readonly summoned: readonly PanelMember[];
  readonly blocking: readonly string[];
  readonly totalWeight: number;
  readonly quorumWeight: number;
}

export type Vote = "pass" | "fail" | "error";

export type PanelVerdict = {
  readonly verdict: "pass" | "fail" | "review";
  readonly reason: string;
};

/** Translate a CODEOWNERS-style glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let index = 0;
  while (index < glob.length) {
    const character = glob[index] as string;
    if (character === "*") {
      const doubled = glob[index + 1] === "*";
      if (doubled && glob[index + 2] === "/") {
        pattern += "(?:.*/)?"; // any number of leading segments
        index += 3;
        continue;
      }
      if (doubled) {
        pattern += ".*"; // crosses separators
        index += 2;
        continue;
      }
      pattern += "[^/]*"; // stays within one segment
      index += 1;
      continue;
    }
    if (character === "?") {
      pattern += "[^/]";
      index += 1;
      continue;
    }
    pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

function matchesAny(
  globs: readonly string[],
  paths: readonly string[],
): boolean {
  const compiled = globs.map(globToRegExp);
  return paths.some((path) => compiled.some((rule) => rule.test(path)));
}

function toMember(name: string, role: Role, reason: MemberReason): PanelMember {
  return {
    name,
    weight: role.review?.weight ?? 1,
    blocking: role.review?.blocking === true,
    reason,
  };
}

export function composePanel(
  roles: Readonly<Record<string, Role>>,
  definition: PanelDefinition,
  change: ChangeDescription,
): ComposedPanel {
  const members: PanelMember[] = [];
  const summoned: PanelMember[] = [];

  for (const name of definition.standing) {
    const role = roles[name];
    if (role === undefined) continue;
    members.push(toMember(name, role, "standing"));
  }

  for (const name of definition.summonable) {
    const role = roles[name];
    if (role?.summon === undefined) continue;
    if (!matchesAny(role.summon.anyPathMatches, change.paths)) continue;
    const member = toMember(name, role, "summoned");
    members.push(member);
    summoned.push(member);
  }

  const totalWeight = members.reduce((sum, member) => sum + member.weight, 0);

  return {
    members,
    summoned,
    blocking: members.filter((member) => member.blocking).map((m) => m.name),
    totalWeight,
    quorumWeight: Math.round(totalWeight * definition.quorum * 1000) / 1000,
  };
}

/**
 * Resolve a verdict. Fails closed: a missing or errored vote escalates to
 * review rather than passing, and a blocking role voting fail overrides
 * quorum however much weight agrees with it.
 */
export function resolveVerdict(
  panel: ComposedPanel,
  votes: Readonly<Record<string, Vote>>,
): PanelVerdict {
  if (panel.members.length === 0) {
    return { verdict: "review", reason: "No reviewer was assigned." };
  }

  for (const member of panel.members) {
    const vote = votes[member.name];
    if (vote === undefined || vote === "error") {
      return {
        verdict: "review",
        reason: `${member.name} did not return a usable verdict.`,
      };
    }
    if (vote === "fail" && member.blocking) {
      return {
        verdict: "fail",
        reason: `${member.name} is a blocking role and voted fail.`,
      };
    }
  }

  const passing = panel.members
    .filter((member) => votes[member.name] === "pass")
    .reduce((sum, member) => sum + member.weight, 0);

  return passing >= panel.quorumWeight
    ? {
        verdict: "pass",
        reason: `Weighted pass ${passing} meets quorum ${panel.quorumWeight}.`,
      }
    : {
        verdict: "review",
        reason: `Weighted pass ${passing} is below quorum ${panel.quorumWeight}.`,
      };
}
