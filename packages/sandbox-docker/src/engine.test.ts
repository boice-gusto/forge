import { describe, expect, test } from "vitest";

import { demultiplex, resolveSocketPath } from "./engine.js";

function frame(descriptor: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = descriptor;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("the daemon socket is resolved, never guessed", () => {
  test("a unix DOCKER_HOST names the socket to dial", () => {
    expect(resolveSocketPath("unix:///Users/dev/.colima/docker.sock")).toBe(
      "/Users/dev/.colima/docker.sock",
    );
  });

  test("no DOCKER_HOST falls back to the conventional socket", () => {
    expect(resolveSocketPath(undefined)).toBe("/var/run/docker.sock");
    expect(resolveSocketPath("")).toBe("/var/run/docker.sock");
  });

  test("a tcp daemon is refused rather than silently dialled", () => {
    // A remote daemon is a different security posture, and an environment
    // variable is not the place that decision gets made.
    expect(() => resolveSocketPath("tcp://10.0.0.5:2375")).toThrow(
      /unix-socket/,
    );
  });
});

describe("stdout and stderr are pulled apart, not concatenated", () => {
  test("each frame lands on the stream its descriptor names", () => {
    const body = Buffer.concat([
      frame(1, "result"),
      frame(2, "warning"),
      frame(1, " continues"),
    ]);

    expect(demultiplex(body)).toEqual({
      stdout: "result continues",
      stderr: "warning",
    });
  });

  test("an empty stream is empty rather than undefined", () => {
    expect(demultiplex(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
  });

  test("a truncated trailing frame is dropped rather than misread", () => {
    const body = Buffer.concat([frame(1, "kept"), Buffer.from([1, 0, 0])]);

    expect(demultiplex(body)).toEqual({ stdout: "kept", stderr: "" });
  });
});
