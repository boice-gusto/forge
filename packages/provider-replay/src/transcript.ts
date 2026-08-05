import { readFile } from "node:fs/promises";

import { z } from "zod";

/**
 * A recorded session, as a stream of frames rather than of Forge events. The
 * recording says what the provider did; it does not say what Forge should
 * conclude from it. Keeping the two apart is what makes the classification
 * below the adapter's decision and therefore testable.
 *
 * Parsed with Zod at the boundary (008 §13.10). A transcript is untrusted input
 * — it is a file on disk, possibly written by a tool that has since changed —
 * so it is validated rather than cast.
 */

const DelayMs = z.number().min(0).default(0);

const TranscriptFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("text"), text: z.string(), delayMs: DelayMs })
    .strict(),
  z
    .object({
      kind: z.literal("tool-call"),
      toolId: z.string().min(1),
      args: z.unknown(),
      delayMs: DelayMs,
    })
    .strict(),
  z
    .object({
      kind: z.literal("tool-result"),
      toolId: z.string().min(1),
      result: z.unknown(),
      delayMs: DelayMs,
    })
    .strict(),
  z
    .object({
      kind: z.literal("failure"),
      code: z.string().min(1),
      message: z.string(),
      delayMs: DelayMs,
    })
    .strict(),
  z.object({ kind: z.literal("end"), delayMs: DelayMs }).strict(),
]);

/**
 * Frames are strict — an unrecognised frame kind is a recording Forge cannot
 * faithfully replay, so it is refused rather than skipped. The envelope is not:
 * `recordedAt` and whatever provenance a recorder adds later describe where the
 * transcript came from, not what it makes the provider do.
 */
const TranscriptSchema = z.looseObject({
  frames: z.array(TranscriptFrameSchema),
  recordedAt: z.string().optional(),
});

export type TranscriptFrame = z.infer<typeof TranscriptFrameSchema>;

export type ParsedTranscript =
  | { readonly ok: true; readonly frames: readonly TranscriptFrame[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Failures a later attempt could plausibly get past. Everything else is
 * permanent: a run that spins on a failure which will never clear burns its
 * budget and fails anyway, so an unrecognised code stops rather than retries.
 */
const TRANSIENT_FAILURE_CODES: readonly string[] = [
  "RATE_LIMITED",
  "TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "CONNECTION_RESET",
];

export function isRetryable(code: string): boolean {
  return TRANSIENT_FAILURE_CODES.includes(code);
}

export function parseTranscript(raw: unknown): ParsedTranscript {
  const result = TranscriptSchema.safeParse(raw);
  if (result.success) return { ok: true, frames: result.data.frames };

  // A malformed recording is reported, never thrown: the adapter turns it into
  // a non-retryable error event so the runtime stops for a stated reason.
  // Every issue, located. A recording can be long, and "something is wrong
  // with it" is not enough to find the frame that is wrong.
  const detail = result.error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
  return {
    ok: false,
    reason: `the transcript is not a recognised recording — ${detail}`,
  };
}

export async function loadTranscript(path: string): Promise<ParsedTranscript> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ok: false, reason: `the transcript at ${path} could not be read` };
  }
  try {
    return parseTranscript(JSON.parse(raw));
  } catch {
    return { ok: false, reason: `the transcript at ${path} is not valid JSON` };
  }
}
