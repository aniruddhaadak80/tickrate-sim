import type {
  Anchor,
  BudgetProfile,
  BudgetVerdict,
  TableChange,
  TableDiff,
  ReplayReport,
  TickrateStats,
  TickTrace,
  TimelineStep,
  TransitionRule,
  TransitionTable,
  Violation,
} from '@tickratesim/core'

/**
 * A TypeScript mirror of the Python walk, for the browser.
 *
 * Why this exists at all: the product's engine is Python, invoked as a subprocess, and a
 * Vercel function cannot spawn one. Rather than have the deployed page *display stored
 * output* - which would look like a product and be a screenshot - the page computes the
 * report itself, in the browser, from the same inputs.
 *
 * That is only honest because it is proven equivalent. `tests/parity.test.mjs` replays every
 * committed case through this file and through the Python engine and fails on the first
 * difference, and the committed expectations are the Python engine's own output. So if this
 * mirror drifts, CI fails rather than the page quietly lying to someone debugging a desync.
 *
 * The rules below are transcribed from `services/engine/src/tickrate_sim/replay.py`, including
 * the repair behaviour: an illegal edge is recorded and then adopted, so the rest of the trace
 * stays reportable.
 */

const PRECISION = 4

/**
 * Round half to even, matching Python's `round(x, digits)`.
 *
 * This exists because `Math.round` rounds half away from zero and Python does not. On
 * `6/192 = 0.03125` the two disagree in the fourth decimal - `0.0312` versus `0.0313` - which
 * is exactly the size of difference a parity gate exists to catch. Using `Math.round` here
 * would mean the browser quietly reported a different budget utilisation than the engine.
 *
 * Known limit: scaling by `10 ** digits` can move a value that is exactly representable in
 * decimal. When that ever happens, `tests/parity.test.mjs` fails on the affected case, which
 * is the correct outcome - better a red test than two implementations that disagree quietly.
 */
function round(value: number, digits: number = PRECISION): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const fraction = scaled - floor
  const rounded = fraction > 0.5 ? floor + 1 : fraction < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1
  return rounded / factor
}

/**
 * Render a float the way Python's `str()` does, so the mirrored `note` string is byte-equal
 * to the engine's. Python keeps the `.0`; JavaScript drops it.
 */
function fixed(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value)
}

type PositionedRule = readonly [number, TransitionRule]

function rulesLeaving(table: TransitionTable, state: string): readonly PositionedRule[] {
  const out: PositionedRule[] = []
  table.transitions.forEach((rule, position) => {
    if (rule.source === state) out.push([position, rule])
  })
  return out
}

function isTerminal(table: TransitionTable, state: string): boolean {
  return table.states.find((entry) => entry.name === state)?.terminal === true
}

function violation(
  code: Violation['code'],
  tick: number,
  state: string,
  target: string,
  rule: string | null,
  ticksInState: number,
  message: string,
): Violation {
  return { code, tick, state, target, rule, ticksInState, message }
}

function budgetViolations(
  rule: TransitionRule,
  ticksInState: number,
  seenBefore: boolean,
  tick: number,
): Violation[] {
  const problems: Violation[] = []
  if (seenBefore && !rule.repeatable) {
    problems.push(
      violation(
        'REPEAT_TRANSITION',
        tick,
        rule.source,
        rule.target,
        rule.id,
        ticksInState,
        `rule '${rule.id}' is declared once-only but was taken more than once`,
      ),
    )
  }
  if (ticksInState < rule.minTicks) {
    problems.push(
      violation(
        'BUDGET_UNDERRUN',
        tick,
        rule.source,
        rule.target,
        rule.id,
        ticksInState,
        `rule '${rule.id}' requires ${rule.minTicks} tick(s) in '${rule.source}' before it may fire; only ${ticksInState} elapsed`,
      ),
    )
  }
  if (rule.maxTicks !== null && ticksInState > rule.maxTicks) {
    problems.push(
      violation(
        'BUDGET_OVERRUN',
        tick,
        rule.source,
        rule.target,
        rule.id,
        ticksInState,
        `rule '${rule.id}' allows at most ${rule.maxTicks} tick(s) in '${rule.source}'; ${ticksInState} elapsed`,
      ),
    )
  }
  return problems
}

