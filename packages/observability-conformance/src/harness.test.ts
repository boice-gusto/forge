import { describe, expect, test } from "vitest";

import {
  PII_NEEDLES,
  PII_PROBE,
  PII_PROBE_SURVIVORS,
  PRINCIPAL_PROBE,
} from "./harness.js";

const serialisedProbe = JSON.stringify(PII_PROBE);

/**
 * The probes are the whole assertion. A needle that no longer appears in the
 * probe is a test that passes because nothing was ever pushed through — the
 * exact failure this package exists to prevent, one level up.
 */
describe("the probes actually probe", () => {
  test("every needle is really present in the probe that carries it", () => {
    for (const needle of PII_NEEDLES) {
      expect(serialisedProbe).toContain(needle);
    }
  });

  test("every survivor is really an attribute of the probe", () => {
    expect(PII_PROBE).toMatchObject(PII_PROBE_SURVIVORS);
  });

  test("no survivor is also a needle", () => {
    // An attribute that is expected to arrive and expected to be scrubbed
    // makes the suite unsatisfiable, which reads as a broken adapter.
    for (const value of Object.values(PII_PROBE_SURVIVORS)) {
      expect(PII_NEEDLES).not.toContain(String(value));
    }
  });

  test("the principal probe carries both a person and the reference to one", () => {
    expect(PRINCIPAL_PROBE.principal).toBe("ada.lovelace");
    expect(PRINCIPAL_PROBE.principalHash).not.toBe(PRINCIPAL_PROBE.principal);
  });
});
