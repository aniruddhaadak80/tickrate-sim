import type { TableDiff, TableValidation, TickTrace, TransitionTable } from '@tickratesim/core'
import casesJson from '@/data/cases.json'
import tablesJson from '@/data/tables.json'
import diffsJson from '@/data/table-diffs.json'
import checksJson from '@/data/table-checks.json'

/**
 * The corpus, statically imported.
 *
 * A static import rather than a runtime `readFileSync` or `fetch` because that is the only
 * shape that is guaranteed to be in a Vercel serverless bundle. The deployed page therefore
 * carries its own data and needs no writable filesystem, no network, and no cold-start
 * dependency - which is what makes the live deployment actually demonstrate the product.
 */

export type BoardColumn = 'captured' | 'replayed' | 'blocking'
export type Severity = 'clean' | 'minor' | 'major' | 'critical'

export interface ShippedCase {
  readonly id: string
  readonly title: string
  readonly column: BoardColumn
  readonly severity: Severity
  readonly summary: string
  readonly table: TransitionTable
  readonly trace: TickTrace
}

export interface ShippedDiff {
  readonly id: string
  readonly title: string
  readonly before: TransitionTable
  readonly after: TransitionTable
}

export interface ShippedCheck {
  readonly id: string
  readonly title: string
  readonly table: TransitionTable
}

/**
 * The `expected` blocks in the corpus are the Python engine's output and are deliberately
 * dropped here. The page computes its own report with the browser mirror, and the parity test
 * is what makes that honest - so showing stored output would be the one version of this page
 * that is not actually computing anything.
 */
interface RawCase {
  readonly id: string
  readonly title: string
  readonly column: BoardColumn
  readonly severity: Severity
  readonly summary: string
  readonly table: TransitionTable
  readonly trace: TickTrace
}

export const CASES: readonly ShippedCase[] = (casesJson as unknown as readonly RawCase[]).map((entry) => ({
  id: entry.id,
  title: entry.title,
  column: entry.column,
  severity: entry.severity,
  summary: entry.summary,
  table: entry.table,
  trace: entry.trace,
}))

export const TABLES: readonly TransitionTable[] = tablesJson as unknown as readonly TransitionTable[]
export const DIFFS: readonly ShippedDiff[] = diffsJson as unknown as readonly ShippedDiff[]
export const CHECKS: readonly ShippedCheck[] = checksJson as unknown as readonly ShippedCheck[]
export const ENGINE_TABLE_CHECKS: readonly TableValidation[] =
  checksJson as unknown as readonly TableValidation[]
export const ENGINE_DIFFS: readonly TableDiff[] = diffsJson as unknown as readonly TableDiff[]

/** The board's workflow order. Left to right is how a case moves through triage. */
export const COLUMNS: readonly {
  readonly id: BoardColumn
  readonly label: string
  readonly blurb: string
}[] = [
  {
    id: 'captured',
    label: 'Captured',
    blurb: 'Trace recorded. Rate not yet judged, so a slow server can look clean here.',
  },
  {
    id: 'replayed',
    label: 'Replayed',
    blurb: 'Replayed with no violation. Every observed edge is declared and every budget held.',
  },
  {
    id: 'blocking',
    label: 'Blocking',
    blurb: 'Replayed with at least one violation. Each one names its tick, its rule and its budget.',
  },
]

export function casesInColumn(column: BoardColumn): readonly ShippedCase[] {
  return CASES.filter((entry) => entry.column === column)
}

export function findCase(id: string): ShippedCase | undefined {
  return CASES.find((entry) => entry.id === id)
}

export function corpusSummary(): {
  readonly cases: number
  readonly tables: number
  readonly blocking: number
  readonly clean: number
} {
  return {
    cases: CASES.length,
    tables: TABLES.length,
    blocking: CASES.filter((entry) => entry.column === 'blocking').length,
    clean: CASES.filter((entry) => entry.severity === 'clean').length,
  }
}
