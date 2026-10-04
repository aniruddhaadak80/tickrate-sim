import type {
  BudgetProfile,
  ReplayReport,
  TableDiff,
  TableValidation,
  TickrateStats,
  TransitionTable,
} from '@tickratesim/core'
import type { Case } from './corpus.js'

/**
 * Terminal rendering. Every number here comes from an engine report - nothing is recomputed,
 * rounded differently, or "helpfully" summarised, because the CLI showing a different figure
 * from the engine is how a tool starts lying.
 */

const SEVERITY_LABEL: Record<Case['severity'], string> = {
  clean: 'clean',
  minor: 'minor',
  major: 'major',
  critical: 'critical',
}

function pad(value: string | number, width: number): string {
  return String(value).padEnd(width)
}

function padStart(value: string | number, width: number): string {
  return String(value).padStart(width)
}

export function renderReplay(report: ReplayReport): string {
  const lines: string[] = []
  const verdict = report.ok ? 'LEGAL' : `${report.violations.length} VIOLATION(S)`
  lines.push(`replay ${report.traceId} against ${report.tableId}  [${verdict}]`)
  lines.push('')
  lines.push(
    `  ${report.startState} -> ${report.endState}   ` +
      `ticks ${report.startTick}..${report.endTick} (${report.ticksElapsed})   ` +
      `events ${report.eventsObserved}   declared ${report.tickrateHz} Hz`,
  )
  lines.push('')

  lines.push('  timeline')
  for (const step of report.timeline) {
    const mark = step.legal ? ' ' : '!'
    const via = step.via === null ? '-' : step.via
    lines.push(
      `    ${mark} tick ${padStart(step.tick, 5)}  ${pad(step.state, 14)}` +
        ` +${padStart(step.ticksInState, 5)} ticks  via ${via}`,
    )
  }

  lines.push('')
  lines.push('  violations')
  if (report.violations.length === 0) {
    lines.push('    none - every observed transition is declared, and every budget held')
  } else {
    for (const violation of report.violations) {
      const rule = violation.rule === null ? '-' : violation.rule
      lines.push(
        `    tick ${padStart(violation.tick, 5)}  ${pad(violation.code, 24)}` +
          ` ${violation.state} -> ${violation.target}  rule ${rule}`,
      )
      lines.push(`      ${violation.message}`)
    }
  }

  lines.push('')
  lines.push('  coverage')
  lines.push(
    `    ${report.coverage.exercised}/${report.coverage.declared} declared edges exercised` +
      ` (${(report.coverage.ratio * 100).toFixed(1)}%)`,
  )
  lines.push(
    report.coverage.uncovered.length === 0
      ? '    every declared edge was taken by this trace'
      : `    never taken: ${report.coverage.uncovered.join(', ')}`,
  )
  return lines.join('\n')
}

export function renderTickrate(stats: TickrateStats): string {
  const lines = [
    `tickrate ${stats.traceId}  [${stats.verdict}]`,
    '',
    `  declared   ${stats.declaredHz} Hz (${stats.tickBudgetMs} ms per tick)`,
    `  effective  ${format(stats.effectiveHz)} Hz`,
    `  drift      ${formatPpm(stats.driftPpm)}`,
  ]
  if (stats.samples === 0) {
    lines.push('  intervals  none - at least two anchors are needed to measure a rate')
  } else {
    lines.push(`  intervals  ${stats.samples} sampled`)
    lines.push(`  range      ${format(stats.minHz)} Hz .. ${format(stats.maxHz)} Hz`)
    lines.push(`  median     ${format(stats.medianHz)} Hz`)
    lines.push(`  jitter     ${format(stats.jitterHz)} Hz  (${formatPpm(stats.jitterPpm)})`)
  }
  lines.push('')
  lines.push(`  ${stats.note}`)
  return lines.join('\n')
}

export function renderBudget(profile: BudgetProfile): string {
  const header = `budget ${profile.traceId}  (${profile.overruns} overrun(s), ${profile.underruns} underrun(s), ${profile.unused} unused)`
  const rows = profile.rows.map((row) => [
    row.rule,
    `${row.source}->${row.target}`,
    `${row.declaredMin}..${row.declaredMax ?? 'inf'}`,
    String(row.observedCount),
    row.observedMin === null ? '-' : `${row.observedMin}..${row.observedMax ?? '-'}`,
    row.utilisation === null ? '-' : `${(row.utilisation * 100).toFixed(0)}%`,
    row.verdict,
  ])
  const headers = ['RULE', 'EDGE', 'DECLARED', 'N', 'OBSERVED', 'USE', 'VERDICT']
  const widths = headers.map((name, index) =>
    Math.max(name.length, ...rows.map((row) => (row[index] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()
  return [header, '', line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join(
    '\n',
  )
}

export function renderValidation(report: TableValidation): string {
  const lines = [
    `table ${report.tableId}  [${report.ok ? 'OK' : `${report.errors} ERROR(S)`}]`,
    '',
    `  ${report.states} states, ${report.transitions} transitions, entry ${report.entry}, ${report.tickrateHz} Hz`,
    `  terminal: ${report.terminal.length === 0 ? 'none' : report.terminal.join(', ')}`,
  ]
  if (report.unreachable.length > 0) lines.push(`  unreachable: ${report.unreachable.join(', ')}`)
  if (report.deadEnds.length > 0) lines.push(`  dead ends: ${report.deadEnds.join(', ')}`)

  if (report.issues.length > 0) {
    lines.push('')
    lines.push('  issues')
    for (const issue of report.issues) {
      lines.push(`    [${issue.severity}] ${pad(issue.code, 22)} ${issue.subject}`)
      lines.push(`      ${issue.message}`)
    }
  }
  return lines.join('\n')
}

export function renderDiff(diff: TableDiff): string {
  const header = `diff ${diff.fromId} -> ${diff.toId}  [${
    diff.compatible ? 'COMPATIBLE' : `${diff.breaking.length} BREAKING CHANGE(S)`
  }]`
  const lines = [header, '']
  lines.push(
    `  ${diff.tickrateBefore} Hz -> ${diff.tickrateAfter} Hz` +
      (diff.tickrateChanged ? '  (tickrate changed)' : ''),
  )
  lines.push(`  ${diff.unchanged} edge(s) unchanged`)
  lines.push('')
  if (diff.changes.length === 0) {
    lines.push('  no differences')
  } else {
    lines.push('  changes')
    for (const change of diff.changes) {
      const mark = change.breaking ? '!' : ' '
      lines.push(`    ${mark} ${pad(change.kind, 9)} ${change.subject}`)
      lines.push(`      ${change.reason}`)
    }
  }
  return lines.join('\n')
}

export function renderTableSummary(table: TransitionTable): string {
  const lines = [`table ${table.id}  (${table.tickrateHz} Hz, entry ${table.entry})`, '', '  states']
  for (const state of table.states) {
    lines.push(`    ${pad(state.name, 16)}${state.terminal ? 'terminal' : ''}`)
  }
  lines.push('')
  lines.push('  transitions')
  for (const rule of table.transitions) {
    const budget = `${rule.minTicks}..${rule.maxTicks ?? 'inf'}`
    lines.push(
      `    ${pad(rule.id, 18)}${pad(`${rule.source}->${rule.target}`, 28)}${pad(budget, 12)}` +
        `${rule.repeatable ? '' : 'once-only'}`,
    )
  }
  return lines.join('\n')
}

function format(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4)
}

function formatPpm(value: number | null): string {
  if (value === null) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value} ppm`
}

export const SEVERITY_LABELS = SEVERITY_LABEL
