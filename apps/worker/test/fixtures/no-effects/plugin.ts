/**
 * A company that loads cleanly and binds nowhere for a gated action to land.
 *
 * Everything else about it is fine, so a worker refusing to start on this can
 * only be refusing for the reason under test.
 */
const plugin = {
  manifest: {
    id: "noeffects",
    version: "0.1.0",
    forgeVersion: "^0.1.0",
    requiredCapabilities: [],
    providedCapabilities: [],
  },
  register() {},
};

export default plugin;
