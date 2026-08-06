import type { Connector } from "./connector.js";

/**
 * How a company contributes connectors, and where their secrets do *not* come
 * from.
 *
 * A company package names which channels a deployment serves and which
 * workflow each shortcut or event runs — that is the company's decision. The
 * signing secrets are the *deployment's*, and they arrive through this
 * function rather than through the module, because a secret in a company
 * package is a secret in a git repository (009 §9).
 *
 * So the module exports a factory, not a table: it cannot construct a
 * connector until a host hands it a way to look up secrets, and a host only
 * does that at boot from its own environment.
 */
export type ConnectorFactory = (
  secret: SecretLookup,
) => Readonly<Record<string, Connector>>;

/**
 * Reads one named secret, or returns nothing.
 *
 * Named rather than passed as a bag so a company module can only obtain the
 * secrets it asks for by name, and a host can log or refuse an unexpected ask.
 */
export type SecretLookup = (name: string) => string | undefined;

export interface ConnectorBindingResult {
  readonly connectors: Readonly<Record<string, Connector>>;
  /** Every reason a channel was not bound, for a host to print and refuse on. */
  readonly problems: readonly string[];
}

const looksLikeConnector = (value: unknown): value is Connector =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Connector).channel === "string" &&
  typeof (value as Connector).verify === "function" &&
  typeof (value as Connector).normalise === "function";

/**
 * Turn a company's `connectors` adapter module into connectors, or say why
 * not.
 *
 * Shared by `apps/api` and `apps/worker` because they must agree. They agree
 * on policy already, for the reason stated in the worker: a run whose outcome
 * depends on which process took it off the queue is the least debuggable
 * failure this system can have. The same is true of who may reach it — an API
 * serving a channel the worker cannot announce back to is a run nobody hears
 * about, and an API that refuses a channel the worker would have served is a
 * silent 404 on a webhook somebody configured.
 *
 * Returns problems rather than throwing, so a host can decide: a control plane
 * refuses to start, and so does a worker.
 */
export function bindConnectors(
  module: unknown,
  secret: SecretLookup,
): ConnectorBindingResult {
  const factory =
    (module as { default?: unknown; connectors?: unknown })?.default ??
    (module as { connectors?: unknown })?.connectors;

  if (typeof factory !== "function") {
    return {
      connectors: {},
      problems: [
        'the "connectors" adapter must export a factory as its default, or as `connectors`',
      ],
    };
  }

  let produced: unknown;
  try {
    produced = (factory as ConnectorFactory)(secret);
  } catch (error) {
    // A factory usually throws because a secret it asked for was absent, which
    // is a deployment configuration fault and worth saying plainly.
    return {
      connectors: {},
      problems: [`the "connectors" factory threw: ${String(error)}`],
    };
  }

  if (typeof produced !== "object" || produced === null) {
    return {
      connectors: {},
      problems: ['the "connectors" factory returned no table'],
    };
  }

  const problems: string[] = [];
  const connectors: Record<string, Connector> = {};
  for (const [channel, candidate] of Object.entries(
    produced as Record<string, unknown>,
  )) {
    if (!looksLikeConnector(candidate)) {
      problems.push(`'${channel}' is not a connector`);
      continue;
    }
    if (candidate.channel !== channel) {
      /**
       * The key is what the route dispatches on and the field is what
       * deduplication keys on. If they disagree, a delivery to
       * `/v1/intake/slack` deduplicates against some other channel's ids —
       * and could suppress its events.
       */
      push(problems, channel, candidate.channel);
      continue;
    }
    connectors[channel] = candidate;
  }

  return { connectors, problems };
}

const push = (problems: string[], key: string, channel: string): void => {
  problems.push(
    `'${key}' is bound to a connector that calls itself '${channel}'`,
  );
};
