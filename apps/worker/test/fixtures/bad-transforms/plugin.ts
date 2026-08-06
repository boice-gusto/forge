const plugin = {
  manifest: {
    id: "badtransforms",
    version: "0.1.0",
    forgeVersion: "^0.1.0",
    requiredCapabilities: [],
    providedCapabilities: [],
  },
  register(context: {
    adapters: { add: (binding: Record<string, string>) => void };
  }) {
    context.adapters.add({
      id: "transforms",
      binding: "./adapters/table.ts",
    });
  },
};

export default plugin;
