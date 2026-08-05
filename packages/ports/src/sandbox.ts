/**
 * A Forge-owned profile alias (010 §3) — never a container image URI. An author
 * names `forge.node-ts`; the adapter, not the workflow, decides what that
 * resolves to, so an image cannot be chosen by workflow content.
 */
export type SandboxProfile = string;

/**
 * A non-zero exit is a result, not an exception (010 §15): the step decides
 * whether it can recover. Losing the sandbox itself throws instead.
 */
export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A live isolated environment. Valid only while the `withSandbox` callback that
 * was handed it is running — an escaped handle must not outlive the release, so
 * using one afterwards is refused rather than quietly re-provisioning.
 */
export interface SandboxLease {
  readonly sandboxId: string;
  /** The profile that was asked for, and provisioned. Never a substitute. */
  readonly profile: SandboxProfile;
  /** Where work happens; a provider session runs with this as its cwd (010 §10). */
  readonly workspacePath: string;
  /**
   * argv, not a shell line: there is no shell to inject into, so a command
   * assembled from workflow content cannot become a second command.
   */
  exec(command: readonly string[]): Promise<SandboxExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface SandboxLeaseRequest {
  readonly profile: SandboxProfile;
  /** Ties the environment to the run that asked for it, in labels and in spans. */
  readonly correlationId: string;
  /** Aborting tears the environment down; it never leaves it running. */
  readonly signal?: AbortSignal;
}

export interface SandboxPort {
  /**
   * The profiles this adapter can actually provision. A request naming one
   * outside this list is refused: substituting a weaker profile would hand a
   * workflow less isolation than it declared, and nothing would say so.
   */
  readonly profiles: readonly SandboxProfile[];
  health(): Promise<{ readonly available: boolean }>;
  /**
   * Acquire an environment for the requested profile, run `work` inside it,
   * release it.
   *
   * Scoped rather than `acquire`/`release`, because release is then the
   * adapter's own `finally` rather than something a caller can forget. A leaked
   * container is both a resource leak and an isolation boundary left standing
   * open after the run that justified it has ended.
   *
   * Fails closed: if the profile cannot be provisioned this rejects, and `work`
   * is never invoked. There is no host fallback.
   */
  withSandbox<T>(
    request: SandboxLeaseRequest,
    work: (sandbox: SandboxLease) => Promise<T>,
  ): Promise<T>;
}
