export interface SandboxPort {
  health(): Promise<{ readonly available: boolean }>;
}
