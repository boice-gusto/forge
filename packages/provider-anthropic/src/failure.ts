import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import type { ProviderEvent } from "@forge/ports";

export type ProviderFailure = Extract<ProviderEvent, { type: "error" }>;

export function failure(
  code: string,
  message: string,
  retryable: boolean,
): ProviderFailure {
  return { type: "error", code, message, retryable };
}

interface Classification {
  readonly code: string;
  readonly retryable: boolean;
}

/**
 * Getting this table right is the whole point of the adapter.
 *
 * A permanent failure marked retryable makes the runtime spin: it re-attempts
 * a request that can never succeed, burns the attempt budget, and fails
 * anyway — later and more expensively. The reverse fails a run that a second
 * attempt would have completed.
 *
 * So the rule is narrow rather than generous. Only the statuses that name a
 * condition the server itself expects to pass are retryable; everything else
 * in 4xx is the caller's fault and will be the caller's fault again.
 */
const BY_STATUS: Readonly<Record<number, Classification>> = {
  400: { code: "PROVIDER_INVALID_REQUEST", retryable: false },
  401: { code: "PROVIDER_UNAUTHENTICATED", retryable: false },
  403: { code: "PROVIDER_FORBIDDEN", retryable: false },
  404: { code: "PROVIDER_NOT_FOUND", retryable: false },
  408: { code: "PROVIDER_TIMEOUT", retryable: true },
  413: { code: "PROVIDER_REQUEST_TOO_LARGE", retryable: false },
  422: { code: "PROVIDER_INVALID_REQUEST", retryable: false },
  429: { code: "PROVIDER_RATE_LIMITED", retryable: true },
  // Anthropic's own "temporarily overloaded". Distinct from a 500 because an
  // operator reads it differently: nothing is broken, the fleet is busy.
  529: { code: "PROVIDER_OVERLOADED", retryable: true },
};

/**
 * An `error` frame inside a stream arrives with no HTTP status — the response
 * was a 200 and the failure happened afterwards — so the body's own error type
 * is the only thing left to classify on.
 */
const BY_ERROR_TYPE: Readonly<Record<string, Classification>> = {
  overloaded_error: { code: "PROVIDER_OVERLOADED", retryable: true },
  api_error: { code: "PROVIDER_UPSTREAM_ERROR", retryable: true },
  timeout_error: { code: "PROVIDER_TIMEOUT", retryable: true },
  rate_limit_error: { code: "PROVIDER_RATE_LIMITED", retryable: true },
  invalid_request_error: { code: "PROVIDER_INVALID_REQUEST", retryable: false },
  authentication_error: { code: "PROVIDER_UNAUTHENTICATED", retryable: false },
  permission_error: { code: "PROVIDER_FORBIDDEN", retryable: false },
  not_found_error: { code: "PROVIDER_NOT_FOUND", retryable: false },
  billing_error: { code: "PROVIDER_BILLING", retryable: false },
};

/**
 * Conformance requires a message a human can act on, so an empty one is
 * replaced rather than passed through. The vendor never puts credentials in an
 * error message and this adapter never adds any: what reaches here is the
 * status line and the server's own error body.
 */
function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.trim() === "" ? "The provider failed without a message." : raw;
}

function classifyApiError(error: APIError): ProviderFailure {
  const message = messageOf(error);
  const status = typeof error.status === "number" ? error.status : undefined;

  const byStatus = status === undefined ? undefined : BY_STATUS[status];
  if (byStatus !== undefined)
    return failure(byStatus.code, message, byStatus.retryable);

  const byType = error.type === null ? undefined : BY_ERROR_TYPE[error.type];
  if (byType !== undefined)
    return failure(byType.code, message, byType.retryable);

  // Every unmapped 5xx is the server saying it could not answer this time.
  if (status !== undefined && status >= 500)
    return failure("PROVIDER_UPSTREAM_ERROR", message, true);
  // Every unmapped 4xx is the request being wrong, and it will be wrong again.
  if (status !== undefined && status >= 400)
    return failure("PROVIDER_REQUEST_REJECTED", message, false);

  return failure("PROVIDER_FAILED", message, false);
}

export const CANCELLED_CODE = "PROVIDER_CANCELLED";

/**
 * Maps anything the SDK can throw onto a Forge error event. Nothing escapes as
 * an exception: the runtime applies its retry policy to a classified event, so
 * an unclassifiable failure has to become one too — a non-retryable one.
 */
export function classifyFailure(error: unknown): ProviderFailure {
  // Both are `APIError` subclasses, so they are matched before it.
  if (error instanceof APIUserAbortError)
    return failure(
      CANCELLED_CODE,
      "The request was aborted before the provider finished.",
      false,
    );
  if (error instanceof APIConnectionError)
    return failure("PROVIDER_CONNECTION_FAILED", messageOf(error), true);
  if (error instanceof APIError) return classifyApiError(error);

  return failure("PROVIDER_FAILED", messageOf(error), false);
}
