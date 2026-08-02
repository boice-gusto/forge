export interface ProviderPort {
  health(): Promise<{
    readonly available: boolean;
    readonly providerId: string;
  }>;
}
