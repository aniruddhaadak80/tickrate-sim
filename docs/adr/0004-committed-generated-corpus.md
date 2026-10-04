# ADR 0004 - The corpus is committed generated data with a drift gate

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The product needs example traces. There are three ways to get them, and they fail differently:

- **Hand-written JSON.** Anchors for a 64 Hz tick are 15.625 ms apart. Typing those by hand
  produces traces that are subtly wrong, and "subtly wrong example data" teaches the wrong thing
  to everyone who reads the README.
- **Generated at page load.** The deployed page would then be showing numbers no one has ever
  looked at, and a generator bug would be invisible.
- **Generated once, committed, and re-derived on every test run.**

## Decision

`services/engine/scripts/sync_cases.py` builds the corpus and writes it to `apps/web/data`:

```
tables.json         three transition tables, one of them deliberately broken
cases.json          nine traces, each with the engine's replay, budget and tickrate reports
table-diffs.json    two revisions of one table, with the engine's diff
table-checks.json   the engine's structural validation of each table
```

The committed `expected` blocks are produced **through `parse_table` and `parse_trace`**, so the
fixtures were generated through the same boundary a real caller uses and a parser change shows up
here rather than in production.

Two tests defend them:

- `test_golden.py` re-derives every report from the engine and fails on the first difference,
  naming the exact JSON path that drifted.
- `test_regeneration_is_reproducible` runs the generator twice and asserts the bytes are
  identical, so a generator that is not deterministic is caught rather than committed.

Regeneration is always an explicit, reviewed step:

```
python services/engine/scripts/sync_cases.py
```

## Consequences

- The corpus is simultaneously the Python golden fixture, the web app's bundled product data,
  and the source of every number quoted in the README. Three consumers, one file, no
  possibility of the docs describing a different tool than the one that ships.
- Because the data lives under `apps/web`, it is inside the Vercel deployment root and is imported
  statically. The deployed page needs no filesystem, no network and no cold-start dependency.
- The corpus is a test suite as well as a demo. `test_every_violation_code_appears_somewhere_in_the_corpus`
  fails if a violation code stops being demonstrated, so the examples cannot quietly stop covering
  the thing they exist to cover.
- Adding a case is a deliberate act with a reviewable diff. That is the intended friction: a new
  example should be argued for, not accumulated.
