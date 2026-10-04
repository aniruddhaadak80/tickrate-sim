import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalog } from '@tickratesim/skills'
import { buildRegistry as buildPluginRegistry } from '@tickratesim/plugins'
import { ENGINE_MODULE } from './bootstrap.js'

export type Status = 'ok' | 'warn' | 'fail'

export interface Check {
  readonly name: string
  readonly status: Status
  readonly detail: string
  readonly fix?: string
}

export interface DoctorReport {
  readonly ok: boolean
  readonly checks: readonly Check[]
}

const pkg = { name: 'tickrate-sim', version: '0.1.0' }

/**
 * The flagship command. An agent that mutates its own configuration must be able to diagnose
 * itself, and every failing row carries a fix hint rather than only a status.
 *
 * `probeEngine` is injectable because it is the only row that leaves the process. That keeps
 * the unit test hermetic - no Python required to test the reporting - while the real spawn is
 * still exercised every time a user runs the command, and by `packages/mcp/scripts/probe-stdio.mjs`.
 */
export type EngineProbe = (cwd: string) => Promise<Check>

export async function doctor(
  cwd = process.cwd(),
  probeEngine: EngineProbe = spawnEngineProbe,
): Promise<DoctorReport> {
  const checks: Check[] = []

  checks.push(nodeCheck())
  checks.push({ name: 'package', status: 'ok', detail: `${pkg.name}@${pkg.version}` })

  const skills = loadCatalog(join(cwd, 'skills'))
  checks.push(
    skills.issues.length === 0
      ? { name: 'skills', status: 'ok', detail: `${skills.skills.length} skills, 0 invalid` }
      : {
          name: 'skills',
          status: 'fail',
          detail: `${skills.skills.length} valid, ${skills.issues.length} invalid`,
          fix: skills.issues[0] ?? 'see npm run check:skill-version',
        },
  )

  const plugins = buildPluginRegistry(join(cwd, 'plugins'))
  checks.push(
    plugins.rejected.length === 0
      ? {
          name: 'plugins',
          status: 'ok',
          detail: `${plugins.active.length} active, ${plugins.disabled.length} disabled`,
        }
      : {
          name: 'plugins',
          status: 'warn',
          detail: `${plugins.rejected.length} rejected`,
          fix: plugins.rejected[0]?.issues[0] ?? 'inspect plugins/*/plugin.json',
        },
  )

  checks.push(configCheck(cwd))
  checks.push(await probeEngine(cwd))
  checks.push(corpusCheck(cwd))

  return { ok: checks.every((check) => check.status !== 'fail'), checks }
}

function nodeCheck(): Check {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  return nodeMajor >= 22
    ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : {
        name: 'node',
        status: 'fail',
        detail: `v${process.versions.node} is below the required v22.12.0`,
        fix: 'install Node 22.12 or newer (see .nvmrc)',
      }
}

function configCheck(cwd: string): Check {
  const configPath = join(cwd, 'product.config.json')
  return existsSync(configPath)
    ? { name: 'config', status: 'ok', detail: 'product.config.json found' }
    : {
        name: 'config',
        status: 'warn',
        detail: 'no product.config.json - using defaults',
        fix: 'run with defaults, or create product.config.json',
      }
}

/**
 * Spawn the engine and ask it something whose answer is known. `validate_table` on a
 * one-state table returns a specific document, so a success here proves the process started,
 * the JSON round-tripped, and the op is wired - which is what a user is actually asking. A
 * doctor that reported "engine ok" without having run the engine would be worse than none.
 */
export async function spawnEngineProbe(cwd: string): Promise<Check> {
  const { EngineBridge } = await import('@tickratesim/engine-client')
  try {
    const bridge = new EngineBridge({
      module: ENGINE_MODULE,
      cwd: join(cwd, 'services', 'engine', 'src'),
      timeoutMs: 15_000,
    })
    const result = await bridge.call<{ tableId: string; states: number }>({
      op: 'validate_table',
      input: {
        table: {
          id: 'doctor-probe',
          tickrateHz: 64,
          entry: 'idle',
          states: [{ name: 'idle' }],
          transitions: [],
        },
      },
    })
    return {
      name: 'engine',
      status: 'ok',
      detail: `${ENGINE_MODULE} answered: table "${result.tableId}", ${result.states} state(s)`,
    }
  } catch (cause) {
    return {
      name: 'engine',
      status: 'fail',
      detail: `could not run the Python engine: ${cause instanceof Error ? cause.message : String(cause)}`,
      fix: 'check that python 3.11+ is on PATH, then run "python -m pytest services/engine"',
    }
  }
}

/**
 * The shipped corpus is what the web app renders and what the README quotes. If it has gone
 * missing, the deployment is showing an empty product, so this is worth its own row.
 */
function corpusCheck(cwd: string): Check {
  const dataDir = join(cwd, 'apps', 'web', 'data')
  const required = ['tables.json', 'cases.json', 'table-diffs.json', 'table-checks.json']
  const missing = required.filter((file) => !existsSync(join(dataDir, file)))
  return missing.length === 0
    ? { name: 'corpus', status: 'ok', detail: `${required.length} corpus files present` }
    : {
        name: 'corpus',
        status: 'fail',
        detail: `missing: ${missing.join(', ')}`,
        fix: 'run "python services/engine/scripts/sync_cases.py"',
      }
}

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((check) => check.name.length), 5)
  const icon = (status: Status): string => (status === 'ok' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL')
  const lines = report.checks.map((check) => {
    const head = `  [${icon(check.status)}] ${check.name.padEnd(width)}  ${check.detail}`
    return check.fix === undefined ? head : `${head}\n         fix: ${check.fix}`
  })
  return [
    `${pkg.name} doctor`,
    ...lines,
    '',
    report.ok ? 'all required checks passed' : 'one or more checks failed',
  ].join('\n')
}
