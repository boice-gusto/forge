import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadYaml } from './src/yaml.mjs';
import { CODES, COMPILER_VERSION, compile, fingerprint, formatDiagnostics } from './src/compile.mjs';
import { composePanel, globToRegExp, resolveVerdict } from './src/panel.mjs';

const read = (rel) => loadYaml(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const validConfig = () => ({
  workflow: read('./fixtures/valid/workflow.yml'),
  roles: read('./fixtures/valid/roles.yml'),
  panel: read('./fixtures/valid/panel.yml'),
  policy: read('./fixtures/valid/policy.yml'),
});

const codes = (result) => result.diagnostics.map((d) => d.code);

/* ------------------------------------------------------------------ loader */

test('yaml subset loads nested maps, sequences of maps, and inline arrays', () => {
  const wf = read('./fixtures/valid/workflow.yml');
  assert.equal(wf.id, 'fullsend.product-lifecycle');
  assert.equal(wf.version, '2.0.0');
  assert.deepEqual(wf.sideEffects, ['github.pr.open', 'feature-flag.set']);
  assert.equal(wf.nodes.length, 8);
  assert.deepEqual(wf.nodes[0], { id: 'kickoff', kind: 'input' });

  const gate = wf.nodes.find((n) => n.id === 'human-gate');
  assert.deepEqual(gate.gates, ['ship'], 'inline array parses to a real array');

  const skeptic = wf.nodes.find((n) => n.id === 'skeptic');
  assert.equal(skeptic.required, true, 'bare true parses as boolean');

  assert.equal(wf.edges.length, 7);
  assert.deepEqual(wf.edges[0], { from: 'kickoff', to: 'intake' });

  const roles = read('./fixtures/valid/roles.yml');
  assert.equal(roles.architect.review.weight, 1.5, 'floats parse');
  assert.deepEqual(roles['security-reviewer'].summon.when.anyPathMatches,
    ['**/namedCredentials/**', '**/*Callout*'], 'quoted globs survive');
});

/* ----------------------------------------------------------------- compiles */

test('a well-formed config compiles to a sealed artifact', () => {
  const result = compile(validConfig());
  assert.deepEqual(result.diagnostics, [], 'no diagnostics');
  assert.equal(result.ok, true);
  assert.equal(result.artifact.workflowId, 'fullsend.product-lifecycle');
  assert.equal(result.artifact.compilerVersion, COMPILER_VERSION);
  assert.match(result.artifact.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.artifact.publicSurface.approvalGates, ['intake', 'human-gate']);
  assert.deepEqual(result.artifact.publicSurface.declaredEffects, ['feature-flag.set', 'github.pr.open']);
});

test('the fingerprint is deterministic and moves when any declaration changes', () => {
  const a = compile(validConfig()).artifact.fingerprint;
  const b = compile(validConfig()).artifact.fingerprint;
  assert.equal(a, b, 'same inputs, same fingerprint');

  const bumped = validConfig();
  bumped.roles.architect.review.weight = 1.6;
  assert.notEqual(compile(bumped).artifact.fingerprint, a, 'a role change moves the fingerprint');

  const other = validConfig();
  other.workflow.version = '2.0.1';
  assert.notEqual(compile(other).artifact.fingerprint, a, 'a version bump moves the fingerprint');

  assert.notEqual(
    fingerprint({ x: 1 }, COMPILER_VERSION),
    fingerprint({ x: 1 }, '0.2.0-prototype'),
    'the compiler version is part of the fingerprint',
  );
});

/* -------------------------------------------------------------- diagnostics */

test('WF_MISSING_APPROVAL — a path reaches a side effect without its gate', () => {
  const config = validConfig();
  config.workflow = read('./fixtures/broken/missing-approval.workflow.yml');
  const result = compile(config);
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes(CODES.MISSING_APPROVAL));
  assert.equal(result.artifact, null, 'no artifact is produced');
  const d = result.diagnostics.find((x) => x.code === CODES.MISSING_APPROVAL);
  assert.match(d.path, /nodes\[ship\]/);
  assert.match(d.message, /without passing its approval gate/);
});

test('WF_MISSING_APPROVAL — an unrelated earlier approval does not authorise an effect', () => {
  const config = validConfig();
  // Drop the binding: human-gate stops naming the effect it gates.
  config.workflow.nodes.find((n) => n.id === 'human-gate').gates = [];
  const result = compile(config);
  assert.ok(codes(result).includes(CODES.MISSING_APPROVAL));
  assert.match(
    result.diagnostics.find((d) => d.code === CODES.MISSING_APPROVAL).message,
    /no approval node declares this effect/,
  );
});

test('WF_CAPABILITY_UNBOUND — a role may not exceed the policy closure', () => {
  const config = validConfig();
  config.roles = read('./fixtures/broken/unbound.roles.yml');
  const result = compile(config);
  assert.equal(result.ok, false);
  const d = result.diagnostics.find((x) => x.code === CODES.CAPABILITY_UNBOUND);
  assert.ok(d, 'diagnostic fires');
  assert.match(d.path, /roles\/builder\.yml · requires: prod\.write/);
  assert.match(d.message, /exceeds the static policy closure/);
});

test('WF_CAPABILITY_UNBOUND — a role may not require what it forbids', () => {
  const config = validConfig();
  config.roles.architect.capabilities.requires.push('repo.merge');
  const result = compile(config);
  const d = result.diagnostics.find((x) => x.code === CODES.CAPABILITY_UNBOUND);
  assert.match(d.message, /both requires and forbids/);
});

