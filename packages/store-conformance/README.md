# @forge/store-conformance

One executable contract for `CheckpointStorePort`, `ApprovalPort` and
`RunStorePort`, run by every adapter that claims to implement them. The same
idea as `@forge/provider-conformance`, applied to the three stores that hold
the run's safety state.

Two adapters that pass this are behaviourally indistinguishable, which is the
only useful sense in which a Postgres approval store can be swapped for the
in-memory one. Copying the memory adapter's tests into each new package would
let them drift; a shared suite cannot.

## Using it

```ts
import { describeApprovalStoreConformance } from "@forge/store-conformance";

describeApprovalStoreConformance({
  name: "approval-memory",
  async create(clock, ids) {
    const store = createMemoryApprovalStore(clock, ids);
    return { store, async peer() { return store; } };
  },
});
```

`peer()` is a second handle onto the *same* state — a second API process, or
the same process after a restart. An in-memory adapter's state is the object it
returned, so it hands back the same store; a Postgres adapter opens a second
pool onto the same database. Without it the suite cannot tell a durable record
from one that only ever lived in a Map, and the concurrency test would have
nothing to contend with.

## What the approval suite defends

The invariants from `.claude/skills/forge/SKILL.md`, phrased as behaviour:

- an approval binds to one exact action
- **a decision is single-use** — including under two handles deciding at once
- **an expired gate is not a slow yes** — a timeout is terminal
- **an edit authorises nothing** — it is `EDITED`, and the amended action needs
  a gate of its own
- a run keeps the gates it refused, and an operator's inbox shows only gates
  that name them
- all of the above survive being read through a different handle

The race test warms each handle's connections before contending, because
otherwise a store with no concurrency control at all passes: the caller whose
connection is already open finishes before the others have finished dialling.
Verified by reverting the Postgres adapter to a check-then-write — both race
tests fail.