/** Mirror of `tickrate_sim.replay.replay`. Total: no input makes it throw. */
export function replay(table: TransitionTable, trace: TickTrace): ReplayReport {
  let state = table.entry
  let enteredAt = trace.startTick
  let lastTick = trace.startTick
  let sawEvent = false

  const timeline: TimelineStep[] = [
    { tick: trace.startTick, state: table.entry, ticksInState: 0, via: null, viaIndex: null, legal: true },
  ]
  const violations: Violation[] = []
  const counts = new Map<number, number>()

  for (const event of trace.events) {
    const target = event.target
    const ticksInState = event.tick - enteredAt
    let legal = true

    if (sawEvent && event.tick < lastTick) {
      violations.push(
        violation(
          'NON_MONOTONIC_TICK',
          event.tick,
          state,
          target,
          null,
          ticksInState,
          `tick ${event.tick} precedes the previous event at tick ${lastTick}; a server cannot un-run a tick`,
        ),
      )
      legal = false
    }
    if (event.tick < trace.startTick || event.tick > trace.endTick) {
      violations.push(
        violation(
          'EVENT_OUT_OF_RANGE',
          event.tick,
          state,
          target,
          null,
          ticksInState,
          `tick ${event.tick} lies outside the declared window [${trace.startTick}, ${trace.endTick}]`,
        ),
      )
      legal = false
    }

    if (!table.states.some((entry) => entry.name === target)) {
      violations.push(
        violation(
          'UNKNOWN_STATE',
          event.tick,
          state,
          target,
          null,
          ticksInState,
          `trace enters state '${target}', which the table never declares`,
        ),
      )
      legal = false
    }

    if (isTerminal(table, state)) {
      violations.push(
        violation(
          'TERMINAL_EXIT',
          event.tick,
          state,
          target,
          null,
          ticksInState,
          `state '${state}' is terminal, so leaving it is not a legal move`,
        ),
      )
      legal = false
    }

    const candidates = rulesLeaving(table, state)
    const match = candidates.find(([, rule]) => rule.target === target)

    if (match === undefined) {
      const allowed = [...new Set(candidates.map(([, rule]) => rule.target))].sort()
      const listed =
        allowed.length === 0 ? 'no outgoing transitions' : allowed.map((n) => `'${n}'`).join(', ')
      violations.push(
        violation(
          'UNDECLARED_TRANSITION',
          event.tick,
          state,
          target,
          null,
          ticksInState,
          `no rule permits '${state}' -> '${target}'; the table allows ${listed}`,
        ),
      )
      legal = false
    } else {
      const [position, rule] = match
      const seenBefore = (counts.get(position) ?? 0) > 0
      for (const problem of budgetViolations(rule, ticksInState, seenBefore, event.tick)) {
        violations.push(problem)
        legal = false
      }
      counts.set(position, (counts.get(position) ?? 0) + 1)
    }

    timeline.push({
      tick: event.tick,
      state: target,
      ticksInState,
      via: match?.[1].id ?? null,
      viaIndex: match?.[0] ?? null,
      legal,
    })

    // The repair: adopt whatever the server actually did, so later ticks stay reportable.
    state = target
    enteredAt = event.tick
    lastTick = event.tick
    sawEvent = true
  }

  const uncovered = table.transitions
    .map((rule, position) => ({ rule, position }))
    .filter(({ position }) => (counts.get(position) ?? 0) === 0)
    .map(({ rule }) => rule.id)
    .sort()

  const declared = table.transitions.length
  const exercised = declared - uncovered.length

  return {
    traceId: trace.id,
    tableId: table.id,
    ok: violations.length === 0,
    tickrateHz: table.tickrateHz,
    startTick: trace.startTick,
    endTick: trace.endTick,
    startState: table.entry,
    endState: state,
    ticksElapsed: trace.endTick - trace.startTick,
    eventsObserved: trace.events.length,
    violations,
    firstViolation: violations[0] ?? null,
    timeline,
    coverage: {
      declared,
      exercised,
      ratio: declared === 0 ? 0 : round(exercised / declared),
      uncovered,
    },
  }
}

function intervalRates(anchors: readonly Anchor[]): number[] {
  const rates: number[] = []
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]
    const current = anchors[index]
    if (previous === undefined || current === undefined) continue
    if (current.ms <= previous.ms || current.tick <= previous.tick) {
      throw new Error(
        `anchors[${index}] must be strictly increasing in both tick and ms; ` +
          `got tick ${previous.tick}->${current.tick}, ms ${previous.ms}->${current.ms}`,
      )
    }
    rates.push(((current.tick - previous.tick) * 1000) / (current.ms - previous.ms))
  }
  return rates
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  const low = ordered[middle - 1]
  const high = ordered[middle]
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0
  return ((low ?? 0) + (high ?? 0)) / 2
}

