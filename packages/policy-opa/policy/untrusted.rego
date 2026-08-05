# A bundle Forge did not compile.
#
# The `wasm` option lets a company ship its own compiled Rego, so the adapter
# cannot trust what comes back out of the module. This fixture returns, keyed
# by action, each way that can go wrong; every other action raises a genuine
# evaluator error, which is what proves the fail-closed path rather than a flag
# the adapter reads.
#
# Test-only. Rebuild with `pnpm --filter @forge/policy-opa run build:wasm`.
package forge.policy

import rego.v1

handled := {
	"not.an.object",
	"unknown.kind",
	"missing.fields",
	"bad.approvers",
	"bad.approver.entry",
	"well.formed",
}

# `http.send` is not implemented in the Wasm runtime, so evaluating this raises
# an error inside the evaluator. It is the catch-all so that *every* action the
# conformance suite asks about fails, not only the ones named above.
decision := response if {
	not input.action in handled
	response := http.send({"method": "get", "url": "http://127.0.0.1:1/"})
}

decision := "allow" if input.action == "not.an.object"

decision := {"kind": "maybe"} if input.action == "unknown.kind"

decision := {"kind": "deny"} if input.action == "missing.fields"

decision := {
	"kind": "require-approval",
	"reason": "Approvers are not a list.",
	"policyId": "untrusted",
	"approvers": "everyone",
} if input.action == "bad.approvers"

decision := {
	"kind": "require-approval",
	"reason": "One approver is not a name.",
	"policyId": "untrusted",
	"approvers": ["marketing-lead", 7],
} if input.action == "bad.approver.entry"

# A decision the adapter must still honour, so that rejecting a shape is not
# mistaken for rejecting the bundle.
decision := {"kind": "allow"} if input.action == "well.formed"
