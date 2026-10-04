import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BudgetProfile,
  ReplayReport,
  TableDiff,
  TableValidation,
  TickrateStats,
  TickTrace,
  TransitionTable,
} from '@tickratesim/core'

/**
 * The shipped corpus, read from `apps/web/web/data`.
 *
 * The same four files are the web app's product data, the Python golden fixture, and the CLI's
 * built-in examples. One corpus, three consumers: a scenario that the web page shows and the
 * terminal can replay is the same scenario, because it is the same bytes.
 *
 * The expected blocks are *not* used here. The CLI always calls the engine, so running a case
 * is a real replay rather than a replay of a recording. That is the difference between a demo
 * and a tool, and it is why the committed expectations are only ever compared against, never
 * returned.
 */
export interface Case {
  readonly id: string
  readonly title: string
  /** Which board column this case belongs in: the captured / replayed / blocking workflow. */
  readonly column: 'captured' | 'replayed' | 'blocking'
  readonly severity: 'clean' | 'minor' | 'major' | 'critical'
  readonly summary: string
  readonly table: TransitionTable
  readonly trace: TickTrace
  readonly expected: {
    readonly replay: ReplayReport
    readonly budgetProfile: BudgetProfile
    readonly tickrate: TickrateStats
  }
}

export interface TableDiffCase {
  readonly id: string
  readonly title: string
  readonly before: TransitionTable
  readonly after: TransitionTable
  readonly expected: TableDiff
}

export interface TableCheck {
  readonly id: string
  readonly title: string
  readonly table: TransitionTable
  readonly expected: TableValidation
}

export interface Corpus {
  readonly tables: readonly TransitionTable[]
  readonly cases: readonly Case[]
  readonly diffs: readonly TableDiffCase[]
  readonly checks: readonly TableCheck[]
}

export function dataDir(cwd = process.cwd()): string {
  return join(cwd, 'apps', 'web', 'data')
}

function read<T>(cwd: string, file: string): T {
  return JSON.parse(readFileSync(join(dataDir(cwd), file), 'utf8')) as T
}

export function loadCorpus(cwd = process.cwd()): Corpus {
  return {
    tables: read<TransitionTable[]>(cwd, 'tables.json'),
    cases: read<Case[]>(cwd, 'cases.json'),
    diffs: read<TableDiffCase[]>(cwd, 'table-diffs.json'),
    checks: read<TableCheck[]>(cwd, 'table-checks.json'),
  }
}

export function findCase(corpus: Corpus, id: string): Case | undefined {
  return corpus.cases.find((entry) => entry.id === id)
}

/**
 * Read a JSON document from disk.
 *
 * A leading BOM is stripped because every JSON parser rejects one and Windows editors write
 * one by default. A tool whose input has to be hand-edited by the person debugging a desync
 * cannot be fussy about an invisible byte order mark.
 */
export function parseJsonFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf8')
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T
}

/**
 * One line per case: enough to choose a case without running any of them.
 *
 * The verdict column is read from the case's own `column`, not from the expected replay, so
 * this list describes the board rather than re-deriving the answer.
 */
export function renderCaseList(corpus: Corpus): string {
  const rows = corpus.cases.map((entry) => [entry.id, entry.column, entry.severity, entry.title])
  const headers = ['CASE', 'BOARD', 'SEVERITY', 'TITLE']
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd()

  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n')
}
