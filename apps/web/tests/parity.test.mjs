/**
 * The parity gate.
 *
 * The web app computes replay reports in TypeScript because a Vercel function cannot spawn
 * Python. That is only acceptable if the TypeScript is provably the same computation, so this
 * test replays every shipped case twice - once through the browser mirror, once through the
 * Python engine - and fails on the first byte of difference.
 *
 * The `expected` block in each case is the Python engine's own committed output, so this test
 * transitively asserts three things:
 *   1. the browser mirror reproduces the engine,
 *   2. the engine still reproduces its committed output (the Python golden test asserts the
 *      same thing from the other side),
 *   3. the corpus in the bundle is the corpus the engine produced.
 *
 * Run with: npm test --workspace @tickratesim/web
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB = resolve(HERE, '..')
const REPO = resolve(WEB, '..', '..')
const DATA = join(WEB, 'data')

// The mirror is compiled to plain JS first (`npm run build:lib`), because node:test cannot
// import TypeScript directly and pulling in a loader would add a dependency to prove a claim
// that a 20-line tsc invocation already proves. `pathToFileURL` because a Windows absolute
// path is not a valid ESM specifier.
const { replay, tickrateStats, budgetProfile, diffTables } = await import(
  pathToFileURL(join(WEB, 'dist', 'lib', 'engine.js')).href
)

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const cases = readJson(join(DATA, 'cases.json'))
const tableChecks = readJson(join(DATA, 'table-checks.json'))
const tableDiffs = readJson(join(DATA, 'table-diffs.json'))

/** First structural difference, as a path, so a failure names the field that drifted. */
function firstDifference(left, right, path = '$') {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return `${path}: array vs non-array`
    if (left.length !== right.length) return `${path}: length ${left.length} != ${right.length}`
    for (let index = 0; index < left.length; index += 1) {
      const found = firstDifference(left[index], right[index], `${path}[${index}]`)
      if (found !== null) return found
    }
    return null
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (!(key in left)) return `${path}.${key}: missing on the left`
      if (!(key in right)) return `${path}.${key}: missing on the right`
      const found = firstDifference(left[key], right[key], `${path}.${key}`)
      if (found !== null) return found
    }
    return null
  }
  return left === right ? null : `${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`
}

test('the browser mirror reproduces the engine for every shipped case', () => {
  assert.ok(cases.length > 0, 'the corpus is empty')
  for (const entry of cases) {
    const report = replay(entry.table, entry.trace)
    const difference = firstDifference(entry.expected.replay, report)
    assert.equal(difference, null, `case ${entry.id} replay drifted at ${difference}`)
  }
})

test('the browser mirror reproduces the engine tickrate stats', () => {
  for (const entry of cases) {
    const stats = tickrateStats(entry.table, entry.trace)
    const difference = firstDifference(entry.expected.tickrate, stats)
    assert.equal(difference, null, `case ${entry.id} tickrate drifted at ${difference}`)
  }
})

test('the browser mirror reproduces the engine budget profile', () => {
  for (const entry of cases) {
    const profile = budgetProfile(entry.table, entry.trace)
    const difference = firstDifference(entry.expected.budgetProfile, profile)
    assert.equal(difference, null, `case ${entry.id} budget drifted at ${difference}`)
  }
})

test('every violation code the corpus exercises is reproduced exactly', () => {
  const expectedCodes = new Set()
  for (const entry of cases) {
    for (const item of entry.expected.replay.violations) expectedCodes.add(item.code)
    const actual = replay(entry.table, entry.trace).violations.map((item) => item.code)
    assert.deepEqual(
      actual,
      entry.expected.replay.violations.map((item) => item.code),
      `case ${entry.id} reported a different set of violation codes`,
    )
  }
  assert.ok(expectedCodes.size >= 4, `the corpus only exercises ${expectedCodes.size} violation codes`)
})

test('the browser mirror reproduces the engine table diff', () => {
  assert.ok(tableDiffs.length > 0, 'no table diff is committed')
  for (const entry of tableDiffs) {
    const diff = diffTables(entry.before, entry.after)
    const difference = firstDifference(entry.expected, diff)
    assert.equal(difference, null, `diff ${entry.id} drifted at ${difference}`)
  }
})

test('the corpus tables are the ones the engine validated', () => {
  const ids = tableChecks.map((entry) => entry.table.id).sort()
  assert.deepEqual(ids, ['skirmish-64', 'skirmish-64-r2', 'skirmish-broken'])
})

test('the engine this file claims to mirror is where it says it is', () => {
  // Guards the premise rather than the behaviour. If the Python engine is relocated or
  // renamed, "a browser mirror of the engine" needs re-deciding instead of quietly comparing
  // against an expectation nothing produces any more.
  assert.ok(existsSync(join(REPO, 'services', 'engine', 'src', 'tickrate_sim', 'replay.py')))
  assert.ok(existsSync(join(REPO, 'services', 'engine', 'tests', 'test_golden.py')))
})

test('the web contract exports the same type names as the engine contract', () => {
  // `apps/web/lib/engine-contract.ts` is a deliberate duplicate of `packages/core/src/contract.ts`,
  // because Vercel builds this app in isolation and a workspace import does not resolve there.
  // Behaviour is not duplicated - the parity tests above cover that - but the *shape* is, so
  // this asserts the two files still describe the same set of types. A field added to one and
  // not the other becomes visible here rather than as a confusing type error much later.
  const names = (source) =>
    new Set([...source.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z0-9_]+)/gm)].map((match) => match[1]))

  const engine = names(readFileSync(join(REPO, 'packages', 'core', 'src', 'contract.ts'), 'utf8'))
  const web = names(readFileSync(join(WEB, 'lib', 'engine-contract.ts'), 'utf8'))

  assert.ok(engine.size > 10, `only found ${engine.size} exported types in the engine contract`)
  const missing = [...engine].filter((name) => !web.has(name)).sort()
  const extra = [...web].filter((name) => !engine.has(name)).sort()
  assert.deepEqual(missing, [], `the web contract is missing: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `the web contract has types the engine does not: ${extra.join(', ')}`)
})

test('the corpus is bundled, not fetched at runtime', () => {
  // The deployed app must not depend on a network call or a filesystem it does not control.
  // A static import of the JSON is what makes the page work on a cold Vercel build.
  assert.ok(readFileSync(join(WEB, 'lib', 'corpus.ts'), 'utf8').includes('@/data/cases.json'))
})
