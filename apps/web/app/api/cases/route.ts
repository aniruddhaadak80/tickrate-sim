import { NextResponse } from 'next/server'
import { budgetProfile, replay, tickrateStats } from '@/lib/engine'
import { CASES, COLUMNS, corpusSummary } from '@/lib/corpus'

export const dynamic = 'force-static'

/**
 * API-first: the board is a view over this, and anything else that wants the numbers should
 * read them here rather than re-deriving them.
 *
 * Reports are computed with the browser mirror, which the parity test proves byte-identical to
 * the Python engine on every shipped case. A consumer can therefore treat this as the engine's
 * output without spawning Python.
 */
export function GET() {
  const cases = CASES.map((entry) => ({
    id: entry.id,
    title: entry.title,
    column: entry.column,
    severity: entry.severity,
    summary: entry.summary,
    replay: replay(entry.table, entry.trace),
    tickrate: tickrateStats(entry.table, entry.trace),
    budgetProfile: budgetProfile(entry.table, entry.trace),
  }))

  return NextResponse.json(
    {
      columns: COLUMNS,
      summary: corpusSummary(),
      cases,
    },
    { headers: { 'cache-control': 'public, max-age=60' } },
  )
}
