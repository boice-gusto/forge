/**
 * A company binding an adapter by package name rather than by path.
 *
 * The case the resolver exists for. Imported from `@forge/company`, a bare
 * specifier resolves against Forge's own dependencies, so a company could only
 * bind packages Forge happens to depend on — which is the opposite of the
 * point of letting a company bind an adapter at all. It has to resolve the way
 * the company would resolve it.
 *
 * `@forge/plugin-sdk` stands in for the company's own dependency here because
 * it is one this fixture can actually reach; nothing about the resolution
 * cares which package it is.
 */
const plugin = {
  manifest: {
    id: "bareadapter",
    version: "0.1.0",
    forgeVersion: "^0.1.0",
    requiredCapabilities: [],
    providedCapabilities: [],
  },
  register(context: {
    adapters: { add: (binding: Record<string, string>) => void };
  }) {
    context.adapters.add({ id: "effects", binding: "@forge/plugin-sdk" });
  },
};

export default plugin;
