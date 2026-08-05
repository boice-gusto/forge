# Forge authorisation policy (ADR-007).
#
# Compiled to WebAssembly and evaluated by `@open-policy-agent/opa-wasm`. The
# compiled module is committed as `forge.wasm`; rebuild it with
# `pnpm --filter @forge/policy-opa run build:wasm`, which needs Docker but is
# not on any test or CI path.
#
# Input is exactly `PolicyRequest`: actor, action, environment, capabilities.
# There is no resource and no free text, so there is nothing here for workflow
# content to steer.
#
# Data is the compiled form of a company's policy packs:
#   data.config.grants  — the host capability closure, as an array
#   data.config.rules   — the pack's rules, in pack order
package forge.policy

import rego.v1

# Referenced by exact path rather than through `object.get(data, ...)`: reading
# the whole document from a rule that is itself part of it is a recursion error.
default grants := []

grants := data.config.grants

default rules := []

rules := data.config.rules

# Every requested capability the host closure does not contain. A rule cannot
# widen this: grants are the only source.
ungranted := [capability |
	some capability in input.capabilities
	not capability in grants
]

# Absent `environment` means the rule is unscoped and matches anywhere. A rule
# that names one matches only there.
matches(rule) if {
	rule.action == input.action
	object.get(rule, "environment", null) == null
}

matches(rule) if {
	rule.action == input.action
	object.get(rule, "environment", null) == input.environment
}

# First rule in pack order wins, so a pack can put a narrow production rule
# ahead of a broad one and have it decide.
first_match := rules[min([index |
	some index, rule in rules
	matches(rule)
])]

verdict(rule) := {"kind": "allow"} if rule.decision == "allow"

verdict(rule) := {
	"kind": "deny",
	"reason": rule.reason,
	"policyId": rule.id,
} if rule.decision == "deny"

verdict(rule) := {
	"kind": "require-approval",
	"reason": rule.reason,
	"policyId": rule.id,
	"approvers": object.get(rule, "approvers", []),
} if rule.decision == "require-approval"

# An action no rule matches is denied. This is the default, not a fallback
# reached after the others have declined.
default decision := {
	"kind": "deny",
	"reason": "No rule permits this action; policy denies by default.",
	"policyId": "forge.policy.default-deny",
}

decision := {
	"kind": "deny",
	"reason": sprintf("Capabilities outside the granted closure: %s.", [concat(", ", ungranted)]),
	"policyId": "forge.policy.capability-closure",
} if count(ungranted) > 0

decision := verdict(first_match) if count(ungranted) == 0
