import { execFileSync } from "node:child_process";

/**
 * Refuse a dependency licence this product cannot ship.
 *
 * This script used to print the licence set and fail only when the inventory
 * was empty — so it passed with anything, including AGPL or SSPL, while sitting
 * in CI looking like a gate. A check that cannot fail is worse than no check,
 * because it answers the question nobody then asks again.
 *
 * Forge is proprietary and runs payroll systems. Strong copyleft is a legal
 * problem here, not a preference.
 */

/** Permissive: use, modify and ship closed, with attribution. */
const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MIT OR Apache-2.0",
  "Python-2.0",
  "Unlicense",
  /**
   * Weak, file-level copyleft: modifying an MPL file obliges you to publish
   * that file, but linking does not reach your own code. Tolerable for the
   * build-time CSS toolchain that brings it in. If one ever appears in a
   * shipped runtime path, revisit rather than widening this list.
   */
  "MPL-2.0",
]);

interface LicensedPackage {
  readonly name: string;
}

const inventory = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

const byLicense = JSON.parse(inventory) as Record<string, LicensedPackage[]>;
const licenses = Object.keys(byLicense);

if (licenses.length === 0) {
  throw new Error("Dependency license inventory is empty.");
}

const refused = licenses
  .filter((license) => !ALLOWED.has(license))
  .map((license) => {
    const names = [
      ...new Set((byLicense[license] ?? []).map((entry) => entry.name)),
    ].sort();
    return `  ${license}: ${names.join(", ")}`;
  });

if (refused.length > 0) {
  process.stderr.write(
    `Dependency licences this product cannot ship:\n${refused.join("\n")}\n\n` +
      "Replace the dependency, or add the licence to ALLOWED in this script " +
      "with the reason it is acceptable.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      status: "ok",
      licenses: licenses.sort(),
      packages: Object.values(byLicense).flat().length,
    })}\n`,
  );
}
