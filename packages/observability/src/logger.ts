import pino, { type Logger } from "pino";

import { redact } from "./redaction.js";

export interface ForgeLogContext {
  readonly workflowId?: string;
  readonly traceId?: string;
  readonly runId?: string;
}

export type LogSink = (entry: unknown) => void;

function asLogObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function createForgeLogger(
  context: ForgeLogContext = {},
  sink?: LogSink,
): Logger {
  return pino(
    {
      base: null,
      mixin: () => context,
      formatters: {
        log: (entry) => asLogObject(redact(entry)),
      },
    },
    sink === undefined
      ? undefined
      : {
          write: (line) => sink(JSON.parse(line)),
        },
  );
}
