import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("intake guide", () => {
  it("documents the intake-to-merge flow with local source links", async () => {
    const html = await readFile(new URL("./index.html", import.meta.url), "utf8");

    for (const text of [
      "Normalize intake",
      "Validate & authenticate",
      "Policy decision",
      "Human approval",
      "Durable effect",
      "Review & merge",
      "marketing-launches",
      "marketing.campaign-brief",
      "ENG-42",
      "engineering.change-brief",
      "deterministic simulations",
    ]) {
      expect(html).toContain(text);
    }

    for (const link of [
      "../intake/slack.fixture.ts",
      "../intake/jira.fixture.ts",
      "../intake/intake-routing.acceptance.test.ts",
    ]) {
      expect(html).toContain(`href=\"${link}\"`);
    }
  });
});
