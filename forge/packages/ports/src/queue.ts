export interface QueuePort {
  health(): Promise<{ readonly available: boolean }>;
}
