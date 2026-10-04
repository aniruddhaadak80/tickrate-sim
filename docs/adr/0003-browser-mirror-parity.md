# ADR 0003 - The browser mirror is proven, not trusted

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

`apps/web` deploys to Vercel as a Node serverless function. A serverless function cannot spawn
Python, so the deployed page cannot call the engine. Three ways out:

1. **Display stored output.** The page renders reports that were computed at build time. The
   deployment looks like the product and is a screenshot of it. A reader who pastes a new trace
   into the API gets nothing back.
2. **Call a hosted Python service.** Now there is a service to deploy, secure, scale and pay for,
   plus a network hop on every page view, plus a failure mode that is not the product's fault.
3. **Recompute in the browser and prove the recomputation is the same computation.**

## Decision

Option 3. `apps/web/lib/engine.ts` is a TypeScript mirror of the five engine operations. The page
computes its own reports.

That is only acceptable because it is _proven_ rather than asserted:

- The committed corpus in `apps/web/data` carries the Python engine's own output for every case.
- `apps/web/tests/parity.test.mjs` replays every shipped case through both the mirror and the
  engine's expectations and fails on the first byte of difference.
- The Python suite re-derives the same expectations from the engine on every run.

So a drift between the two fails CI in one of two places, and the deployed page is genuinely
computing the product rather than replaying a recording of it.

The CLI, the MCP server and `doctor` continue to call Python. The mirror exists only where a
subprocess is impossible, and its scope is stated in the file that contains it.

## Consequences

The parity gate immediately earned its cost. Two real divergences surfaced on the first run:

- **Python's `round()` is banker's rounding; `Math.round` rounds half away from zero.** On
  `6/192 = 0.03125` Python gives `0.0312` and JavaScript gives `0.0313` - a difference in the
  fourth decimal, which is exactly the size of difference nobody would notice by eye and exactly
  the kind that makes a tool lie. The mirror now implements round-half-to-even, with the
  limitation documented in the function.
- **Python's `str(64.0)` is `'64.0'`; JavaScript's is `'64'`.** The human-readable `note` field
  differed by one character. The mirror renders integrals Python-style.

Both were fixed in the mirror rather than by loosening the test. A parity gate that can be
satisfied by relaxing the assertion is not a parity gate.

The known limit is stated rather than hidden: scaling by `10 ** digits` can move a value that is
exactly representable in decimal. If that ever happens for a shipped case, the parity test fails -
which is the correct outcome, and better than two implementations that disagree quietly.
