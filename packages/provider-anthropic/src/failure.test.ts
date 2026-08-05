import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";

import { classifyFailure } from "./failure.js";

describe("anything the SDK can throw becomes a classified event", () => {
  test("an abort is a deliberate stop, so it is never retried", () => {
    expect(classifyFailure(new APIUserAbortError())).toMatchObject({
      type: "error",
      code: "PROVIDER_CANCELLED",
      retryable: false,
    });
  });

  test("a connection failure is retryable, because the request never landed", () => {
    expect(
      classifyFailure(new APIConnectionError({ message: "socket hang up" })),
    ).toMatchObject({ code: "PROVIDER_CONNECTION_FAILED", retryable: true });
  });

  test("an API error with neither status nor type fails closed", () => {
    // Nothing left to classify on. Retrying a failure nobody can explain burns
    // the attempt budget and fails anyway.
    expect(
      classifyFailure(new APIError(undefined, undefined, undefined, undefined)),
    ).toMatchObject({ code: "PROVIDER_FAILED", retryable: false });
  });

  test("an error type carries the classification when there is no status", () => {
    expect(
      classifyFailure(
        new APIError(
          undefined,
          undefined,
          "the model is busy",
          undefined,
          "overloaded_error",
        ),
      ),
    ).toMatchObject({ code: "PROVIDER_OVERLOADED", retryable: true });
  });

  test("something that is not an error at all is still an event", () => {
    const failure = classifyFailure("the transport rejected with a string");

    expect(failure).toMatchObject({
      code: "PROVIDER_FAILED",
      retryable: false,
    });
    expect(failure.message).toContain("rejected with a string");
  });

  test("an empty message is replaced, because a code alone is not actionable", () => {
    // Conformance requires a message a human can act on, and an adapter that
    // hands back an empty string has technically answered and said nothing.
    const failure = classifyFailure(
      new APIError(undefined, { message: "   " }, undefined, undefined),
    );

    expect(failure.message.trim().length).toBeGreaterThan(0);
  });
});
