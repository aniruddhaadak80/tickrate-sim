import Link from 'next/link'
import { CASES } from '@/lib/corpus'
import { PRODUCT, resolveVersion } from '@/lib/product'

export const dynamic = 'force-static'

/**
 * The health page runs the same probe the JSON endpoint does, in-process.
 *
 * It does not fetch `/api/health` over the network to render itself: a self-fetch on a cold
 * serverless start is a second thing that can fail, and this page exists to answer "is this
 * deployment healthy". One implementation, two renderings.
 */
type Status = 'ok' | 'warn' | 'fail'

interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

function probe(): Check[] {
  const summary = {
    cases: CASES.length,
    tables: new Set(CASES.map((entry) => entry.table.id)).size,
    blocking: CASES.filter((entry) => entry.column === 'blocking').length,
  }
  const malformed = CASES.filter(
    (entry) => entry.table.states.length === 0 || entry.trace.events.length === 0,
  ).length

  return [
    {
      name: 'runtime',
      status: 'ok',
      detail: `node ${process.versions.node}, ${process.env.VERCEL_REGION ?? 'local'}`,
    },
    {
      name: 'package',
      status: 'ok',
      detail: `${PRODUCT.slug}@${resolveVersion()} (${process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'})`,
    },
    {
      name: 'corpus',
      status: summary.cases > 0 ? 'ok' : 'fail',
      detail: `${summary.cases} traces, ${summary.tables} tables, ${summary.blocking} blocking`,
      ...(summary.cases > 0 ? {} : { fix: 'run python services/engine/scripts/sync_cases.py' }),
    },
    {
      name: 'cases',
      status: malformed === 0 ? 'ok' : 'fail',
      detail: `${CASES.length - malformed}/${CASES.length} traces have states and events`,
      ...(malformed === 0 ? {} : { fix: 'regenerate the corpus with sync_cases.py' }),
    },
    {
      name: 'engine',
      status: 'warn',
      detail: 'not probeable from a serverless function; the browser mirror is verified in CI',
      fix: 'run "tickrate-sim doctor" locally to probe the Python engine',
    },
  ]
}

export default function HealthPage() {
  const checks = probe()
  const failing = checks.filter((check) => check.status === 'fail').length

  return (
    <>
      <section className="lede">
        <p className="lede-what">
          What this deployment can observe about itself right now. Every row is computed in this request -
          nothing here is asserted without being checked.
        </p>
        <p>
          The machine-readable form is <code>GET /api/health</code>.
        </p>
      </section>

      <table className="table">
        <caption className="sr-only">Health checks for this deployment</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Status</th>
            <th scope="col">Detail</th>
            <th scope="col">Fix</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check) => (
            <tr key={check.name}>
              <td className="mono">{check.name}</td>
              <td>
                <span className="badge" data-tone={check.status === 'ok' ? 'clean' : 'major'}>
                  {check.status}
                </span>
              </td>
              <td>{check.detail}</td>
              <td>{check.fix ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        {failing === 0 ? (
          <Link href="/api/cases">Read the case data as JSON</Link>
        ) : (
          <span className="state" data-kind="error">
            {failing} check(s) failing. See the fix column.
          </span>
        )}
      </p>
    </>
  )
}
