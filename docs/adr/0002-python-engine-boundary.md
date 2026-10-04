# ADR 0002 - The deterministic engine is a pure Python function over stdio

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The parts of this product that must be exactly right are arithmetic, graph and state logic: how
many ticks elapsed in a state before an edge fired, whether that edge was ever declared, how far
the achieved tick rate drifted from the declared one in parts per million, whether a table
revision would reject a trace that previously passed.

Every one of those is a place where a language model produces a _plausible_ number. Given four
thousand anchors it will return a drift figure that is confidently wrong in the third digit.
That is not a bug in the model; it is arithmetic, and arithmetic belongs in code.

So these operations have to be code - and the code has to be runnable by four different surfaces,
including one that cannot run a subprocess at all.

## Decision

The engine is a dependency-free Python package in `services/engine`, invoked as a **pure
function over stdin/stdout**. No server, no port, no daemon, no persisted state.

- Input: one JSON object `{"op": "...", "input": ...}` on stdin.
- Output: one JSON object on stdout, one line. Diagnostics on stderr only.
- No clock reads, no randomness, no network, no filesystem. Time and entropy are arguments.

Five operations, each a pure function with typed input and typed output:

| Operation        | Answers                                          |
| ---------------- | ------------------------------------------------ |
| `validate_table` | Is the declaration coherent?                     |
| `replay`         | Where did reality outgrow the declaration?       |
| `tickrate_stats` | What rate did the server actually hit?           |
| `budget_profile` | Which tick budgets are tight, and which fiction? |
| `diff_tables`    | Which change would make a passing trace fail?    |

Two decisions inside the engine are worth recording separately, because both are the kind of
thing that looks like over-engineering until you have been bitten:

**Parsing happens once, at the boundary.** `model.py` validates and shapes every document. After
`parse_table` returns, no operation re-checks a field. The alternative is five copies of the
same validation, drifting.

**`replay` is total.** It never raises on a bad trace; it reports. A trace is a recording of a
real run, so if a server jumped from `lobby` to `live` that jump happened - refusing to model it
would make every later tick unreportable. So after an illegal edge the walk _repairs_ by adopting
the observed target state and keeps going, and the first violation is called out separately
because that is the one a human wants. Every input yields a total result; only a malformed
document raises.

## Consequences

- Every operation has unit tests per exported function including boundary values, `hypothesis`
  property tests for the invariants (determinism, totality, coverage as a bounded partition, the
  budget profile agreeing with the walk, a subject never breaking in both diff directions), and a
  golden-file test against the committed corpus.
- `mypy --strict` and `ruff` are clean on the package. The engine has no runtime dependency at
  all - not even `pydantic` - because every dependency is startup latency on a path that gets
  spawned per call.
- Because there is no server, two concurrent calls cannot interfere. There is no session to leak.
- The cost is one process spawn per call. Measured on the shipped corpus that is milliseconds,
  and it buys a boundary with no shared state whatsoever.
