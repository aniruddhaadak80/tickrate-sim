import type { ReplayReport, TickrateStats } from '@tickratesim/core'
import type { Store } from './store.js'

/**
 * The triage ledger: what the engine said about a trace, and when.
 *
 * This is what the store is for in this product. A single replay tells you a trace is broken;
 * a ledger tells you it started breaking after revision `skirmish-64-r2`, which is the question
 * you actually have after an incident.
 *
 * Verdicts are written as reported and never recomputed on read. A ledger that recalculates
 * history would silently rewrite the past every time the engine changed, which would make it
 * useless for the one thing it is kept for.
 */
/**
 * Columns are aliased explicitly at every read. The schema is snake_case because that is SQL's
 * convention; the row type is camelCase because that is this codebase's. Without the aliases
 * the mismatch is silent - every field simply reads as `undefined`.
 */
const SELECT_COLUMNS = `trace_id AS traceId,
  table_id AS tableId,
  verdict,
  violations,
  first_code AS firstCode,
  first_tick AS firstTick,
  coverage,
  drift_ppm AS driftPpm,
  recorded_at AS recordedAt`

export interface TriageEntry {
  readonly traceId: string
  readonly tableId: string
  readonly verdict: 'legal' | 'violating'
  readonly violations: number
  readonly firstCode: string | null
  readonly firstTick: number | null
  readonly coverage: number
  readonly driftPpm: number | null
  readonly recordedAt: number
}

export interface TriageSummary {
  readonly runs: number
  readonly failing: number
  readonly clean: number
  readonly firstSeen: number | null
  readonly lastSeen: number | null
}

/** Fold two engine reports into the row to write. The store never sees a replay document. */
export function toEntry(report: ReplayReport, stats: TickrateStats, recordedAt: number): TriageEntry {
  const first = report.firstViolation
  return {
    traceId: report.traceId,
    tableId: report.tableId,
    verdict: report.ok ? 'legal' : 'violating',
    violations: report.violations.length,
    firstCode: first?.code ?? null,
    firstTick: first?.tick ?? null,
    coverage: report.coverage.ratio,
    driftPpm: stats.driftPpm,
    recordedAt,
  }
}

export class TriageLedger {
  readonly #store: Store

  constructor(store: Store) {
    this.#store = store
  }

  get store(): Store {
    return this.#store
  }

  record(report: ReplayReport, stats: TickrateStats, recordedAt: number): TriageEntry {
    const entry = toEntry(report, stats, recordedAt)
    this.#store.transaction(() => {
      this.#store
        .prepare(
          `INSERT INTO triage
             (trace_id, table_id, verdict, violations, first_code, first_tick, coverage, drift_ppm, recorded_at)
           VALUES (@traceId, @tableId, @verdict, @violations, @firstCode, @firstTick, @coverage, @driftPpm, @recordedAt)`,
        )
        .run(entry)
    })
    return entry
  }

  /** Every run of one trace, newest first. */
  history(traceId: string, limit = 50): readonly TriageEntry[] {
    return this.#store
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM triage
         WHERE trace_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT ?`,
      )
      .all(traceId, limit) as unknown as readonly TriageEntry[]
  }

  /** The most recent verdict for one trace against one table, or undefined if never judged. */
  latest(traceId: string, tableId: string): TriageEntry | undefined {
    return this.#store
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM triage
         WHERE trace_id = ? AND table_id = ?
         ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
      )
      .get(traceId, tableId) as unknown as TriageEntry | undefined
  }

  /**
   * The first run at which this trace was failing, or undefined when it never failed.
   *
   * "When did this break" is the question a ledger exists to answer, so it is a query rather
   * than something a caller reconstructs from `history()`.
   */
  firstFailure(traceId: string): TriageEntry | undefined {
    return this.#store
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM triage
         WHERE trace_id = ? AND verdict = 'violating'
         ORDER BY recorded_at ASC, rowid ASC LIMIT 1`,
      )
      .get(traceId) as unknown as TriageEntry | undefined
  }

  summary(): TriageSummary {
    const row = this.#store
      .prepare(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN verdict = 'violating' THEN 1 ELSE 0 END) AS failing,
                SUM(CASE WHEN verdict = 'legal' THEN 1 ELSE 0 END) AS clean,
                MIN(recorded_at) AS firstSeen,
                MAX(recorded_at) AS lastSeen
           FROM triage`,
      )
      .get() as {
      runs: number
      failing: number | null
      clean: number | null
      firstSeen: number | null
      lastSeen: number | null
    }

    return {
      runs: row.runs,
      failing: row.failing ?? 0,
      clean: row.clean ?? 0,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    }
  }

  close(): void {
    this.#store.close()
  }
}
