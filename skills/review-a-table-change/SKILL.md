---
name: review-a-table-change
description: Use when a transition table revision needs review, because the question is which change would make a trace that used to pass start failing, not which edges were added or removed.
metadata:
  version: 1.0.0
---

# Review a transition table change

## When to use this

Two revisions of a netcode table exist and you need to know whether the new one is safe for
recorded traces and test suites that pass against the old one.

## Steps

1. **Diff them:** `tickrate-sim diff before.json after.json`
2. **Read `breaking` first, not `changes`.** It is the answer to the only question that matters.
   `compatible: false` means at least one change rejects input the old revision accepted.
3. **Understand what counts as breaking:**
   - raising a `minTicks` - a trace that fired the edge sooner now fails
   - lowering a `maxTicks` - a trace that waited longer now fails
   - putting a `maxTicks` on a previously unbounded rule - the same, in the other direction
   - deleting a rule or a state - the trace fails with `UNDECLARED_TRANSITION` or
     `UNKNOWN_STATE`
4. **Note what does not.** Adding a rule, adding a state, widening a budget, and editing a
   `guard` are all compatible - they accept strictly more than before.
5. **Then run the corpus against the new table** to see the concrete effect:
   `tickrate-sim corpus show <case-id>`

## Why `breaking` is directional

Tightening a budget breaks the old table; loosening it again does not break the new one. So
`diff(a, b)` and `diff(b, a)` name the same subjects with the labels swapped, and `breaking`
names whichever revision does the rejecting. A subject that is breaking in both directions would
mean neither revision rejects anything, which is why the property test asserts it cannot happen.

## Verify

`tickrate-sim diff` prints `COMPATIBLE` or the breaking list. Exit code is 1 when incompatible.
