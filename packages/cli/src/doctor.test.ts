import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doctor, renderReport, type Check, type EngineProbe } from './doctor.js'

const dirs: string[] = []

/**
 * A well-formed tree.
 *
 * The engine probe is stubbed rather than spawned: it is the only row that leaves the process,
 * and a unit test that required Python to assert on table formatting would be a worse test. The
 * real spawn is still exercised by `npm run mcp:probe` and by anyone running the binary.
 */
const engineOk: EngineProbe = async () => ({
  name: 'engine',
  status: 'ok',
  detail: 'tickrate_sim answered: table "doctor-probe", 1 state(s)',
})

const engineBroken: EngineProbe = async () => ({
  name: 'engine',
  status: 'fail',
  detail: 'could not run the Python engine: spawn python ENOENT',
  fix: 'check that python 3.11+ is on PATH, then run "python -m pytest services/engine"',
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'doctor-'))
  dirs.push(root)
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true })
  writeFileSync(
    join(root, 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: A valid skill for the doctor test suite.\nmetadata:\n  version: 1.0.0\n---\nBody.\n',
    'utf8',
  )
  mkdirSync(join(root, 'plugins'), { recursive: true })
  mkdirSync(join(root, 'apps', 'web', 'data'), { recursive: true })
  for (const file of ['tables.json', 'cases.json', 'table-diffs.json', 'table-checks.json']) {
    writeFileSync(join(root, 'apps', 'web', 'data', file), '[]', 'utf8')
  }
  return root
}

function row(report: { checks: readonly Check[] }, name: string): Check | undefined {
  return report.checks.find((check) => check.name === name)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('doctor', () => {
  it('passes on a well-formed tree', async () => {
    const report = await doctor(repo(), engineOk)
    expect(report.ok).toBe(true)
    expect(row(report, 'skills')?.status).toBe('ok')
    expect(row(report, 'engine')?.status).toBe('ok')
    expect(row(report, 'corpus')?.status).toBe('ok')
  })

  it('fails and names a fix when a skill is invalid', async () => {
    const root = repo()
    mkdirSync(join(root, 'skills', 'broken'), { recursive: true })
    writeFileSync(join(root, 'skills', 'broken', 'SKILL.md'), 'no frontmatter', 'utf8')
    const report = await doctor(root, engineOk)
    expect(report.ok).toBe(false)
    expect(row(report, 'skills')?.status).toBe('fail')
    expect(row(report, 'skills')?.fix).toBeTruthy()
  })

  it('warns rather than fails when config is absent', async () => {
    const report = await doctor(repo(), engineOk)
    expect(row(report, 'config')?.status).toBe('warn')
    expect(report.ok).toBe(true)
  })

  it('fails with a fix hint when the engine cannot be reached', async () => {
    const report = await doctor(repo(), engineBroken)
    expect(report.ok).toBe(false)
    expect(row(report, 'engine')?.status).toBe('fail')
    expect(row(report, 'engine')?.fix).toContain('PATH')
  })

  it('fails and names the regeneration command when the corpus is missing', async () => {
    const root = repo()
    rmSync(join(root, 'apps', 'web', 'data', 'cases.json'))
    const report = await doctor(root, engineOk)
    expect(report.ok).toBe(false)
    expect(row(report, 'corpus')?.status).toBe('fail')
    expect(row(report, 'corpus')?.fix).toContain('sync_cases.py')
  })

  it('renders every check with a status token', async () => {
    const rendered = renderReport(await doctor(repo(), engineOk))
    expect(rendered).toMatch(/doctor/)
    expect(rendered).toMatch(/[PASS]/)
    expect(rendered).toMatch(/[WARN]/)
  })

  it('prints the fix line under the failing row', async () => {
    const rendered = renderReport(await doctor(repo(), engineBroken))
    expect(rendered).toMatch(/fix: check that python/)
  })
})
