export interface SandboxRequirementLayer {
  readonly capabilities: readonly string[];
  readonly hosts: readonly string[];
}

export type SandboxGrantResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly capabilities: readonly string[];
        readonly hosts: readonly string[];
      };
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: "SANDBOX_GRANT_EMPTY" };
    };

function intersection(
  values: readonly (readonly string[])[],
): readonly string[] {
  const [first, ...rest] = values;
  if (first === undefined) return [];
  return [...new Set(first)]
    .filter((value) => rest.every((layer) => layer.includes(value)))
    .sort();
}

export function resolveSandboxGrant(
  layers: readonly SandboxRequirementLayer[],
): SandboxGrantResult {
  const capabilities = intersection(layers.map((layer) => layer.capabilities));
  if (capabilities.length === 0)
    return { ok: false, error: { code: "SANDBOX_GRANT_EMPTY" } };
  return {
    ok: true,
    value: {
      capabilities,
      hosts: intersection(layers.map((layer) => layer.hosts)),
    },
  };
}
