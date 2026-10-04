import type { BudgetProfile, ReplayReport, TickrateStats } from '@/lib/engine-contract'
import { TickRuler } from './tick-ruler'

/**
 * The inspector: everything the engine said about one trace.
 *
 * Presentational and framework-free on purpose. It renders the same reports identically in the
 * board's side panel and on a case's own page, so the two can never drift into showing
 * different numbers for the same trace.
 */

export interface InspectorProps {
  readonly title: string
  readonly summary: string
  readonly severity: 'clean' | 'minor' | 'major' | 'critical'
  readonly report: ReplayReport
  readonly stats: TickrateStats
  readonly budget: BudgetProfile
  readonly table: Parameters<typeof TickRuler>[0]['table']
  /** Set when the inspector is a preview with a link to the full page. */
  readonly href?: string
}

function ppm(value: number | null): string {
  if (value === null) return 'n/a'
  return `${value > 0 ? '+' : ''}${value} ppm`
}

function hz(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(4)} Hz`
}

export function Inspector({ title, summary, severity, report, stats, budget, table, href }: InspectorProps) {
  const first = report.firstViolation

  return (
    <section className="inspector" aria-label={`Inspector: ${title}`}>
      <header className="inspector-head">
        <span className="badge" data-tone={severity}>
          {severity}
        </span>
        <h2>{title}</h2>
        <p className="inspector-summary">{summary}</p>
      </header>

      <TickRuler table={table} report={report} />

      <div className="verdict" data-ok={report.ok}>
        {report.ok ? (
          <p>
            <strong>Legal.</strong> Every observed transition is declared and every tick budget held.
          </p>
        ) : (
          <>
            <p>
              <strong>
                {report.violations.length} violation{report.violations.length === 1 ? '' : 's'}.
              </strong>{' '}
              First at tick <span className="mono">{first?.tick}</span>:{' '}
              <span className="mono accent">{first?.code}</span>
            </p>
            <p className="inspector-message">{first?.message}</p>
          </>
        )}
      </div>

      <dl className="stats">
        <div>
          <dt>Trace</dt>
          <dd className="mono">{report.traceId}</dd>
        </div>
        <div>
          <dt>Walk</dt>
          <dd className="mono">
            {report.startState} &rarr; {report.endState}
          </dd>
        </div>
        <div>
          <dt>Declared</dt>
          <dd className="mono">{report.tickrateHz} Hz</dd>
        </div>
        <div>
          <dt>Effective</dt>
          <dd className="mono" data-drift={stats.verdict === 'on_rate' ? undefined : 'bad'}>
            {hz(stats.effectiveHz)}
          </dd>
        </div>
        <div>
          <dt>Drift</dt>
          <dd className="mono" data-drift={stats.verdict === 'on_rate' ? undefined : 'bad'}>
            {ppm(stats.driftPpm)}
          </dd>
        </div>
        <div>
          <dt>Jitter</dt>
          <dd className="mono" data-drift={stats.jitterHz === 0 ? undefined : 'bad'}>
            {hz(stats.jitterHz)}
          </dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd className="mono">
            {report.coverage.exercised}/{report.coverage.declared} edges
          </dd>
        </div>
        <div>
          <dt>Budgets</dt>
          <dd className="mono">
            {budget.overruns} over / {budget.underruns} under / {budget.unused} unused
          </dd>
        </div>
      </dl>

      {report.coverage.uncovered.length > 0 && (
        <div className="notice" data-kind="info">
          <strong>Never exercised.</strong>{' '}
          {report.coverage.uncovered.map((rule) => (
            <code key={rule}>{rule}</code>
          ))}
        </div>
      )}

      {report.violations.length > 0 && (
        <table className="table">
          <caption className="sr-only">Every violation the walk found, in tick order</caption>
          <thead>
            <tr>
              <th scope="col">Tick</th>
              <th scope="col">Code</th>
              <th scope="col">Edge</th>
              <th scope="col">Rule</th>
            </tr>
          </thead>
          <tbody>
            {report.violations.map((violation) => (
              <tr key={`${violation.tick}-${violation.code}`}>
                <td className="mono num">{violation.tick}</td>
                <td className="mono accent">{violation.code}</td>
                <td className="mono">
                  {violation.state} &rarr; {violation.target}
                </td>
                <td className="mono">{violation.rule ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {href !== undefined && (
        <p className="inspector-more">
          <a href={href}>Open the full report for this trace</a>
        </p>
      )}
    </section>
  )
}
