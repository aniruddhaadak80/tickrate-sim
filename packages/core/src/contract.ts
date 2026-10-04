/**
 * The TypeScript mirror of the engine's I/O contract.
 *
 * These types exist so the CLI, the MCP server and the web app all describe a table and a
 * trace the same way. They are hand-mirrored from `services/engine/src/tickrate_sim/model.py`
 * on purpose: the engine has zero runtime dependencies, so a code generator would need one,
 * and a contract test keeps the two honest instead.
 *
 * The parity gate is `apps/web/tests/parity.test.mjs`, which replays every committed case
 * through both implementations and fails on any difference. If this file drifts from the
 * Python, that test fails rather than the product quietly lying.
 */

export interface StateSpec {
  readonly name: string
  readonly terminal: boolean
  readonly description?: string
}

export interface TransitionRule {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly minTicks: number
  /** `null` means unbounded: the state may persist indefinitely. */
  readonly maxTicks: number | null
  readonly repeatable: boolean
  readonly guard?: string
}

export interface TransitionTable {
  readonly id: string
  readonly tickrateHz: number
  readonly entry: string
  readonly states: readonly StateSpec[]
  readonly transitions: readonly TransitionRule[]
}

export interface TraceEvent {
  readonly tick: number
  readonly target: string
  readonly note?: string
}

export interface Anchor {
  readonly tick: number
  readonly ms: number
}

export interface TickTrace {
  readonly id: string
  readonly tableId: string
  readonly startTick: number
  readonly endTick: number
  readonly events: readonly TraceEvent[]
  readonly anchors: readonly Anchor[]
}

// ------------------------------------------------------------------ reports

export type ViolationCode =
  | 'UNDECLARED_TRANSITION'
  | 'TERMINAL_EXIT'
  | 'UNKNOWN_STATE'
  | 'BUDGET_UNDERRUN'
  | 'BUDGET_OVERRUN'
  | 'NON_MONOTONIC_TICK'
  | 'EVENT_OUT_OF_RANGE'
  | 'REPEAT_TRANSITION'

export interface Violation {
  readonly code: ViolationCode
  readonly tick: number
  readonly state: string
  readonly target: string
  readonly rule: string | null
  readonly ticksInState: number
  readonly message: string
}

export interface TimelineStep {
  readonly tick: number
  readonly state: string
  readonly ticksInState: number
  readonly via: string | null
  readonly viaIndex: number | null
  readonly legal: boolean
}

export interface Coverage {
  readonly declared: number
  readonly exercised: number
  readonly ratio: number
  readonly uncovered: readonly string[]
}

export interface ReplayReport {
  readonly traceId: string
  readonly tableId: string
  readonly ok: boolean
  readonly tickrateHz: number
  readonly startTick: number
  readonly endTick: number
  readonly startState: string
  readonly endState: string
  readonly ticksElapsed: number
  readonly eventsObserved: number
  readonly violations: readonly Violation[]
  readonly firstViolation: Violation | null
  readonly timeline: readonly TimelineStep[]
  readonly coverage: Coverage
}

export interface TickrateStats {
  readonly traceId: string
  readonly tableId: string
  readonly declaredHz: number
  readonly tickBudgetMs: number
  readonly effectiveHz: number | null
  readonly driftPpm: number | null
  readonly driftRatio: number | null
  readonly samples: number
  readonly minHz: number | null
  readonly medianHz: number | null
  readonly maxHz: number | null
  readonly jitterHz: number | null
  readonly jitterPpm: number | null
  readonly verdict: 'on_rate' | 'drifting' | 'under_anchored'
  readonly note: string
}

export type BudgetVerdict = 'unused' | 'within_budget' | 'slower_than_declared' | 'faster_than_declared'

export interface BudgetRow {
  readonly rule: string
  readonly index: number
  readonly source: string
  readonly target: string
  readonly declaredMin: number
  readonly declaredMax: number | null
  readonly observedCount: number
  readonly observedMin: number | null
  readonly observedMax: number | null
  readonly utilisation: number | null
  readonly verdict: BudgetVerdict
}

export interface BudgetProfile {
  readonly traceId: string
  readonly tableId: string
  readonly rows: readonly BudgetRow[]
  readonly overruns: number
  readonly underruns: number
  readonly unused: number
}

export type TableIssueCode =
  | 'NO_STATES'
  | 'ENTRY_UNDECLARED'
  | 'DUPLICATE_STATE'
  | 'DUPLICATE_RULE_ID'
  | 'UNKNOWN_SOURCE'
  | 'UNKNOWN_TARGET'
  | 'NEGATIVE_BUDGET'
  | 'BUDGET_INVERTED'
  | 'AMBIGUOUS_EDGE'
  | 'UNREACHABLE_STATE'
  | 'DEAD_END'
  | 'TERMINAL_WITH_EXIT'

export interface TableIssue {
  readonly code: TableIssueCode
  readonly severity: 'error' | 'warn'
  readonly subject: string
  readonly message: string
}

export interface TableValidation {
  readonly tableId: string
  readonly ok: boolean
  readonly errors: number
  readonly warnings: number
  readonly states: number
  readonly transitions: number
  readonly entry: string
  readonly tickrateHz: number
  readonly issues: readonly TableIssue[]
  readonly unreachable: readonly string[]
  readonly deadEnds: readonly string[]
  readonly terminal: readonly string[]
  readonly conflictingRules: readonly string[]
}

export type TableChangeKind = 'added' | 'removed' | 'modified'

export interface TableChange {
  readonly kind: TableChangeKind
  /** `rule:<source>-><target> (<id>)` or `state:<name>`. Never a bare name. */
  readonly subject: string
  readonly breaking: boolean
  readonly fields: readonly string[]
  readonly before: Record<string, unknown> | null
  readonly after: Record<string, unknown> | null
  readonly reason: string
}

export interface TableDiff {
  readonly fromId: string
  readonly toId: string
  readonly statesAdded: readonly string[]
  readonly statesRemoved: readonly string[]
  readonly rulesAdded: readonly string[]
  readonly rulesRemoved: readonly string[]
  readonly rulesChanged: readonly string[]
  readonly unchanged: number
  readonly tickrateBefore: number
  readonly tickrateAfter: number
  readonly tickrateChanged: boolean
  readonly changes: readonly TableChange[]
  readonly breaking: readonly string[]
  readonly compatible: boolean
}

/** The one document every tool that needs both inputs accepts. */
export interface TableTraceInput {
  readonly table: TransitionTable
  readonly trace: TickTrace
}

export interface DiffInput {
  readonly before: TransitionTable
  readonly after: TransitionTable
}
