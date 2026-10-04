import { NextResponse } from 'next/server'
import { budgetProfile, replay, tickrateStats } from '@/lib/engine'
import { CASES, findCase } from '@/lib/corpus'

export const dynamic = 'force-static'

export function generateStaticParams(): { id: string }[] {
  return CASES.map((entry) => ({ id: entry.id }))
}

/** One trace's full report. 404 for an unknown id, because that is what it is. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const entry = findCase(id)

  if (entry === undefined) {
    return NextResponse.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `no shipped case with id "${id}"`,
          available: CASES.map((item) => item.id),
        },
      },
      { status: 404 },
    )
  }

  return NextResponse.json(
    {
      case: { id: entry.id, title: entry.title, column: entry.column, summary: entry.summary },
      table: entry.table,
      trace: entry.trace,
      replay: replay(entry.table, entry.trace),
      tickrate: tickrateStats(entry.table, entry.trace),
      budgetProfile: budgetProfile(entry.table, entry.trace),
    },
    { headers: { 'cache-control': 'public, max-age=60' } },
  )
}
