import { budgetProfile, replay, tickrateStats } from '@/lib/engine'
import { CASES, COLUMNS, corpusSummary } from '@/lib/corpus'
import { Board, type BoardEntry } from '@/components/board'
import { PRODUCT } from '@/lib/product'

/**
 * The board. Server-rendered: the replay, the rate and the budget of every shipped trace are
 * computed here, in this request, before a single byte of HTML is sent.
 *
 * The computation is the browser mirror of the Python engine, and `tests/parity.test.mjs`
 * proves it produces byte-identical reports to the engine on every shipped case. So the page
 * is genuinely computing the product rather than displaying a recording of it - which is the
 * only way a deployed page can demonstrate a tool that needs a subprocess it cannot have.
 */
export const dynamic = 'force-static'

export default function BoardPage() {
  const entries: BoardEntry[] = CASES.map((entry) => ({
    id: entry.id,
    title: entry.title,
    column: entry.column,
    severity: entry.severity,
    summary: entry.summary,
    table: entry.table,
    report: replay(entry.table, entry.trace),
    stats: tickrateStats(entry.table, entry.trace),
    budget: budgetProfile(entry.table, entry.trace),
  }))

  const summary = corpusSummary()
  // The default selection is the worst thing on the board, so a reader who never clicks
  // anything still lands on the finding that matters most.
  const selectedId =
    entries.find((entry) => entry.column === 'blocking' && entry.severity === 'critical')?.id ??
    entries[0]?.id ??
    ''

  return (
    <>
      <section className="lede">
        <p className="lede-what">{PRODUCT.what}</p>
        <dl className="lede-figures">
          <div>
            <dt>Traces</dt>
            <dd className="mono">{summary.cases}</dd>
          </div>
          <div>
            <dt>Blocking</dt>
            <dd className="mono">{summary.blocking}</dd>
          </div>
          <div>
            <dt>Tables</dt>
            <dd className="mono">{summary.tables}</dd>
          </div>
          <div>
            <dt>Clean</dt>
            <dd className="mono">{summary.clean}</dd>
          </div>
        </dl>
      </section>

      <Board columns={COLUMNS} entries={entries} selectedId={selectedId} />
    </>
  )
}
