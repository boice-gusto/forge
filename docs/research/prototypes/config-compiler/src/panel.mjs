/**
 * Panel composition — prototype.
 *
 * The review panel is a consequence of what changed, not a constant. Standing
 * roles sit on every panel; specialty roles are summoned when their predicate
 * matches the changed paths. This is the same routing idea CODEOWNERS already
 * applies to human reviewers, extended to the agent panel.
 *
 * Pure: takes a role table and a list of changed paths, returns a panel.
 */

/** Translate a CODEOWNERS-style glob into an anchored regular expression. */
export function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      const doubled = glob[i + 1] === '*';
      if (doubled && glob[i + 2] === '/') {
        re += '(?:.*/)?';       // **/ matches any number of leading segments
        i += 3;
        continue;
      }
      if (doubled) {
        re += '.*';             // ** matches across separators
        i += 2;
        continue;
      }
      re += '[^/]*';            // * stays within one segment
      i += 1;
      continue;
    }
    if (ch === '?') { re += '[^/]'; i += 1; continue; }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(globs, paths) {
  const compiled = globs.map(globToRegExp);
  return paths.some((p) => compiled.some((rx) => rx.test(p)));
}

/**
 * @param {object} roles   role table keyed by role name
 * @param {object} panel   { standing, summonable, quorum }
 * @param {object} change  { paths: string[], declares: string[] }
 * @returns {{members, summoned, blocking, weight, quorumNeeded}}
 */
export function composePanel(roles, panel, change) {
  const paths = change?.paths ?? [];
  const declares = new Set(change?.declares ?? []);

  const members = [];
  for (const name of panel.standing ?? []) {
    const role = roles[name];
    if (!role) continue;
    members.push({ name, weight: role.review?.weight ?? 1, blocking: role.review?.blocking === true, reason: 'standing' });
  }

  const summoned = [];
  for (const name of panel.summonable ?? []) {
    const role = roles[name];
    if (!role?.summon?.when) continue;
    const when = role.summon.when;
    let hit = null;
    if (when.anyPathMatches && matchesAny(when.anyPathMatches, paths)) hit = 'path';
    if (!hit && when.declares && when.declares.some((d) => declares.has(d))) hit = 'declaration';
    if (!hit) continue;
    const entry = { name, weight: role.review?.weight ?? 1, blocking: role.review?.blocking === true, reason: hit };
    members.push(entry);
    summoned.push(entry);
  }

  const weight = members.reduce((sum, m) => sum + m.weight, 0);
  const quorum = panel.quorum?.weighted ?? 0.5;

  return {
    members,
    summoned,
    blocking: members.filter((m) => m.blocking).map((m) => m.name),
    weight,
    quorumNeeded: Math.round(weight * quorum * 1000) / 1000,
  };
}

/**
 * Resolve a panel verdict. Fail closed: any error, or a blocking role voting
 * fail, escalates to review — never to pass.
 */
export function resolveVerdict(panel, votes) {
  for (const m of panel.members) {
    const vote = votes[m.name];
    if (vote === undefined || vote === 'error') return { verdict: 'review', reason: `${m.name} did not return a usable verdict` };
    if (vote === 'fail' && m.blocking) return { verdict: 'fail', reason: `${m.name} is a blocking role and voted fail` };
  }
  const passing = panel.members
    .filter((m) => votes[m.name] === 'pass')
    .reduce((sum, m) => sum + m.weight, 0);
  if (passing >= panel.quorumNeeded) return { verdict: 'pass', reason: `weighted pass ${passing} >= ${panel.quorumNeeded}` };
  return { verdict: 'review', reason: `weighted pass ${passing} < ${panel.quorumNeeded}` };
}