/** Mirror of `tickrate_sim.stats.tickrate_stats`. */
export function tickrateStats(table: TransitionTable, trace: TickTrace): TickrateStats {
  const declared = table.tickrateHz
  const budgetMs = round(1000 / declared)
  const rates = intervalRates(trace.anchors)

  if (rates.length === 0) {
    return {
      traceId: trace.id,
      tableId: table.id,
      declaredHz: declared,
      tickBudgetMs: budgetMs,
      effectiveHz: null,
      driftPpm: null,
      driftRatio: null,
      samples: 0,
      minHz: null,
      medianHz: null,
      maxHz: null,
      jitterHz: null,
      jitterPpm: null,
      verdict: 'under_anchored',
      note: `need at least 2 anchors to measure a rate; got ${trace.anchors.length}`,
    }
  }

  const first = trace.anchors[0]
  const last = trace.anchors[trace.anchors.length - 1]
  if (first === undefined || last === undefined) throw new Error('anchors cannot be empty here')

  const exactHz = ((last.tick - first.tick) * 1000) / (last.ms - first.ms)
  const exactRatio = exactHz / declared
  const driftPpm = Math.round((exactRatio - 1) * 1_000_000)

  const minHz = Math.min(...rates)
  const maxHz = Math.max(...rates)
  const exactJitter = maxHz - minHz

  return {
    traceId: trace.id,
    tableId: table.id,
    declaredHz: declared,
    tickBudgetMs: budgetMs,
    effectiveHz: round(exactHz),
    driftPpm,
    driftRatio: round(exactRatio),
    samples: rates.length,
    minHz: round(minHz),
    medianHz: round(median(rates)),
    maxHz: round(maxHz),
    jitterHz: round(exactJitter),
    jitterPpm: minHz > 0 ? Math.round((exactJitter / minHz) * 1_000_000) : null,
    verdict: driftPpm === 0 ? 'on_rate' : 'drifting',
    note:
      `effective ${fixed(round(exactHz))} Hz against a declared ${declared} Hz ` +
      `(${budgetMs} ms per tick) over ${last.tick - first.tick} ticks in ${last.ms - first.ms} ms`,
  }
}

/** Mirror of `tickrate_sim.replay.budget_profile`, folded from the same timeline. */
export function budgetProfile(table: TransitionTable, trace: TickTrace): BudgetProfile {
  const report = replay(table, trace)
  const stats = new Map<number, { count: number; min: number; max: number }>()

  for (const step of report.timeline) {
    if (step.viaIndex === null) continue
    const ticks = step.ticksInState
    const existing = stats.get(step.viaIndex)
    if (existing === undefined) {
      stats.set(step.viaIndex, { count: 1, min: ticks, max: ticks })
      continue
    }
    existing.count += 1
    existing.min = Math.min(existing.min, ticks)
    existing.max = Math.max(existing.max, ticks)
  }

  let unused = 0
  const rows = table.transitions.map((rule, index) => {
    const observed = stats.get(index)
    if (observed === undefined) unused += 1
    const declaredMax = rule.maxTicks
    const verdict: BudgetVerdict =
      observed === undefined
        ? 'unused'
        : declaredMax !== null && observed.max > declaredMax
          ? 'slower_than_declared'
          : observed.max < rule.minTicks
            ? 'faster_than_declared'
            : 'within_budget'
    return {
      rule: rule.id,
      index,
      source: rule.source,
      target: rule.target,
      declaredMin: rule.minTicks,
      declaredMax,
      observedCount: observed?.count ?? 0,
      observedMin: observed?.min ?? null,
      observedMax: observed?.max ?? null,
      utilisation:
        observed === undefined || declaredMax === null || declaredMax <= 0
          ? null
          : round(observed.max / declaredMax),
      verdict,
    }
  })

  const codes = report.violations.map((entry) => entry.code)
  return {
    traceId: trace.id,
    tableId: table.id,
    rows,
    overruns: codes.filter((code) => code === 'BUDGET_OVERRUN').length,
    underruns: codes.filter((code) => code === 'BUDGET_UNDERRUN').length,
    unused,
  }
}

// ------------------------------------------------------------------ table diff

/** Rules grouped by the edge they describe, in declaration order within each edge. */
function groupByEdge(table: TransitionTable): Map<string, TransitionRule[]> {
  const byEdge = new Map<string, TransitionRule[]>()
  for (const rule of table.transitions) {
    const key = edgeKey(rule)
    const bucket = byEdge.get(key)
    if (bucket === undefined) byEdge.set(key, [rule])
    else bucket.push(rule)
  }
  return byEdge
}

function edgeKey(rule: TransitionRule): string {
  return `${rule.source} ${rule.target}`
}

function changedFields(before: TransitionRule, after: TransitionRule): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys]
    .filter(
      (key) =>
        (before as unknown as Record<string, unknown>)[key] !==
        (after as unknown as Record<string, unknown>)[key],
    )
    .sort()
}

