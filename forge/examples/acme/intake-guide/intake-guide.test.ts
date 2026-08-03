import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("intake guide", () => {
  it("presents every intake-to-merge stage as an explanatory slide", async () => {
    const html = await readFile(new URL("./index.html", import.meta.url), "utf8");

    expect(html).toContain('class="deck"');
    expect(html.match(/class="slide(?: |\")/g)?.length).toBeGreaterThanOrEqual(
      8,
    );

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

    expect(html.match(/What happens/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html.match(/Why it matters/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html.match(/Benefit/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain("ArrowRight");
    expect(html).toContain("ArrowLeft");

    for (const link of [
      "../intake/slack.fixture.ts",
      "../intake/jira.fixture.ts",
      "../intake/intake-routing.acceptance.test.ts",
    ]) {
      expect(html).toContain(`href=\"${link}\"`);
    }
  });
});
