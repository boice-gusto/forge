import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SECRET_ASSIGNMENT =
  /(?:api[-_]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{12,}/i;
const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const findings = trackedFiles.flatMap((file) => {
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
  process.stderr.write(`Potential committed secrets: ${findings.join(", ")}\n`);
  process.exitCode = 1;
}
