/**
 * Minimal semver range check for plugin compatibility (009 §13).
 *
 * Deliberately small and deliberately strict: an unrecognised range is *not*
 * satisfied. A loader that shrugged at a range it could not parse would admit
 * exactly the incompatible plugin the check exists to keep out.
 */

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parse(input: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(input.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compare(left: Version, right: Version): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

/** Supports an exact version, `^x.y.z`, `~x.y.z`, and `>=x.y.z`. */
export function satisfiesRange(version: string, range: string): boolean {
  const actual = parse(version);
  if (actual === undefined) return false;

  const trimmed = range.trim();
  const operator = /^(\^|~|>=)/.exec(trimmed)?.[1] ?? "";
  const wanted = parse(trimmed.slice(operator.length));
  if (wanted === undefined) return false;

  if (compare(actual, wanted) < 0) return false;

  if (operator === ">=") return true;
  if (operator === "~") {
    return actual.major === wanted.major && actual.minor === wanted.minor;
  }
  if (operator === "^") {
    // Pre-1.0.0 has no compatible range above the minor: 0.1.x and 0.2.x are
    // both breaking, which is how npm treats a caret on a 0.x version.
    return wanted.major === 0
      ? actual.major === 0 && actual.minor === wanted.minor
      : actual.major === wanted.major;
  }
  return compare(actual, wanted) === 0;
}
