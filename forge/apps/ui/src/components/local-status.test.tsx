import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { LocalStatus } from "./local-status.js";

describe("LocalStatus", () => {
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
