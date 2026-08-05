import type { ReactNode } from "react";

/** One term/value row of a definition list. */
export function Fact({
  term,
  children,
}: {
  readonly term: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap gap-x-2 py-1">
      <dt className="w-44 shrink-0 opacity-70">{term}</dt>
      <dd className="min-w-0 break-all font-medium">{children}</dd>
    </div>
  );
}
