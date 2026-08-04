import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { LocalStatus } from "./local-status.js";

describe("LocalStatus", () => {
  test("renders a loading state without stale resource claims", () => {
    const html = renderToStaticMarkup(
      <LocalStatus dependencies={[]} loading />,
    );

    expect(html).toContain("Loading local status");
    expect(html).not.toContain("unavailable");
  });

  test("renders a ready dependency state", () => {
    const html = renderToStaticMarkup(
      <LocalStatus dependencies={[{ name: "api", status: "healthy" }]} />,
    );

    expect(html).toContain("api");
    expect(html).toContain("healthy");
  });

  test("renders unavailable dependency state without leaking diagnostics", () => {
    const html = renderToStaticMarkup(
      <LocalStatus
        dependencies={[
          { name: "queue", status: "unavailable", detail: "token=secret" },
        ]}
      />,
    );

    expect(html).toContain("queue");
    expect(html).toContain("unavailable");
    expect(html).toContain("[REDACTED]");
    expect(html).not.toContain("token=secret");
  });
});
