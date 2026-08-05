import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Proves the public packages are consumable from outside this workspace.
 *
 * Company packages live in sibling repositories. Until this existed they could
 * only be tested with core's *source* on disk, resolved through path aliases —
 * so "Forge is extended, not forked" rested on an arrangement no real consumer
 * could reproduce. This packs the public surface exactly as a publish would,
 * installs it into a throwaway project with no access to this repository, and
 * uses it.
 *
 * Slow by nature (a real install), so it is its own CI step rather than part of
 * `pnpm test`.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_PACKAGES = ["types", "manifest", "plugin-sdk", "sdk"] as const;

const run = (command: string, args: readonly string[], cwd: string): string =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: "pipe" });

const failures: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "forge-packaging-"));
const vendor = join(scratch, "vendor");

try {
  run("pnpm", ["build"], REPO_ROOT);

  const tarballs = new Map<string, string>();
  for (const name of PUBLIC_PACKAGES) {
    const directory = join(REPO_ROOT, "packages", name);
    run("pnpm", ["pack", "--pack-destination", vendor], directory);
    const tarball = `forge-${name}-${
      JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
        .version as string
    }.tgz`;
    tarballs.set(`@forge/${name}`, `file:./vendor/${tarball}`);

    // A tarball carrying `src/` would let a consumer import past the entry
    // point and depend on internals that are free to move.
    const listing = run("tar", ["-tzf", join(vendor, tarball)], scratch);
    if (listing.includes("package/src/")) {
      failures.push(`${name}: tarball ships src/, not just built output`);
    }
    if (!listing.includes("package/dist/index.d.ts")) {
      failures.push(`${name}: tarball has no type declarations`);
    }
  }

  writeFileSync(
    join(scratch, "package.json"),
    `${JSON.stringify(
      {
        name: "forge-packaging-probe",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          [...tarballs].filter(([name]) => name !== "@forge/types"),
        ),
      },
      null,
      2,
    )}\n`,
  );

  // Transitive `@forge/*` deps were rewritten from `workspace:*` to a real
  // version at pack time, so they resolve against a registry unless pointed
  // back at the tarballs. pnpm 11 reads overrides from here, not package.json.
  writeFileSync(
    join(scratch, "pnpm-workspace.yaml"),
    `overrides:\n${[...tarballs]
      .map(([name, path]) => `  "${name}": "${path}"`)
      .join("\n")}\n`,
  );

  writeFileSync(
    join(scratch, "probe.mjs"),
    `import { defineWorkflow, definePolicy } from "@forge/manifest";
import { registerPlugins } from "@forge/plugin-sdk";
import { createForgeClient } from "@forge/sdk";

const workflow = defineWorkflow({
  id: "probe.standalone", version: "1.0.0",
  sideEffects: ["slack.post"], grantedCapabilities: [], roles: {},
  nodes: [
    { id: "in", kind: "input", schemaRef: "s@1" },
    { id: "gate", kind: "approval", gateSchemaRef: "g@1", gates: ["act"] },
    { id: "act", kind: "tool", skillRef: "t@1", effect: "slack.post" },
    { id: "out", kind: "output", schemaRef: "s@1" },
  ],
  edges: [
    { from: "in", to: "gate" }, { from: "gate", to: "act" },
    { from: "act", to: "out" },
  ],
});

const result = await registerPlugins([{
  manifest: { id: "probe.plugin", version: "1.0.0", forgeVersion: "^0.1.0" },
  register(context) {
    context.workflows.add(workflow);
    context.policies.add(definePolicy({
      id: "probe.pack", version: "1.0.0", grants: ["slack.write"],
      rules: [{ id: "probe.rule", action: "slack.post",
                decision: "require-approval", reason: "human",
                approvers: ["lead"] }],
    }));
  },
}], {
  companyId: "probe", hostCapabilities: ["slack.write"],
  forgeVersion: "0.1.0",
});

if (!result.ok) {
  throw new Error("registration failed: " + JSON.stringify(result.diagnostics));
}
if (result.registry.workflows.get("probe.standalone") === undefined) {
  throw new Error("the contributed workflow is missing from the registry");
}
if (typeof createForgeClient({ baseUrl: "http://x", token: "t" }).getRun !== "function") {
  throw new Error("the SDK client is not usable");
}
console.log("ok");
`,
  );

  // Not `--ignore-workspace`: that also ignores `pnpm-workspace.yaml`, which is
  // where the overrides live. The scratch directory is its own workspace root,
  // well outside this repository, which is the isolation that matters.
  run("pnpm", ["install"], scratch);
  const output = run("node", ["probe.mjs"], scratch);
  if (!output.includes("ok")) {
    failures.push(`the packed surface did not work: ${output}`);
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  failures.push(
    `${detail}${stderr === undefined ? "" : `\n${String(stderr)}`}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stderr.write(
    `Packaging is not consumable:\n- ${failures.join("\n- ")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Packed ${PUBLIC_PACKAGES.length} public packages and used them from outside the workspace.\n`,
  );
}
