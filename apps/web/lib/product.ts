import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TableValidation } from '@tickratesim/core'

/**
 * The product's identity and its surface manifest, in one typed place.
 *
 * Every surface is declared with a reason. A surface that is omitted says *why* here rather
 * than being quietly absent, because "no TUI" and "we forgot" look identical from a README and
 * only one of them is a design decision.
 */
export interface Surface {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly status: 'shipped' | 'omitted'
  /** Required for an omitted surface. Absent for a shipped one. */
  readonly reason?: string
}

export const PRODUCT = {
  name: 'Tickrate Sim',
  slug: 'tickrate-sim',
  version: '0.1.0',
  tagline:
    'Replay a recorded multiplayer tick trace against your declared netcode state machine, and get the first transition the table does not permit.',
  what: 'Declare your netcode states and tick budgets. Replay a recorded trace. See exactly which tick broke which rule, and by how much.',
} as const

export const SURFACES: readonly Surface[] = [
  {
    id: 'engine',
    title: 'Deterministic engine (Python)',
    summary:
      'Five pure functions over a transition table and a trace: validate, replay, measure, budget, diff. No clock, no network, no randomness, mypy --strict clean.',
    status: 'shipped',
  },
  {
    id: 'cli',
    title: 'CLI',
    summary:
      'validate, table, replay, stats, budget, diff, corpus, doctor, tools, mcp serve, mcp call. Every engine capability is reachable without a browser.',
    status: 'shipped',
  },
  {
    id: 'mcp',
    title: 'MCP server',
    summary:
      'Seven tools over stdio, all backed by the one core registry. An agent can validate a table and replay a trace without a shell.',
    status: 'shipped',
  },
  {
    id: 'web',
    title: 'Web workspace',
    summary:
      'A triage board over real recorded traces. Server-rendered first paint, and the replay is computed in the browser by a mirror the parity test proves equal to the engine.',
    status: 'shipped',
  },
  {
    id: 'skills',
    title: 'Skills catalog',
    summary: 'Markdown skills loaded from disk, frontmatter-validated, with a version-bump gate in CI.',
    status: 'shipped',
  },
  {
    id: 'plugins',
    title: 'Plugin registry',
    summary:
      'Manifest-driven extensions with priority-based conflict resolution and a stated reason for every rejection.',
    status: 'shipped',
  },
  {
    id: 'memory',
    title: 'Embedded store',
    summary:
      'SQLite via better-sqlite3, WAL, numbered idempotent migrations, FTS5. Used to persist triage state.',
    status: 'shipped',
  },
  {
    id: 'desktop',
    title: 'Desktop (Electron)',
    summary: 'An Electron shell would add a build matrix and a signing pipeline to deliver the same web app.',
    status: 'omitted',
    reason: 'The product is a document and a number. A desktop wrapper is strictly a worse way to read both.',
  },
  {
    id: 'channels',
    title: 'Channels',
    summary: 'A local tool plus a web app has no remote messaging surface to adapt.',
    status: 'omitted',
    reason: 'Channels exist to reach a user somewhere this product already reaches: a terminal.',
  },
  {
    id: 'providers',
    title: 'Model providers',
    summary: 'Nothing in the analysis path is a model call, which is the point of the analysis path.',
    status: 'omitted',
    reason:
      'Every number this product reports has to be exactly right. A model cannot be asked to add up ticks.',
  },
  {
    id: 'tui',
    title: 'TUI',
    summary: 'The CLI already prints the whole report; a full-screen interface would show less.',
    status: 'omitted',
    reason: 'A TUI would be a worse version of `tickrate-sim replay`.',
  },
]

export const SHIPPED = SURFACES.filter((surface) => surface.status === 'shipped')
export const OMITTED = SURFACES.filter((surface) => surface.status === 'omitted')

/** The engine's own operations, described once and read by both the CLI and the docs. */
export const OPERATIONS = [
  {
    op: 'validate_table',
    question: 'Is the declaration coherent?',
    detail: 'Unreachable states, dead ends, terminal states with exits, inverted budgets, doubled edges.',
  },
  {
    op: 'replay',
    question: 'Where did reality outgrow the declaration?',
    detail: 'Every undeclared or out-of-budget transition, the first one first, plus declared-edge coverage.',
  },
  {
    op: 'tickrate_stats',
    question: 'What rate did the server actually hit?',
    detail: 'Effective Hz, drift in parts per million, and inter-arrival jitter, from wall-clock anchors.',
  },
  {
    op: 'budget_profile',
    question: 'Which budgets are tight, and which are fiction?',
    detail: 'Declared bounds against observed tick counts, with a utilisation figure per rule.',
  },
  {
    op: 'diff_tables',
    question: 'Which change would make a passing trace fail?',
    detail:
      'Tightening a floor or capping an unbounded ceiling is breaking even with no edge added or removed.',
  },
] as const

function packageVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function resolveVersion(): string {
  return packageVersion()
}

export type { TableValidation }
