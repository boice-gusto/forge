import type { SandboxPort } from "@forge/ports";

export interface SandboxConformanceHarness {
  /** Names the suite, so a failure says which adapter broke. */
  readonly name: string;
  /**
   * A claim under test, not a curve to be graded on: the suite checks this
   * against the adapter's own `profiles`.
   */
  readonly profiles: readonly string[];
  /** The adapter at full strength. */
  create(): SandboxPort | Promise<SandboxPort>;
  /**
   * The same adapter with provisioning genuinely broken — a container runtime
   * that is not there, not a flag that short-circuits the code path under test.
   * "No host fallback" is only proved against a real failure to provision.
   */
  createUnavailable(): SandboxPort | Promise<SandboxPort>;
  /**
   * Whether the environment behind `sandboxId` is gone.
   *
   * Asked of the backend, never of the adapter's own bookkeeping: an adapter
   * that merely forgot a container it left running is exactly the leak this is
   * hunting.
   */
  isReleased(sandboxId: string): Promise<boolean>;
}

/**
 * A profile no adapter is allowed to support. Named rather than invented per
 * test so the refusal can be checked for mentioning it.
 */
export const UNSUPPORTED_PROFILE = "forge.profile-no-adapter-supports";

/** A promise that only settles if something else settles it. */
export function never(): Promise<never> {
  return new Promise<never>(() => {});
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}
