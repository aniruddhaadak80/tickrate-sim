---
name: replay-a-trace
description: Use when a recorded multiplayer tick trace must be checked against a declared netcode state machine, because the replay names the exact tick and rule that broke rather than reporting a desync.
metadata:
  version: 1.0.0
---

# Replay a tick trace

## When to use this

You have a transition table and a recorded trace, and you need to know whether the server did
anything the table does not permit. Do not use this to check the rate - use `measure-tickrate`
for that.

## Steps

1. **Validate the table first.** A table that fails validation produces misleading replay
   results, so this is not optional:
   `tickrate-sim validate table.json`
2. **Replay the trace:**
   `tickrate-sim replay trace.json --table table.json`
3. **Read `first violation`, not the whole list.** It names the tick, the code, the edge and the
   rule. Later violations are usually consequences of the first.
4. **Look at the coverage line.** A trace that exercised 2 of 8 declared edges has not
   disproved anything about the other 6. Low coverage is the most common way a "clean" replay
   turns out to be worthless.
5. **Check the budgets** if the replay was clean but players still reported stutter:
   `tickrate-sim budget trace.json --table table.json`

## Violation codes

| Code                    | Means                                             | Usual cause                                      |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `UNDECLARED_TRANSITION` | no rule permits this edge at all                  | code path the design never described             |
| `TERMINAL_EXIT`         | the machine left a state marked terminal          | a reset or reconnect path with no declared rule  |
| `UNKNOWN_STATE`         | the trace enters a state the table never declares | a state added in code but not in the table       |
| `BUDGET_UNDERRUN`       | the edge fired before its `minTicks` elapsed      | a timer that fires early, or a clock that drifts |
| `BUDGET_OVERRUN`        | the edge fired after its `maxTicks` elapsed       | work taking longer than the budget allows        |
| `NON_MONOTONIC_TICK`    | a tick number went backwards                      | the recorder, not the server                     |
| `EVENT_OUT_OF_RANGE`    | an event falls outside the declared window        | a truncated or padded recording                  |
| `REPEAT_TRANSITION`     | a once-only edge fired twice                      | a match state entered twice without an exit      |

## Verify

`tickrate-sim replay` exits 0 and prints either `LEGAL` or a violation list. Coverage is
reported on every run.
