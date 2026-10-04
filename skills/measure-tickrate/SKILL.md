---
name: measure-tickrate
description: Use when a replay is clean but players still report stutter, because the server can honour every transition rule while running at the wrong rate or with too much jitter.
metadata:
  version: 1.0.0
---

# Measure the achieved tick rate

## When to use this

`tickrate-sim replay` reports no violations and the game still feels wrong. That combination is
the one a transition table cannot explain: a server running 58 Hz against a declared 64 Hz
satisfies every budget it was given.

## Steps

1. **Confirm there are anchors.** Rate measurement needs at least two wall-clock readings in the
   trace. Without them the report says `under_anchored` - which is "no data", not "perfect".
2. **Measure:**
   `tickrate-sim stats trace.json --table table.json`
3. **Read drift first.** `drift` is in parts per million, because that is the only unit in which
   a small error is legible. A 64 Hz tick is 15.625 ms, so one millisecond of quantisation is
   already 64 000 ppm; do not treat small drift as meaningful.
4. **Then read jitter.** Jitter is the spread of the _interval_ rates, not of the mean. A server
   whose mean is exactly on rate but whose frames alternate between 50 ms and 75 ms will drop
   clients that assume a steady budget, and only jitter shows it.

## Reading the output

| Field           | Meaning                                                        |
| --------------- | -------------------------------------------------------------- |
| `effectiveHz`   | ticks actually delivered per second, from first to last anchor |
| `driftPpm`      | signed distance from the declared rate, in parts per million   |
| `minHz`/`maxHz` | the extremes of the individual intervals                       |
| `medianHz`      | the middle interval rate                                       |
| `jitterHz`      | `maxHz - minHz`                                                |
| `verdict`       | `on_rate`, `drifting`, or `under_anchored`                     |

## Verify

`tickrate-sim stats` prints a `verdict`. If it says `under_anchored`, add anchors to the trace
and run it again - the absence of a number here is not evidence of a correct rate.
