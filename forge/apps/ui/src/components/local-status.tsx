import { redact } from "@forge/observability";

export interface LocalDependency {
  readonly name: string;
  readonly status: "healthy" | "degraded" | "unavailable";
  readonly detail?: string;
}

export interface LocalStatusProps {
  readonly dependencies: readonly LocalDependency[];
}

function safeDetail(detail: string | undefined): string | undefined {
  return detail === undefined ? undefined : String(redact(detail));
}

export function LocalStatus({ dependencies }: LocalStatusProps) {
  return (
    <section aria-label="Local Forge status" className="rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Local status</h2>
      <ul className="mt-3 space-y-2">
        {dependencies.map((dependency) => (
          <li key={dependency.name} className="flex justify-between gap-4">
            <span>{dependency.name}</span>
            <span aria-label={`${dependency.name} status`}>
              {dependency.status}
            </span>
            {safeDetail(dependency.detail) === undefined ? null : (
              <span className="sr-only">{safeDetail(dependency.detail)}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
