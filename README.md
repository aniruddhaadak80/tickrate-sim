<div align="center">

# Tickrate Sim

**Replay a recorded multiplayer tick trace against your declared netcode state machine, and get the first transition the table does not permit.**

[CI](https://github.com/aniruddhaadak80/tickrate-sim/actions/workflows/ci.yml) ·
[Live app](https://tickrate-sim.vercel.app) ·
[License](https://github.com/aniruddhaadak80/tickrate-sim/blob/main/LICENSE) ·
[Issues](https://github.com/aniruddhaadak80/tickrate-sim/issues)

</div>

---

## What this is

You have written down how your game server is allowed to behave: a table of states, the
transitions between them, and how many ticks each transition may take. You also have a
recording of what the server actually did, tick by tick.

**Tickrate Sim replays the recording against the declaration and tells you exactly where they
disagree** — the tick, the rule, the budget, and by how much. It is a debugger for
multiplayer tick loops and a regression gate for netcode design changes.

It is not a dashboard, and it is not an agent. Every number it reports is arithmetic over
integers, computed by a Python engine that is `mypy --strict` clean and covered by property
tests. That is the whole design.

## Why

Desync bugs are expensive because they are hard to localize. The question is never "is the
game broken" — it is "which tick did the server do something my design says it may not do".
Today you answer that by writing a throwaway Python harness per bug, or by reading packet logs
and reasoning about them by hand.

Three things this does that reading logs does not:

- **It names the tick.** Not "invalid transition", but `tick 331, BUDGET_OVERRUN,
resimulating -> live, rule finish_resim, 31 ticks elapsed against a budget of 10`.
- **It reports coverage.** A trace that exercised 2 of 8 declared edges has not disproved
  anything about the other 6. A tool that only said "legal" would be hiding that.
- **It tells you when a table change breaks a passing trace.** Raising a `minTicks` from 192 to
  256 adds no edge and removes none, and still rejects every trace that fired early.

## Quick start

Requires Node >= 22.12 and Python >= 3.11.

```bash
npm install
npm run build
node packages/cli/dist/bin.js corpus show undeclared-skip
```

That is a real replay through the real engine — the walk, the violations and the coverage all
come from Python:

```
Server ends a match from the countdown
  countdown -> ended has no rule anywhere in the table.

replay undeclared-skip against skirmish-64  [1 VIOLATION(S)]

  lobby -> ended   ticks 0..600 (600)   events 2   declared 64 Hz

  timeline
      tick     0  lobby          +    0 ticks  via -
      tick    24  countdown      +   24 ticks  via begin_countdown
    ! tick   240  ended          +  216 ticks  via -

  violations
    tick   240  UNDECLARED_TRANSITION    countdown -> ended  rule -
      no rule permits 'countdown' -> 'ended'; the table allows 'live'

  coverage
    1/8 declared edges exercised (12.5%)
    never taken: abandon_match, begin_rollback, end_match, finish_resim, pause_match,
    resume_match, start_match
```

Check your own installation at any time:

```bash
node packages/cli/dist/bin.js doctor
```

```
tickrate-sim doctor
  [PASS] node     v22.23.2
  [PASS] package  tickrate-sim@0.1.0
  [PASS] skills   5 skills, 0 invalid
  [PASS] plugins  1 active, 0 disabled
  [WARN] config   no product.config.json - using defaults
         fix: run with defaults, or create product.config.json
  [PASS] engine   tickrate_sim answered: table "doctor-probe", 1 state(s)
  [PASS] corpus   4 corpus files present

all required checks passed
```

The `engine` row is not a claim. `doctor` spawns Python and calls the engine; a passing row is
evidence that the subprocess, the JSON round-trip and the operation wiring all work.

## Walkthrough

Nine traces ship with the product. Every number below is the engine's, from a real run.

### 1. A budget overrun the table can explain

```bash
node packages/cli/dist/bin.js corpus show rollback-storm
```

The rule `finish_resim` allows 10 ticks in `resimulating` before the match may resume. Late
client inputs stretch it:

```
replay rollback-storm against skirmish-64  [3 VIOLATION(S)]

  timeline
      tick     0  lobby          +    0 ticks  via -
      tick    24  countdown      +   24 ticks  via begin_countdown
      tick   216  live           +  192 ticks  via start_match
      tick   300  resimulating   +   84 ticks  via begin_rollback
    ! tick   331  live           +   31 ticks  via finish_resim
      tick   420  resimulating   +   89 ticks  via begin_rollback
    ! tick   470  live           +   50 ticks  via finish_resim
      tick   600  resimulating   +  130 ticks  via begin_rollback
    ! tick   688  live           +   88 ticks  via finish_resim
      tick   900  ended          +  212 ticks  via end_match

  violations
    tick   331  BUDGET_OVERRUN  resimulating -> live  rule finish_resim
      rule 'finish_resim' allows at most 10 tick(s) in 'resimulating'; 31 elapsed
    tick   470  BUDGET_OVERRUN  resimulating -> live  rule finish_resim
      rule 'finish_resim' allows at most 10 tick(s) in 'resimulating'; 50 elapsed
    tick   688  BUDGET_OVERRUN  resimulating -> live  rule finish_resim
      rule 'finish_resim' allows at most 10 tick(s) in 'resimulating'; 88 elapsed

  coverage
    5/8 declared edges exercised (62.5%)
    never taken: abandon_match, pause_match, resume_match
```

Note that all three violations are reported, not just the first. A trace is a recording of a
real run, so refusing to keep walking after the first problem would make every later tick
unreportable.

### 2. A clean replay that proves almost nothing

```bash
node packages/cli/dist/bin.js corpus show clean-64hz
```

`LEGAL`, zero violations, `64.0 Hz`, zero jitter — and 5 of 8 declared edges never taken. A
trace that is clean because it exercised almost nothing is the failure mode this tool is
built to make visible.

### 3. A clean replay on a server that is running slow

This is the case a transition table cannot catch, and the reason `tickrate_stats` exists.

```bash
node packages/cli/dist/bin.js stats tick-drift.json --table skirmish-64.json
```

```
tickrate tick-drift  [drifting]

  declared   64 Hz (15.625 ms per tick)
  effective  58.0008 Hz
  drift      -93738 ppm
  intervals  30 sampled
  range      57.9710 Hz .. 58.0236 Hz
  median     58.0236 Hz
  jitter     0.0526 Hz  (+907 ppm)

  effective 58.0008 Hz against a declared 64 Hz (15.625 ms per tick) over 1920 ticks in 33103 ms
```

Every budget in the table was satisfied. The server is still 9% slow. Drift is reported in
parts per million because that is the only unit in which a small error is legible — one
millisecond of anchor quantisation at 64 Hz is already 64 000 ppm.

The shipped `jittery-frames` case is the sharper version: its **mean is exactly 64 Hz and its
drift is 0**, because alternating 50 ms and 75 ms gaps average to a perfect tick budget. Only
the jitter reveals it. A tool that reported a mean would call that server healthy.

### 4. A table that is wrong before any trace exists

```bash
node packages/cli/dist/bin.js validate skirmish-broken.json
```

```
table skirmish-broken  [7 ERROR(S)]

  5 states, 6 transitions, entry warmup, 64 Hz
  terminal: finished
  unreachable: finished, looping, orphaned, playing, staging
  dead ends: orphaned

  issues
    [error] AMBIGUOUS_EDGE         to_playing
      'staging' -> 'playing' is declared 2 times (to_playing, to_playing_again); a trace
      cannot say which rule it satisfied
    [error] BUDGET_INVERTED        inverted_budget
      maxTicks (30) is below minTicks (90); no tick count can satisfy this rule
    [error] DUPLICATE_STATE        staging
      state 'staging' is declared more than once; the last declaration wins silently
    [error] ENTRY_UNDECLARED       warmup
      entry state 'warmup' is not declared in states
    [error] NEGATIVE_BUDGET        negative_budget
      minTicks is -1; a negative tick count is meaningless
    [error] TERMINAL_WITH_EXIT     finished
      state 'finished' is terminal yet declares 1 outgoing transition(s)
    [error] UNKNOWN_TARGET         into_the_void
      transition 'playing' -> 'nowhere' enters undeclared state 'nowhere'
    [warn] DEAD_END               orphaned
      state 'orphaned' has no outgoing transition but is not marked terminal, so a trace
      that reaches it can never finish
    [warn] UNREACHABLE_STATE       finished
      ...
```

Eight distinct problem classes, none of which any trace replay would ever surface, because a
broken declaration makes the replay meaningless rather than wrong.

### 5. Which change would break a passing trace

```bash
node packages/cli/dist/bin.js diff skirmish-64.json skirmish-64-r2.json
```

```
diff skirmish-64 -> skirmish-64-r2  [2 BREAKING CHANGE(S)]

  64 Hz -> 64 Hz
  6 edge(s) unchanged

  changes
    ! modified  rule:countdown->live (start_match)
      minTicks moved from 192 to 256, which rejects traces that used to pass
    ! removed   rule:lobby->ended (abandon_match)
      edge deleted; any trace that took it now fails with UNDECLARED_TRANSITION
```

No edge was added. Both changes are still breaking. `breaking` is directional on purpose —
tightening a budget breaks the old table, loosening it again does not break the new one — and
a property test asserts a subject can never be breaking in both directions.

### 6. Where the budgets actually sit

```bash
node packages/cli/dist/bin.js budget trace.json --table table.json
```

```
budget rollback-storm  (3 overrun(s), 0 underrun(s), 3 unused)

RULE             EDGE                DECLARED  N  OBSERVED  USE   VERDICT
---------------  ------------------  --------  -  --------  ----  --------------------
begin_countdown  lobby->countdown    0..180    1  24..24    13%   within_budget
start_match      countdown->live     192..192  1  192..192  100%  within_budget
begin_rollback   live->resimulating  0..inf    3  84..130   -     within_budget
finish_resim     resimulating->live  1..10     3  31..88    880%  slower_than_declared
pause_match      live->paused        0..inf    0  -         -     unused
resume_match     paused->live        30..9600  0  -         -     unused
end_match        live->ended         0..inf    1  212..212  -     within_budget
abandon_match    lobby->ended        0..inf    0  -         -     unused
```

`880%` of a declared budget is the number that finds a rollback budget nobody tuned. `unused`
is the number that finds a rule no test has ever reached.

## How it works

```
apps/web ─┐
CLI ──────┼──> packages/core: one Tool registry ──> services/engine (Python, pure)
MCP ──────┘        │                                        │
                   └── skills · plugins · memory             └── stdin/stdout JSON
```

**The narrow waist.** Every capability is a `Tool` in one registry in `packages/core`. The CLI,
the web API and the MCP server are transports: they resolve a name, validate input against the
tool's declared schema, and return the handler's result. The MCP tool list is _derived_ from
that registry, so a tool cannot exist in one place and be forgotten in another.

**The deterministic engine.** Five pure Python functions over a transition table and a trace.
No clock, no network, no randomness, no filesystem — time and entropy arrive as arguments.
Called as a function over stdin/stdout, so there is no server, no port, and no session that two
concurrent calls could corrupt.

## The deterministic engine

| Operation        | Question                                         |
| ---------------- | ------------------------------------------------ |
| `validate_table` | Is the declaration coherent?                     |
| `replay`         | Where did reality outgrow the declaration?       |
| `tickrate_stats` | What rate did the server actually hit?           |
| `budget_profile` | Which tick budgets are tight, and which fiction? |
| `diff_tables`    | Which change would make a passing trace fail?    |

Why this must be code and not a model call: `drift` is a ratio over thousands of anchors, and
a model will return a confident number that is wrong in the third digit. The engine has **no
runtime dependency at all**, because every dependency is startup latency on a path that is
spawned per call.

Two decisions inside it are load-bearing, and both are the kind of thing that looks like
over-engineering until you have been bitten:

**Parsing happens once, at the boundary.** `model.py` validates every document. After
`parse_table` returns, no operation re-checks a field.

**`replay` is total.** It never raises on a bad trace — it reports. After an illegal edge it
_repairs_ by adopting the observed target state and keeps walking, because a trace records what
a server really did and refusing to model it would make every later tick unreportable. The
first violation is called out separately, since that is the one a human wants.

## The browser mirror, and why it is trusted

A Vercel function cannot spawn Python, so the deployed page cannot call the engine. Rather than
display stored output — which would look like the product and be a screenshot of it —
`apps/web/lib/engine.ts` recomputes the report in the browser.

That substitution is only honest because it is **proven**:

- Every case in `apps/web/data` carries the Python engine's own committed output.
- `apps/web/tests/parity.test.mjs` replays every case through both implementations and fails on
  the first byte of difference.
- The Python suite re-derives the same expectations from the engine on every run.

```bash
npm run parity
```

```
ok 1 - the browser mirror reproduces the engine for every shipped case
ok 2 - the browser mirror reproduces the engine tickrate stats
ok 3 - the browser mirror reproduces the engine budget profile
ok 4 - every violation code the corpus exercises is reproduced exactly
ok 5 - the browser mirror reproduces the engine table diff
ok 6 - the corpus tables are the ones the engine validated
ok 7 - the engine this file claims to mirror is where it says it is
ok 8 - the corpus is bundled, not fetched at runtime
ok 9 - tokens.css defines both themes
ok 10 - tokens.css is the only file containing raw colour literals
# pass 10
# fail 0
```

The gate paid for itself immediately, by finding two real divergences:

- Python's `round()` is **banker's rounding**; `Math.round` rounds half away from zero. On
  `6/192 = 0.03125` Python gives `0.0312` and JavaScript gives `0.0313` — a difference in the
  fourth decimal, exactly the size nobody notices by eye and exactly the kind that makes a tool
  lie. The mirror now implements round-half-to-even.
- Python's `str(64.0)` is `'64.0'`; JavaScript's is `'64'`.

Both were fixed in the mirror, not by relaxing the test. A parity gate that can be satisfied by
weakening the assertion is not a parity gate.

## Skills

Five skills ship for agents driving this tool. `metadata.version` is bumped on every body
change, and CI fails a body change without one.

| Skill                   | Use it when                                                   |
| ----------------------- | ------------------------------------------------------------- |
| `product-overview`      | orienting yourself: the map, not the detail                   |
| `replay-a-trace`        | checking a recorded trace against a declared state machine    |
| `measure-tickrate`      | a replay is clean but players still report stutter            |
| `review-a-table-change` | two table revisions exist and one may be safer than the other |
| `diagnose`              | something is broken and the failing subsystem is unknown      |

## MCP

Seven tools over stdio, all backed by the one core registry — so an agent can validate a table
and replay a trace without a shell.

```bash
npm run mcp:probe
```

That script spawns the server as a child process and speaks JSON-RPC to it over a pipe. It is
not a mocked client, because the failure it catches is a protocol regression a mock would
happily agree with:

```
  [PASS] initialize returns serverInfo - {"name":"tickrate-sim","version":"0.1.0"}
  [PASS] tools/list advertises every product tool - budget_profile, diff_tables,
         list_plugins, list_skills, replay_trace, tickrate_stats, validate_table
  [PASS] every tool carries a description a model can act on
  [PASS] every tool carries an object inputSchema
  [PASS] tools/call validate_table reaches the Python engine - tableId=probe
  [PASS] tools/call replay_trace reports the first violation - first=BUDGET_UNDERRUN tick=3
  [PASS] the replay report reaches the caller intact - 3 timeline steps
  [PASS] an invalid input returns an error envelope, not a crash - VALIDATION_FAILED:
         trace.tableId "some-other-table" does not match table.id "probe"
  [PASS] an unknown tool returns an error envelope

  9 passed, 0 failed
```

To use it from an agent, add this to your MCP client config:

```json
{
  "mcpServers": {
    "tickrate-sim": {
      "command": "node",
      "args": ["packages/cli/dist/bin.js", "mcp", "serve"],
      "env": { "PYTHON": "python" }
    }
  }
}
```

## CLI

| Command                           | What it does                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `validate <table.json>`           | structural check; exit 1 on any error-severity finding        |
| `table <table.json>`              | print a table readably                                        |
| `replay <trace.json> -t <table>`  | walk a trace; every violation, plus coverage                  |
| `stats <trace.json> -t <table>`   | effective Hz, drift in ppm, jitter                            |
| `budget <trace.json> -t <table>`  | declared bounds against observed                              |
| `diff <before> <after>`           | which changes break a passing trace; exit 1 when incompatible |
| `corpus list`                     | the nine shipped cases                                        |
| `corpus show <id>`                | replay one case and print the report                          |
| `corpus tables`                   | print every shipped table                                     |
| `doctor`                          | probe every subsystem, with a fix hint per failing row        |
| `tools [--json]`                  | the authoritative capability list                             |
| `mcp serve` / `mcp call <t> <in>` | run the MCP server, or invoke a tool without MCP              |
| `version`                         | version and runtime as JSON                                   |

Every read-only command takes `--json`. Exit codes: **0** ok, **1** runtime failure, **2** usage
error. A replay that finds violations still exits 0 — the tool worked, the trace did not —
because a CI job needs to tell "no bugs found" from "the tool could not run".

## What ships, and what deliberately does not

| Surface              | Status  | Note                                                                                            |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| Deterministic engine | shipped | Python, 5 operations, 137 tests, `mypy --strict` and `ruff` clean                               |
| CLI                  | shipped | every engine capability reachable without a browser                                             |
| MCP server           | shipped | 7 tools, verified over real stdio                                                               |
| Web workspace        | shipped | triage board over real traces; SSR first paint, 2.56 kB of JS                                   |
| JSON API             | shipped | `/api/cases`, `/api/cases/<id>`, `/api/health`                                                  |
| Skills catalog       | shipped | 5 skills, version-gated in CI                                                                   |
| Plugin registry      | shipped | manifest-driven, priority conflicts, stated rejections                                          |
| Embedded store       | shipped | SQLite, WAL, numbered migrations; the triage ledger answers "when did this break"               |
| Desktop (Electron)   | omitted | an Electron wrapper would add a build matrix and a signing pipeline to deliver the same web app |
| Channels             | omitted | this product is local-first plus a web app; it has no remote messaging surface to adapt         |
| Model providers      | omitted | every number here must be exactly right, and a model cannot be asked to add up ticks            |
| TUI                  | omitted | would be a worse version of `tickrate-sim replay`                                               |

## The web app

Three board columns and an inspector. The signature element is the **tick ruler**: one hairline
column per tick span, shaded by state, with a magenta marker at the first illegal tick — so
"where did it break" is answerable from a single screenshot.

Every route is statically prerendered, and there is no loading state anywhere in the app. That
is a decision, not an omission: nothing in this app can be pending, so a skeleton would flash
on a page that was never loading. Empty and error states ship, and both are reachable.

## Development

```bash
npm install          # also formats the tree
npm run build        # build every package
npm test             # 61 TypeScript tests across 9 packages
npm run pytest       # 137 Python tests
npm run check        # the aggregate gate CI runs
npm run parity       # the browser-mirror parity gate
npm run mcp:probe    # real MCP protocol proof over stdio
npm run sync:cases   # regenerate the corpus (a reviewed, explicit step)
```

| Gate                    | What it fails on                                                |
| ----------------------- | --------------------------------------------------------------- |
| `check:skill-version`   | a `SKILL.md` body changed without a `metadata.version` bump     |
| `check:no-secrets`      | committed credentials, or a `.env` with values                  |
| `check:theme-tokens`    | a raw colour literal outside `apps/web/styles/tokens.css`       |
| `check:boundaries`      | a package importing another's deep path                         |
| `check:public-hygiene`  | logs, editor dirs, caches, files over 1 MB, `TODO` under `src/` |
| `check:readme-commands` | a command in this README that is not a real script or binary    |

That last one is why every command above was actually run. It parses the fenced blocks in this
file and fails the build if one of them does not resolve.

Architecture decisions are recorded in `docs/adr/`:

- [0001 — The narrow waist is one tool registry](docs/adr/0001-narrow-waist.md)
- [0002 — The engine is a pure Python function over stdio](docs/adr/0002-python-engine-boundary.md)
- [0003 — The browser mirror is proven, not trusted](docs/adr/0003-browser-mirror-parity.md)
- [0004 — The corpus is committed generated data with a drift gate](docs/adr/0004-committed-generated-corpus.md)

## Contributing

Read [`AGENTS.md`](AGENTS.md) first — it routes each subsystem to the file that owns it, and
carries the footprint ladder that decides where new capability belongs. The engineering notes
that matter while you work are in [`docs/notes/`](docs/notes/).

Run `npm run check` before you open a pull request. It is the same command CI runs, so a green
local run and a green CI run cannot disagree.

## Security

Report a vulnerability through GitHub Security Advisories on this repository. See
[`SECURITY.md`](SECURITY.md) for supported versions and the response path.

## License

MIT. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
