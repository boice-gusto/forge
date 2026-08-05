import { describe, expect, test } from "vitest";

import {
  parseHeaders,
  resolveHeaders,
  resolveServiceName,
  resolveTracesEndpoint,
} from "./environment.js";

describe("the destination comes from the environment and nowhere else", () => {
  test("the traces endpoint is used exactly as configured", () => {
    expect(
      resolveTracesEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.test/ingest",
      }),
    ).toBe("https://collector.test/ingest");
  });

  test("a base endpoint gains the OTLP traces path, once", () => {
    expect(
      resolveTracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.test//",
      }),
    ).toBe("https://collector.test/v1/traces");
  });

  test("the signal-specific endpoint wins over the shared one", () => {
    expect(
      resolveTracesEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://shared.test",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.test/v1/traces",
      }),
    ).toBe("https://traces.test/v1/traces");
  });

  test("an explicit endpoint wins over both", () => {
    expect(
      resolveTracesEndpoint(
        { OTEL_EXPORTER_OTLP_ENDPOINT: "https://shared.test" },
        "https://explicit.test/v1/traces",
      ),
    ).toBe("https://explicit.test/v1/traces");
  });

  test("an unconfigured adapter refuses to be constructed", () => {
    // There is no built-in default. A default endpoint is an endpoint that
    // lives in the repository, and the token that reaches it follows.
    expect(() => resolveTracesEndpoint({})).toThrow(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    );
    expect(() =>
      resolveTracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }),
    ).toThrow("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  });
});

describe("headers are read, never written down", () => {
  test("the specification's comma-separated form is parsed and decoded", () => {
    expect(
      parseHeaders("authorization=Bearer%20abc,x-scope=forge%2Fworker"),
    ).toEqual({ authorization: "Bearer abc", "x-scope": "forge/worker" });
  });

  test("no headers configured is no headers, not a crash", () => {
    expect(parseHeaders(undefined)).toEqual({});
    expect(parseHeaders("   ")).toEqual({});
  });

  test("a malformed entry is dropped rather than thrown on", () => {
    // A header the operator mistyped must not be the reason a payroll run
    // refuses to start.
    expect(parseHeaders("broken,=novalue, =blank,ok=1,bad%=%E0%A4%A")).toEqual({
      ok: "1",
      "bad%": "%E0%A4%A",
    });
  });

  test("the signal-specific headers layer over the shared ones", () => {
    expect(
      resolveHeaders(
        {
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=shared,x-team=platform",
          OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=traces",
        },
        { "x-forge": "1" },
      ),
    ).toEqual({
      authorization: "traces",
      "x-team": "platform",
      "x-forge": "1",
    });
  });
});

describe("the service name identifies the process", () => {
  test("it comes from the environment, and falls back to forge", () => {
    expect(resolveServiceName({ OTEL_SERVICE_NAME: "forge-worker" })).toBe(
      "forge-worker",
    );
    expect(resolveServiceName({})).toBe("forge");
    expect(resolveServiceName({ OTEL_SERVICE_NAME: "" }, "forge-api")).toBe(
      "forge-api",
    );
  });
});
