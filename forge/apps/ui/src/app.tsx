import {
  type LocalDependency,
  LocalStatus,
} from "./components/local-status.js";

export interface ForgeAppProps {
  readonly dependencies: readonly LocalDependency[];
}

export function ForgeApp({ dependencies }: ForgeAppProps) {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">Forge control plane</h1>
      <p className="mt-2 text-muted-foreground">
        Requested, granted, and observed runtime state will appear here as
        workflows run.
      </p>
      <div className="mt-6">
        <LocalStatus dependencies={dependencies} />
      </div>
    </main>
  );
}
