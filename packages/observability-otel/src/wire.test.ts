import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  PII_NEEDLES,
  PII_PROBE,
  PRINCIPAL_PROBE,
} from "@forge/observability-conformance";
import { afterEach, describe, expect, test } from "vitest";

import { createOtelObservability } from "./observability.js";

interface Delivery {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Collector {
  readonly url: string;
  readonly deliveries: readonly Delivery[];
  close(): Promise<void>;
}

/**
 * A real OTLP/HTTP endpoint on a port the OS picks. Nothing here inspects the
 * adapter: it sees only what came over the socket, which is the only view that
 * settles what a collector would actually have received.
 */
async function collector(): Promise<Collector> {
  const deliveries: Delivery[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    deliveries,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

let open: Collector | undefined;

afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function receiving(): Promise<Collector> {
  open = await collector();
  return open;
}

/**
 * The claim the rest of the suite depends on, made where it cannot be faked: a
 * payload does not leave the process. Everything before this point is an
 * assertion about an object in memory; this is an assertion about bytes on a
 * socket.
 */
describe("nothing sensitive reaches the collector", () => {
  test("no probe value appears anywhere in the exported payload", async () => {
    const sink = await receiving();
    const observability = createOtelObservability({
      endpoint: sink.url,
      env: {},
      shutdownTimeoutMs: 2_000,
    });

    // Three separate spans, because a payload arriving at the open of one and
    // being overwritten at its close would hide a hole in the opening path.
    observability.startSpan("forge.node.agent", PII_PROBE).end();
    observability
      .startSpan("forge.node.judge", { nodeId: "review" })
      .end(PII_PROBE);
    observability.event("forge.approval.decided", PRINCIPAL_PROBE);
    await observability.shutdown();

    const wire = sink.deliveries.map((delivery) => delivery.body).join("");
    expect(wire).not.toBe("");
    for (const needle of [...PII_NEEDLES, "ada.lovelace", "u_88"]) {
      expect(wire).not.toContain(needle);
    }
  });

  test("the span still says enough to find the run", async () => {
    // A collector that receives nothing also contains no PII. This is what
    // stops that from counting as a pass.
    const sink = await receiving();
    const observability = createOtelObservability({
      endpoint: sink.url,
      env: {},
      shutdownTimeoutMs: 2_000,
    });

    observability.event("forge.approval.decided", PRINCIPAL_PROBE);
    await observability.shutdown();

    const wire = sink.deliveries.map((delivery) => delivery.body).join("");
    expect(wire).toContain("forge.approval.decided");
    expect(wire).toContain("9f2a5c1e4b7d0a63");
    expect(wire).toContain("run_1");
  });
});

interface WireSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
}

/** Every span in every delivery, as OTLP/JSON put them on the socket. */
function wireSpans(sink: Collector): readonly WireSpan[] {
  return sink.deliveries.flatMap((delivery) => {
    const payload = JSON.parse(delivery.body) as {
      resourceSpans?: readonly {
        scopeSpans?: readonly { spans?: readonly WireSpan[] }[];
      }[];
    };
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    );
  });
}

function wireSpan(sink: Collector, name: string): WireSpan {
  const found = wireSpans(sink).find((span) => span.name === name);
  if (found === undefined) {
    throw new Error(
      `${name} never reached the collector; it received ${
        wireSpans(sink)
          .map((span) => span.name)
          .join(", ") || "nothing"
      }.`,
    );
  }
  return found;
}

/**
 * The parenting claim, made where it cannot be faked. The conformance suite
 * reads a `ReadableSpan` the adapter handed an exporter; this reads the bytes,
 * which is the only view that settles whether a backend would draw one trace
 * or four unrelated ones.
 */
describe("a run arrives at the collector as one trace", () => {
  test("the node spans carry the run's span as their parent, in its trace", async () => {
    const sink = await receiving();
    const observability = createOtelObservability({
      endpoint: sink.url,
      env: {},
      shutdownTimeoutMs: 2_000,
    });

    // Two children, not one: a single child would pass even if the adapter
    // parented on whatever it happened to have started last.
    const run = observability.startSpan("forge.run.start", { runId: "run_1" });
    observability.startSpan("forge.node.agent", { runId: "run_1" }, run).end();
    observability.event("forge.effect.dispatched", { runId: "run_1" }, run);
    // Started with no parent, so a trace still shows what does not belong.
    observability.startSpan("forge.node.judge", { runId: "run_1" }).end();
    run.end({ status: "SUCCEEDED" });
    await observability.shutdown();

    const parent = wireSpan(sink, "forge.run.start");
    const agent = wireSpan(sink, "forge.node.agent");
    const dispatched = wireSpan(sink, "forge.effect.dispatched");
    const orphan = wireSpan(sink, "forge.node.judge");

    expect(parent.parentSpanId ?? "").toBe("");
    expect(agent.parentSpanId).toBe(parent.spanId);
    expect(dispatched.parentSpanId).toBe(parent.spanId);
    // A parent id without a shared trace id is a dangling reference, and a
    // backend would still draw two traces.
    expect(agent.traceId).toBe(parent.traceId);
    expect(dispatched.traceId).toBe(parent.traceId);

    expect(orphan.parentSpanId ?? "").toBe("");
    expect(orphan.traceId).not.toBe(parent.traceId);
  });
});

describe("the transport is configured, not compiled in", () => {
  test("the service name and auth header come from the environment", async () => {
    const sink = await receiving();
    const observability = createOtelObservability({
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: sink.url.replace("/v1/traces", ""),
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20from-the-env",
        OTEL_SERVICE_NAME: "forge-worker",
      },
      shutdownTimeoutMs: 2_000,
    });

    observability.event("forge.run.succeeded", { runId: "run_1" });
    await observability.shutdown();

    const [delivery] = sink.deliveries;
    expect(delivery?.headers.authorization).toBe("Bearer from-the-env");
    expect(delivery?.body).toContain("forge-worker");
  });
});

describe("a run is not held up by the collector", () => {
  test("recording and shutdown both return when nothing is listening", async () => {
    const sink = await receiving();
    const url = sink.url;
    await sink.close();
    open = undefined;

    const observability = createOtelObservability({
      endpoint: url,
      env: {},
      shutdownTimeoutMs: 500,
    });

    expect(() => {
      observability
        .startSpan("forge.run.start", { runId: "run_1" })
        .end({ status: "SUCCEEDED" });
    }).not.toThrow();
    await expect(observability.shutdown()).resolves.toBeUndefined();
  });

  test("shutdown returns even though the collector never answers", async () => {
    // The socket is accepted and then ignored, which is how an overloaded
    // collector behaves and is worse than one that is simply down.
    const stalled = createServer(() => undefined);
    await new Promise<void>((resolve) => {
      stalled.listen(0, "127.0.0.1", resolve);
    });
    const { port } = stalled.address() as AddressInfo;

    const observability = createOtelObservability({
      endpoint: `http://127.0.0.1:${port}/v1/traces`,
      env: {},
      batch: { exportTimeoutMillis: 100 },
      shutdownTimeoutMs: 300,
    });
    observability.event("forge.effect.dispatched", { runId: "run_1" });

    const started = Date.now();
    await expect(observability.shutdown()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);

    stalled.closeAllConnections();
    await new Promise<void>((resolve) => {
      stalled.close(() => resolve());
    });
  });
});
