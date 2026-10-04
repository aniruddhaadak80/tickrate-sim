import { NextResponse } from 'next/server'
import { CASES, corpusSummary } from '@/lib/corpus'
import { PRODUCT, resolveVersion } from '@/lib/product'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Status = 'ok' | 'warn' | 'fail'
interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

const startedAt = Date.now()

/**
 * A health endpoint that reports only things it can actually observe at runtime.
 *
 * Every row here is computed from the running process and the corpus it is serving. There is no
 * probe for the Python engine here, because a Vercel function cannot spawn one - and reporting
 * an engine row it did not run is exactly the kind of lie this endpoint exists to avoid. The
 * engine's own reachability is checked by `tickrate-sim doctor`, in the CLI, where it can
 * actually spawn it.
 */
function probe(): { ok: boolean; checks: Check[] } {
  const checks: Check[] = []

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0')
  checks.push(
    nodeMajor >= 22
      ? { name: 'runtime', status: 'ok', detail: `node ${process.versions.node}` }
      : {
          name: 'runtime',
          status: 'fail',
          detail: `node ${process.versions.node} is below the required v22.12.0`,
          fix: 'target Node 22 in the deployment runtime',
        },
  )

  const summary = corpusSummary()
  checks.push({
    name: 'corpus',
    status: summary.cases > 0 ? 'ok' : 'fail',
    detail: `${summary.cases} traces, ${summary.tables} tables, ${summary.blocking} blocking`,
    ...(summary.cases > 0 ? {} : { fix: 'run python services/engine/scripts/sync_cases.py' }),
  })

  const malformed = CASES.filter(
    (entry) => entry.table.states.length === 0 || entry.trace.events.length === 0,
  ).length
  checks.push(
    malformed === 0
      ? { name: 'cases', status: 'ok', detail: `${CASES.length - malformed}/${CASES.length} well-formed` }
      : {
          name: 'cases',
          status: 'fail',
          detail: `${malformed} case(s) have no states or no events`,
          fix: 'regenerate the corpus with sync_cases.py',
        },
  )

  const region = process.env.VERCEL_REGION ?? 'local'
  checks.push({ name: 'region', status: 'ok', detail: region })

  checks.push({
    name: 'engine',
    status: 'warn',
    detail: 'not probeable from a serverless function; the browser mirror is verified by CI',
    fix: 'run "tickrate-sim doctor" locally to probe the Python engine',
  })

  return { ok: checks.every((check) => check.status !== 'fail'), checks }
}

export function GET() {
  const { ok, checks } = probe()
  return NextResponse.json(
    {
      ok,
      name: PRODUCT.slug,
      version: resolveVersion(),
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
      runtime: process.versions.node,
      region: process.env.VERCEL_REGION ?? 'local',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      checks,
    },
    { status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  )
}
