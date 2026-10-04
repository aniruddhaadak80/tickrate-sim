import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReplayReport, TickrateStats } from '@tickratesim/core'
import { LATEST_VERSION, Store, TriageLedger, pendingMigrations } from './index.js'

const dirs: string[] = []

function store(): Store {
  const root = mkdtempSync(join(tmpdir(), 'triage-'))
  dirs.push(root)
  return new Store(join(root, 'ledger.db'))
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function report(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    traceId: 'clean-64hz',
    tableId: 'skirmish-64',
    ok: true,
    tickrateHz: 64,
    startTick: 0,
    endTick: 1920,
    startState: 'lobby',
    endState: 'ended',
    ticksElapsed: 1920,
    eventsObserved: 3,
    violations: [],
    firstViolation: null,
    timeline: [],
    coverage: { declared: 8, exercised: 5, ratio: 0.625, uncovered: ['pause_match'] },
    ...overrides,
  }
}

function stats(overrides: Partial<TickrateStats> = {}): TickrateStats {
  return {
    traceId: 'clean-64hz',
    tableId: 'skirmish-64',
    declaredHz: 64,
    tickBudgetMs: 15.625,
    effectiveHz: 64,
    driftPpm: 0,
    driftRatio: 1,
    samples: 30,
    minHz: 64,
    medianHz: 64,
    maxHz: 64,
    jitterHz: 0,
    jitterPpm: 0,
    verdict: 'on_rate',
    note: 'on rate',
    ...overrides,
  }
}

const failure = report({
  traceId: 'rollback-storm',
  ok: false,
  violations: [
    {
      code: 'BUDGET_OVERRUN',
      tick: 331,
      state: 'resimulating',
      target: 'live',
      rule: 'finish_resim',
      ticksInState: 31,
      message: 'over budget',
    },
  ],
  firstViolation: {
    code: 'BUDGET_OVERRUN',
    tick: 331,
    state: 'resimulating',
    target: 'live',
    rule: 'finish_resim',
    ticksInState: 31,
    message: 'over budget',
  },
})

describe('migrations', () => {
  it('migrates an empty database to the latest version', () => {
    const db = store()
    expect(db.version).toBe(LATEST_VERSION)
    expect(db.isPending).toBe(false)
    db.close()
  })

  it('is idempotent when run twice', () => {
    const db = store()
    const first = db.version
    db.migrate()
    db.migrate()
    expect(db.version).toBe(first)
    expect(pendingMigrations(db.version)).toHaveLength(0)
    db.close()
  })
})

describe('triage ledger', () => {
  it('records a legal run', () => {
    const ledger = new TriageLedger(store())
    const entry = ledger.record(report(), stats(), 1_000)
    expect(entry.verdict).toBe('legal')
    expect(entry.violations).toBe(0)
    expect(entry.firstCode).toBeNull()
    expect(ledger.summary()).toMatchObject({ runs: 1, clean: 1, failing: 0 })
    ledger.close()
  })

  it('records the first violation, which is the useful one', () => {
    const ledger = new TriageLedger(store())
    ledger.record(failure, stats({ driftPpm: -93_730, verdict: 'drifting' }), 2_000)
    const latest = ledger.latest('rollback-storm', 'skirmish-64')
    expect(latest?.firstCode).toBe('BUDGET_OVERRUN')
    expect(latest?.firstTick).toBe(331)
    expect(latest?.driftPpm).toBe(-93_730)
    ledger.close()
  })

  it('answers when a trace started failing', () => {
    const ledger = new TriageLedger(store())
    ledger.record(report(), stats(), 1_000)
    ledger.record(failure, stats(), 2_000)
    ledger.record(failure, stats(), 3_000)
    const first = ledger.firstFailure('rollback-storm')
    expect(first?.recordedAt).toBe(2_000)
    ledger.close()
  })

  it('reports no first failure for a trace that never failed', () => {
    const ledger = new TriageLedger(store())
    ledger.record(report(), stats(), 1_000)
    expect(ledger.firstFailure('clean-64hz')).toBeUndefined()
    ledger.close()
  })

  it('keeps history newest first', () => {
    const ledger = new TriageLedger(store())
    ledger.record(report(), stats(), 1_000)
    ledger.record(failure, stats(), 2_000)
    ledger.record(report(), stats(), 3_000)
    expect(ledger.history('clean-64hz').map((entry) => entry.recordedAt)).toEqual([3_000, 1_000])
    ledger.close()
  })

  it('separates runs of the same trace against different tables', () => {
    const ledger = new TriageLedger(store())
    ledger.record(report(), stats(), 1_000)
    ledger.record(report({ tableId: 'skirmish-64-r2' }), stats(), 1_000)
    expect(ledger.latest('clean-64hz', 'skirmish-64')?.tableId).toBe('skirmish-64')
    expect(ledger.latest('clean-64hz', 'skirmish-64-r2')?.tableId).toBe('skirmish-64-r2')
    expect(ledger.summary().runs).toBe(2)
    ledger.close()
  })

  it('summarises an empty ledger without inventing zeros for the timestamps', () => {
    const ledger = new TriageLedger(store())
    expect(ledger.summary()).toEqual({
      runs: 0,
      clean: 0,
      failing: 0,
      firstSeen: null,
      lastSeen: null,
    })
    ledger.close()
  })

  it('still offers the generic key-value and full-text surface', () => {
    const db = store()
    db.put({ id: 'note-1', kind: 'note', payload: { body: 'rollback budget' }, now: 1 })
    expect(db.get('note-1')?.id).toBe('note-1')
    expect(db.search('rollback').length).toBe(1)
    expect(db.list('note')).toHaveLength(1)
    db.close()
  })
})
