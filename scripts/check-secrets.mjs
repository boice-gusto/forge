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
  const content = readFileSync(file, "utf8");
  return SECRET_ASSIGNMENT.test(content) ? [file] : [];
});

if (findings.length > 0) {
  process.stderr.write(`Potential committed secrets: ${findings.join(", ")}\n`);
  process.exitCode = 1;
}
