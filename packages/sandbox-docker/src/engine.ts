import { request as httpRequest } from "node:http";

/**
 * The slice of the Docker Engine API this adapter needs, spoken directly over
 * the daemon socket.
 *
 * Directly, rather than through `dockerode` or Testcontainers: 010 §7 is
 * explicit that Testcontainers is a CI harness and not the production sandbox
 * orchestrator, and the seven calls below do not justify a client library.
 * Nothing outside this package may import it either way (010 §13).
 */

export interface EngineResponse {
  readonly status: number;
  readonly body: Buffer;
}

/** A daemon that has stopped answering must fail the step, not hang the run. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** A cold image pull on a slow link is minutes, not seconds. */
const PULL_TIMEOUT_MS = 240_000;

/**
 * `unix://` only. A `tcp://` daemon is a different security posture — TLS
 * material, a reachable network endpoint — and quietly connecting to one
 * because an environment variable said so is not a decision this adapter makes.
 */
export function resolveSocketPath(dockerHost: string | undefined): string {
  if (dockerHost === undefined || dockerHost === "") {
    return "/var/run/docker.sock";
  }
  if (dockerHost.startsWith("unix://")) {
    return dockerHost.slice("unix://".length);
  }
  throw new Error(
    `Only a unix-socket DOCKER_HOST is supported by the Docker sandbox adapter; got '${dockerHost}'.`,
  );
}

function call(
  socketPath: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<EngineResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          host: "docker",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(
        new Error(
          `The Docker daemon did not answer ${method} ${path} within ${timeoutMs}ms.`,
        ),
      ),
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function expectOk(
  response: EngineResponse,
  what: string,
): EngineResponse | never {
  if (response.status < 400) return response;
  throw new Error(
    `Docker refused to ${what}: ${response.status} ${response.body.toString("utf8").trim()}`,
  );
}

function parse<T>(response: EngineResponse): T {
  return JSON.parse(response.body.toString("utf8")) as T;
}

/**
 * Docker frames a non-TTY attach as `[stream, 0, 0, 0, size:u32be]` headers, so
 * stdout and stderr have to be pulled apart rather than concatenated — a step
 * that reads a diagnostic as its result is worse than one that reads nothing.
 */
export function demultiplex(body: Buffer): {
  readonly stdout: string;
  readonly stderr: string;
} {
  const streams = ["", "", ""];
  let offset = 0;
  while (offset + 8 <= body.length) {
    const descriptor = body[offset] ?? 1;
    const size = body.readUInt32BE(offset + 4);
    const start = offset + 8;
    const text = body.subarray(start, start + size).toString("utf8");
    streams[descriptor === 2 ? 2 : 1] += text;
    offset = start + size;
  }
  return { stdout: streams[1] ?? "", stderr: streams[2] ?? "" };
}

export interface ExecOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * As much of `GET /containers/{id}/json` as anything here reads. Addresses hang
 * off `Networks`: Engine 29 dropped the legacy top-level `IPAddress`.
 */
export interface ContainerInspection {
  readonly Id: string;
  readonly NetworkSettings: {
    readonly Networks?: Readonly<
      Record<string, { readonly IPAddress?: string }>
    >;
  };
}

export interface EngineClient {
  ping(): Promise<boolean>;
  ensureImage(image: string): Promise<void>;
  createContainer(config: unknown): Promise<string>;
  startContainer(id: string): Promise<void>;
  exec(
    id: string,
    command: readonly string[],
    timeoutMs: number,
  ): Promise<ExecOutcome>;
  /** Idempotent: a container already gone is a release that already happened. */
  remove(id: string): Promise<void>;
  /** The daemon's own view, or undefined if the container is gone. */
  inspect(id: string): Promise<ContainerInspection | undefined>;
}

export function createEngineClient(socketPath: string): EngineClient {
  const send = (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) => call(socketPath, method, path, body, timeoutMs);

  return {
    async ping() {
      try {
        return (await send("GET", "/_ping")).status === 200;
      } catch {
        return false;
      }
    },

    async ensureImage(image) {
      const present = await send(
        "GET",
        `/images/${encodeURIComponent(image)}/json`,
      );
      if (present.status === 200) return;

      const [name = image, tag = "latest"] = image.split(":");
      const pulled = await send(
        "POST",
        `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
        undefined,
        PULL_TIMEOUT_MS,
      );
      expectOk(pulled, `pull the image '${image}'`);
      // The pull streams progress and reports failure in the body with a 200,
      // so a successful status alone does not mean there is an image.
      if (pulled.body.includes("errorDetail")) {
        throw new Error(
          `Docker could not pull the image '${image}': ${pulled.body.toString("utf8").trim()}`,
        );
      }
    },

    async createContainer(config) {
      const created = expectOk(
        await send("POST", "/containers/create", config),
        "create a sandbox container",
      );
      return parse<{ Id: string }>(created).Id;
    },

    async startContainer(id) {
      expectOk(
        await send("POST", `/containers/${id}/start`),
        `start the sandbox container ${id}`,
      );
    },

    async exec(id, command, timeoutMs) {
      const created = expectOk(
        await send("POST", `/containers/${id}/exec`, {
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Cmd: [...command],
        }),
        `prepare a command in the sandbox container ${id}`,
      );
      const execId = parse<{ Id: string }>(created).Id;

      const output = expectOk(
        await send(
          "POST",
          `/exec/${execId}/start`,
          { Detach: false, Tty: false },
          timeoutMs,
        ),
        `run a command in the sandbox container ${id}`,
      );
      const inspected = expectOk(
        await send("GET", `/exec/${execId}/json`),
        `read the result of a command in the sandbox container ${id}`,
      );

      return {
        ...demultiplex(output.body),
        exitCode: parse<{ ExitCode: number | null }>(inspected).ExitCode ?? 0,
      };
    },

    async remove(id) {
      const removed = await send(
        "DELETE",
        `/containers/${id}?force=true&v=true`,
      );
      if (removed.status === 404) return;
      expectOk(removed, `remove the sandbox container ${id}`);
    },

    async inspect(id) {
      const inspected = await send("GET", `/containers/${id}/json`);
      if (inspected.status === 404) return undefined;
      return parse<ContainerInspection>(
        expectOk(inspected, `inspect the container ${id}`),
      );
    },
  };
}
