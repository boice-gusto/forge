# Intake-to-merge engineering guide

Open the local briefing directly in a browser:

```sh
open forge/examples/acme/intake-guide/index.html
```

Run its focused source-level verification:

```sh
pnpm exec vitest run forge/examples/acme/intake-guide/intake-guide.test.ts
```

This example is local-only: it has no network dependency, sends no requests, and needs no credentials. It documents the finite [Slack fixture](../intake/slack.fixture.ts), [Jira fixture](../intake/jira.fixture.ts), and [routing acceptance test](../intake/intake-routing.acceptance.test.ts).
