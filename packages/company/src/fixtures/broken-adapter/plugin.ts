/**
 * A company that binds an adapter to a package which is not installed.
 *
 * Bare rather than relative on purpose: that is the path where resolution from
 * the company's own `node_modules` fails, and the specifier falls through to a
 * plain import that fails too. Both have to end in a diagnostic rather than a
 * silently missing adapter.
 *
 * The whole fixture: everything else about it loads cleanly, so a failure can
 * only come from the adapter. A fixture that was broken in two ways would pass
 * this test for the wrong one.
 */
const plugin = {
  manifest: {
    id: "brokenadapter",
    version: "0.1.0",
    forgeVersion: "^0.1.0",
    requiredCapabilities: [],
    providedCapabilities: [],
  },
  register(context: {
    adapters: { add: (binding: Record<string, string>) => void };
  }) {
    context.adapters.add({
      id: "effects",
      binding: "@acme/notification-adapter-that-does-not-exist",
    });
  },
};

export default plugin;