test('WF_UNKNOWN_ROLE — a node cannot reference a role that is not declared', () => {
  const config = validConfig();
  config.workflow = read('./fixtures/broken/unknown-role.workflow.yml');
  const result = compile(config);
  assert.equal(result.ok, false);
  const d = result.diagnostics.find((x) => x.code === CODES.UNKNOWN_ROLE);
  assert.match(d.message, /"designer" is not declared/);
});

test('WF_BYPASSABLE_REQUIRED_NODE — the skeptic cannot be skippable', () => {
  const config = validConfig();
  config.workflow = read('./fixtures/broken/bypassable.workflow.yml');
  const result = compile(config);
  assert.equal(result.ok, false);
  const d = result.diagnostics.find((x) => x.code === CODES.BYPASSABLE_REQUIRED_NODE);
  assert.ok(d, 'the real full-send misfire is a compile error here');
  assert.match(d.path, /nodes\[skeptic\]/);
});

test('WF_UNDECLARED_EFFECT — an effect must appear in sideEffects[]', () => {
  const config = validConfig();
  config.workflow.nodes.find((n) => n.id === 'ship').effect = 'prod.database.write';
  const result = compile(config);
  assert.ok(codes(result).includes(CODES.UNDECLARED_EFFECT));
});

test('WF_CYCLE — a dependency cycle is refused', () => {
  const config = validConfig();
  config.workflow.edges.push({ from: 'build', to: 'discovery' });
  const result = compile(config);
  assert.ok(codes(result).includes(CODES.CYCLE));
});

test('diagnostics render in the shape the deck shows', () => {
  const config = validConfig();
  config.workflow = read('./fixtures/broken/missing-approval.workflow.yml');
  const text = formatDiagnostics(compile(config).diagnostics);
  assert.match(text, /^WF_MISSING_APPROVAL/);
  assert.match(text, /suggestion:/);
  assert.match(text, /0 artifacts produced · compile failed/);
});

/* --------------------------------------------------------------- the panel */

test('glob translation is segment-aware', () => {
  assert.ok(globToRegExp('**/namedCredentials/**').test('force-app/main/default/namedCredentials/x.xml'));
  assert.ok(globToRegExp('**/*Callout*').test('force-app/classes/CalloutHelper.cls'));
  assert.ok(!globToRegExp('**/*Callout*').test('force-app/classes/Renewal.cls'));
  assert.ok(!globToRegExp('*.cls').test('a/b.cls'), 'a single star does not cross a separator');
});

test('a docs-only change draws only the standing panel', () => {
  const { roles, panel } = validConfig();
  const composed = composePanel(roles, panel, { paths: ['docs/README.md'] });
  assert.deepEqual(composed.members.map((m) => m.name), ['architect', 'domain-qa']);
  assert.deepEqual(composed.summoned, []);
  assert.equal(composed.weight, 3.5);
});

test('touching credentials summons the security reviewer, with a veto', () => {
  const { roles, panel } = validConfig();
  const composed = composePanel(roles, panel, {
    paths: ['force-app/main/default/namedCredentials/HI.namedCredential-meta.xml'],
  });
  assert.deepEqual(composed.members.map((m) => m.name), ['architect', 'domain-qa', 'security-reviewer']);
  assert.deepEqual(composed.summoned.map((m) => m.reason), ['path']);
  assert.deepEqual(composed.blocking, ['security-reviewer']);
});

test('declaring a backfill summons the migration reviewer', () => {
  const { roles, panel } = validConfig();
  const composed = composePanel(roles, panel, { paths: ['x.cls'], declares: ['backfill'] });
  assert.ok(composed.members.some((m) => m.name === 'migration-reviewer'));
  assert.deepEqual(composed.summoned.map((m) => m.reason), ['declaration']);
});

test('panel size is a consequence of the change, not a constant', () => {
  const { roles, panel } = validConfig();
  const small = composePanel(roles, panel, { paths: ['docs/x.md'] });
  const large = composePanel(roles, panel, {
    paths: ['force-app/main/default/namedCredentials/a.xml'],
    declares: ['backfill'],
  });
  assert.equal(small.members.length, 2);
  assert.equal(large.members.length, 4);
});

/* --------------------------------------------------------------- verdicts */

test('a blocking role fails the panel regardless of quorum', () => {
  const { roles, panel } = validConfig();
  const composed = composePanel(roles, panel, {
    paths: ['force-app/main/default/namedCredentials/a.xml'],
  });
  const verdict = resolveVerdict(composed, {
    architect: 'pass', 'domain-qa': 'pass', 'security-reviewer': 'fail',
  });
  assert.equal(verdict.verdict, 'fail');
  assert.match(verdict.reason, /blocking role/);
});

test('a missing or errored vote fails closed to review, never to pass', () => {
  const { roles, panel } = validConfig();
  const composed = composePanel(roles, panel, { paths: ['docs/x.md'] });
  assert.equal(resolveVerdict(composed, { architect: 'pass' }).verdict, 'review');
  assert.equal(resolveVerdict(composed, { architect: 'pass', 'domain-qa': 'error' }).verdict, 'review');
});

test('weighted quorum passes when enough weight votes pass', () => {
  const { roles, panel } = validConfig();
  const composed = composePanel(roles, panel, { paths: ['docs/x.md'] });
  assert.equal(composed.quorumNeeded, 2.31);
  assert.equal(resolveVerdict(composed, { architect: 'pass', 'domain-qa': 'pass' }).verdict, 'pass');
  assert.equal(resolveVerdict(composed, { architect: 'pass', 'domain-qa': 'fail' }).verdict, 'review');
});
