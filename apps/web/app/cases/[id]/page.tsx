import Link from 'next/link'
import { notFound } from 'next/navigation'
import { budgetProfile, replay, tickrateStats } from '@/lib/engine'
import { CASES, findCase } from '@/lib/corpus'
import { Inspector } from '@/components/inspector'

export const dynamic = 'force-static'

export function generateStaticParams(): { id: string }[] {
  return CASES.map((entry) => ({ id: entry.id }))
}

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const entry = findCase(id)
  if (entry === undefined) notFound()

  const report = replay(entry.table, entry.trace)
  const stats = tickrateStats(entry.table, entry.trace)
  const budget = budgetProfile(entry.table, entry.trace)

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href="/">Board</Link>
        <span aria-hidden="true">/</span>
        <span className="mono">{entry.id}</span>
      </nav>

      <Inspector
        title={entry.title}
        summary={entry.summary}
        severity={entry.severity}
        report={report}
        stats={stats}
        budget={budget}
        table={entry.table}
      />

      <section aria-labelledby="timeline-heading" className="panel">
        <h2 id="timeline-heading">Tick timeline</h2>
        <table className="table">
          <caption className="sr-only">
            Every state the machine entered, with the ticks spent in the state before it changed
          </caption>
          <thead>
            <tr>
              <th scope="col">Tick</th>
              <th scope="col">State</th>
              <th scope="col">Spent</th>
              <th scope="col">Via rule</th>
              <th scope="col">Legal</th>
            </tr>
          </thead>
          <tbody>
            {report.timeline.map((step) => (
              <tr key={`${step.tick}-${step.state}`}>
                <td className="mono num">{step.tick}</td>
                <td className="mono">{step.state}</td>
                <td className="mono num">{step.ticksInState}</td>
                <td className="mono">{step.via ?? '-'}</td>
                <td className="mono">{step.legal ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="budget-heading" className="panel">
        <h2 id="budget-heading">Budget profile</h2>
        <table className="table">
          <caption className="sr-only">Declared tick budget against what this trace spent</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Edge</th>
              <th scope="col">Declared</th>
              <th scope="col">Observed</th>
              <th scope="col">Use</th>
              <th scope="col">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {budget.rows.map((row) => (
              <tr key={row.index}>
                <td className="mono">{row.rule}</td>
                <td className="mono">
                  {row.source} &rarr; {row.target}
                </td>
                <td className="mono num">
                  {row.declaredMin}..{row.declaredMax ?? 'inf'}
                </td>
                <td className="mono num">
                  {row.observedCount === 0
                    ? '-'
                    : `${row.observedMin}..${row.observedMax ?? '-'} (${row.observedCount}x)`}
                </td>
                <td className="mono num">
                  {row.utilisation === null ? '-' : `${Math.round(row.utilisation * 100)}%`}
                </td>
                <td className="mono" data-verdict={row.verdict}>
                  {row.verdict}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-labelledby="table-heading" className="panel">
        <h2 id="table-heading">Declared table</h2>
        <p className="panel-note">
          {entry.table.states.length} states, {entry.table.transitions.length} transitions,{' '}
          {entry.table.tickrateHz} Hz, entry <code>{entry.table.entry}</code>.
        </p>
        <table className="table">
          <caption className="sr-only">The transition table this trace was replayed against</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Edge</th>
              <th scope="col">Budget</th>
              <th scope="col">Once-only</th>
            </tr>
          </thead>
          <tbody>
            {entry.table.transitions.map((rule) => (
              <tr key={rule.id}>
                <td className="mono">{rule.id}</td>
                <td className="mono">
                  {rule.source} &rarr; {rule.target}
                </td>
                <td className="mono num">
                  {rule.minTicks}..{rule.maxTicks ?? 'inf'}
                </td>
                <td className="mono">{rule.repeatable ? 'no' : 'yes'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  )
}
