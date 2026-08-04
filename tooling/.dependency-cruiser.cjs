module.exports = {
  forbidden: [
    {
      name: "public-must-not-import-private-adapter",
      comment: "Public Forge packages cannot expose adapter implementations.",
      from: { path: "forge/packages/(sdk|manifest|types|plugin-sdk)" },
      to: { path: "forge/(packages|adapters)/adapters-" },
    },
    {
      name: "core-must-not-import-extension",
      comment: "Core cannot import company or connector extensions.",
      from: { path: "forge/packages" },
      to: { path: "forge\\.(acme|gusto|buzz)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "forge/tooling/tsconfig.json" },
  },
};
