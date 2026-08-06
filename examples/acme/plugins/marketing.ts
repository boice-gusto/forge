import { definePolicy, definePrompt, defineSkill } from "@forge/manifest";
import type { ForgePlugin, PluginContext } from "@forge/plugin-sdk";

import { briefApproval } from "../domains/marketing/workflows/brief-approval.js";

/**
 * Acme marketing plugin.
 *
 * Imports the two public authoring packages and nothing else from Forge. It
 * cannot reach the compiler, the runtime, the IR, or any adapter — `tooling/assert-architecture`
 * fails the build if it tries, and that rule is what makes "extension over
 * replacement" a property rather than an aspiration.
 */
const plugin: ForgePlugin = {
  manifest: {
    id: "acme.plugin-marketing",
    version: "0.1.0",
    forgeVersion: "^0.1.0",
    requiredCapabilities: ["docs.write", "slack.write"],
  },

  register(context: PluginContext): void {
    context.workflows.add(briefApproval);

    context.skills.add(
      defineSkill({
        id: "acme.slack-post",
        version: "1.0.0",
        inputRef: "acme.publish@1",
        outputRef: "acme.publish-result@1",
        requiredCapabilities: ["slack.write"],
      }),
    );

    context.prompts.add(
      definePrompt({
        id: "acme.marketing.draft",
        version: "1.0.0",
        text: "Draft campaign copy from the brief. State assumptions you made.",
      }),
    );

    // Publishing externally is a human call, so the pack requires approval
    // rather than granting the effect outright.
    context.policies.add(
      definePolicy({
        id: "acme.marketing.publish",
        version: "1.0.0",
        grants: ["repo.read", "docs.write", "slack.write"],
        rules: [
          {
            id: "acme.marketing.external-publish",
            action: "slack.post",
            environment: "production",
            decision: "require-approval",
            reason: "Publishing externally is a human call.",
            approvers: ["marketing-lead"],
          },
        ],
      }),
    );

    /**
     * A module this package actually ships. It named `@forge/provider-mock`
     * before, which Acme does not depend on — the binding was a string in a
     * manifest that nothing ever imported, so nothing ever noticed it could
     * not be loaded. The loader resolves adapters at boot now, which is what
     * turned a promise into a fact.
     */
    context.adapters.add({
      id: "notification",
      binding: "./adapters/notification.ts",
      configRef: "config/notification",
    });

    /** Where a gated effect lands. A worker refuses to start without one. */
    context.adapters.add({
      id: "effects",
      binding: "./adapters/notification.ts",
      configRef: "config/notification",
    });
  },
};

export default plugin;