function isTighter(field: string, before: unknown, after: unknown): boolean {
  if (field === 'minTicks') {
    return typeof before === 'number' && typeof after === 'number' && after > before
  }
  if (before === null || before === undefined) return typeof after === 'number'
  if (after === null || after === undefined) return false
  return typeof before === 'number' && typeof after === 'number' && after < before
}

/** Mirror of `tickrate_sim.diffing.diff_tables`. */
export function diffTables(before: TransitionTable, after: TransitionTable): TableDiff {
  const leftStates = before.states.map((state) => state.name)
  const rightStates = after.states.map((state) => state.name)

  const changes: TableChange[] = []
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  let unchanged = 0

  const leftByEdge = groupByEdge(before)
  const rightByEdge = groupByEdge(after)
  const edges = [...new Set([...leftByEdge.keys(), ...rightByEdge.keys()])].sort()

  for (const key of edges) {
    const lefts = leftByEdge.get(key) ?? []
    const rights = rightByEdge.get(key) ?? []
    const length = Math.max(lefts.length, rights.length)
    for (let index = 0; index < length; index += 1) {
      const old = lefts[index]
      const updated = rights[index]
      if (old === undefined && updated === undefined) continue

      if (old === undefined && updated !== undefined) {
        added.push(updated.id)
        changes.push({
          kind: 'added',
          subject: ruleSubject(updated),
          breaking: false,
          fields: ['id', 'source', 'target', 'minTicks', 'maxTicks'],
          before: null,
          after: { ...updated },
          reason: 'new edge; traces that previously failed here now have a rule to satisfy',
        })
        continue
      }

      if (updated === undefined && old !== undefined) {
        removed.push(old.id)
        changes.push({
          kind: 'removed',
          subject: ruleSubject(old),
          breaking: true,
          fields: ['id', 'source', 'target', 'minTicks', 'maxTicks'],
          before: { ...old },
          after: null,
          reason: 'edge deleted; any trace that took it now fails with UNDECLARED_TRANSITION',
        })
        continue
      }

      if (old === undefined || updated === undefined) continue

      const fields = changedFields(old, updated)
      if (fields.length === 0) {
        unchanged += 1
        continue
      }

      const tightener = fields.find(
        (field) =>
          (field === 'minTicks' || field === 'maxTicks') &&
          isTighter(
            field,
            (old as unknown as Record<string, unknown>)[field],
            (updated as unknown as Record<string, unknown>)[field],
          ),
      )
      const touchedBudget = fields.some((field) => field === 'minTicks' || field === 'maxTicks')

      let reason: string
      if (tightener !== undefined) {
        reason =
          `${tightener} moved from ${String((old as unknown as Record<string, unknown>)[tightener])} ` +
          `to ${String((updated as unknown as Record<string, unknown>)[tightener])}, ` +
          `which rejects traces that used to pass`
      } else if (touchedBudget) {
        reason = 'budget widened; traces that used to pass still pass'
      } else {
        reason = 'metadata only; no tick behaviour changed'
      }

      changed.push(updated.id)
      changes.push({
        kind: 'modified',
        subject: ruleSubject(updated),
        breaking: tightener !== undefined,
        fields,
        before: { ...old },
        after: { ...updated },
        reason,
      })
    }
  }

  const statesAdded = rightStates.filter((name) => !leftStates.includes(name)).sort()
  const statesRemoved = leftStates.filter((name) => !rightStates.includes(name)).sort()

  for (const name of statesAdded) {
    changes.push({
      kind: 'added',
      subject: `state:${name}`,
      breaking: false,
      fields: ['name', 'terminal'],
      before: null,
      after: { ...(after.states.find((state) => state.name === name) ?? { name }) },
      reason: 'new state; only traces that reach it are affected',
    })
  }
  for (const name of statesRemoved) {
    changes.push({
      kind: 'removed',
      subject: `state:${name}`,
      breaking: true,
      fields: ['name', 'terminal'],
      before: { ...(before.states.find((state) => state.name === name) ?? { name }) },
      after: null,
      reason: 'state deleted; any trace that entered it now fails with UNKNOWN_STATE',
    })
  }

  const breaking = [
    ...new Set(changes.filter((change) => change.breaking).map((change) => change.subject)),
  ].sort()

  return {
    fromId: before.id,
    toId: after.id,
    statesAdded,
    statesRemoved,
    rulesAdded: added.sort(),
    rulesRemoved: removed.sort(),
    rulesChanged: changed.sort(),
    unchanged,
    tickrateBefore: before.tickrateHz,
    tickrateAfter: after.tickrateHz,
    tickrateChanged: before.tickrateHz !== after.tickrateHz,
    changes,
    breaking,
    compatible: breaking.length === 0,
  }
}

function ruleSubject(rule: TransitionRule): string {
  return `rule:${rule.source}->${rule.target} (${rule.id})`
}
