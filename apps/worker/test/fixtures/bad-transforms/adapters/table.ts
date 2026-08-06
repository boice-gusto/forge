/**
 * A transform table with an entry that is not a function.
 *
 * The realistic version of this mistake is a module that exports a config
 * object beside its transforms, or one whose build stripped a function. Either
 * way a node naming that ref throws deep inside a walk, behind whatever gates
 * came before it.
 */
export default {
  "acme.marketing.headline": (input: unknown) => input,
  "acme.marketing.broken": "this was supposed to be a function",
};
