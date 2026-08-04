export type SandboxError = {
  readonly code: "SANDBOX_UNAVAILABLE";
  readonly message: string;
  readonly requiredProfile: string;
};

export interface SandboxPort {
  health(): Promise<{ readonly available: boolean }>;
}

export function sandboxUnavailable(requiredProfile: string): SandboxError {
  return {
    code: "SANDBOX_UNAVAILABLE",
    message: `Required sandbox profile '${requiredProfile}' is unavailable; host execution is not permitted.`,
    requiredProfile,
  };
}
