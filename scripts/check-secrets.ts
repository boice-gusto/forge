import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SECRET_ASSIGNMENT =
  /(?:api[-_]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{12,}/i;
/**
 * Tracked *and* untracked-but-not-ignored files.
 *
 * Scanning only tracked paths had the ordering exactly backwards: a secret in
 * a new file passed the check and was caught on the next run, once the file
 * was committed and the secret was already in history. A brand-new file is
 * precisely where a secret arrives.
 *
 * `--exclude-standard` still honours .gitignore, so `.env` and friends stay out.
 */
const candidateFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

/**
 * Binaries are read as UTF-8 by `readFileSync`, so random bytes can spell a
 * match. A compiled policy module is not somewhere a secret is written by
 * hand, and a false positive here would train people to ignore this check.
 */
const BINARY = /\.(wasm|png|jpe?g|gif|ico|pdf|zip|tgz|woff2?|ttf|node)$/i;

const findings = candidateFiles.flatMap((file) => {
  if (BINARY.test(file)) return [];
  // `git ls-files` lists tracked paths, which includes files deleted in the
  // working tree but not yet staged. Reading one throws, and a scan that
  // crashes is a scan that did not run — skip what cannot be read.
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return SECRET_ASSIGNMENT.test(content) ? [file] : [];
});

if (findings.length > 0) {
  process.stderr.write(`Potential secrets: ${findings.join(", ")}\n`);
  process.exitCode = 1;
}
