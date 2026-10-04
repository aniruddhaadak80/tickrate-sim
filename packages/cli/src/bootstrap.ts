import { join } from 'node:path'
import {
  DIFF_INPUT_SCHEMA,
  REPORT_SCHEMAS,
  TABLE_ONLY_INPUT_SCHEMA,
  TABLE_TRACE_INPUT_SCHEMA,
  ToolRegistry,
  ValidationError,
  assertPaired,
  parseTable,
  parseTrace,
  type BudgetProfile,
  type ReplayReport,
  type TableDiff,
  type TableValidation,
  type TickrateStats,
  type Tool,
  type ToolContext,
} from '@tickratesim/core'
import { buildRegistry as buildPluginRegistry } from '@tickratesim/plugins'
import { loadCatalog } from '@tickratesim/skills'

/** The Python package the engine is invoked as. One place, so it cannot drift. */
export const ENGINE_MODULE = 'tickrate_sim'

/**
 * Builds the one registry every surface shares.
 *
 * These are the seven tools that make up the product, and all of them are real on a fresh
 * install rather than stubs. Each name matches `^[a-z][a-z0-9_]*$` so it is directly exposable
 * over MCP without a mapping layer.
 *
 * The five engine tools all do the same three things and nothing else: validate their input
 * against the schema, hand it to the Python engine over stdin/stdout, and return the JSON the
 * engine produced. No tool interprets or reshapes an engine result, because a surface that
 * "helpfully" summarised a violation list would be a second implementation of the thing the
 * engine already decides.
 */
export function buildToolRegistry(cwd = process.cwd()): ToolRegistry {
  const registry = new ToolRegistry()

  registry.register(listSkills(cwd), { source: 'core' })
  registry.register(listPlugins(cwd), { source: 'core' })
  registry.register(validateTableTool(cwd), { source: 'core' })
  registry.register(replayTraceTool(cwd), { source: 'core' })
  registry.register(tickrateStatsTool(cwd), { source: 'core' })
  registry.register(budgetProfileTool(cwd), { source: 'core' })
  registry.register(diffTablesTool(cwd), { source: 'core' })

  return registry
}

function listSkills(cwd: string): Tool<{ includeBodies?: boolean }, unknown> {
  return {
    name: 'list_skills',
    description:
      'List the skill catalog with each skill name, version and description. Use this to ' +
      'discover how to drive a tick replay before guessing a command.',
    inputSchema: {
      type: 'object',
      properties: { includeBodies: { type: 'boolean', description: 'Include each skill body.' } },
      // Spelled out even though it is empty: several MCP clients read `required`
      // unconditionally, and an absent key is indistinguishable from a broken schema.
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        issues: { type: 'array', items: { type: 'string' } },
        skills: { type: 'array', items: { type: 'object' } },
      },
      required: ['count', 'issues', 'skills'],
    },
    permissions: ['fs:read'],
    surface: 'core',
    handler: async (input) => {
      const { skills, issues } = loadCatalog(join(cwd, 'skills'))
      return {
        count: skills.length,
        issues: [...issues],
        skills: skills.map((skill) => ({
          name: skill.name,
          version: skill.version,
          description: skill.description,
          ...(input.includeBodies === true ? { body: skill.body } : {}),
        })),
      }
    },
  }
}

function listPlugins(cwd: string): Tool<Record<string, never>, unknown> {
  return {
    name: 'list_plugins',
    description:
      'List the resolved plugin registry, including plugins that were shadowed, disabled or ' +
      'rejected and why. Use this to explain why an expected capability is missing.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: 'object' },
    permissions: ['fs:read'],
    surface: 'core',
    handler: async () => {
      const result = buildPluginRegistry(join(cwd, 'plugins'))
      return {
        active: result.active.map((plugin) => ({
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          capabilities: plugin.manifest.capabilities,
          shadowed: plugin.shadowed,
        })),
        disabled: result.disabled.map((plugin) => plugin.manifest.name),
        rejected: result.rejected.map((plugin) => ({ path: plugin.path, issues: plugin.issues })),
      }
    },
  }
}

/**
 * One place that knows how to reach Python, so no tool spawns a process itself.
 *
 * Spawning is `proc:spawn`, declared on every tool that uses this, which means a sandboxed
 * caller can run `list_skills` and `list_plugins` without being able to run the engine.
 */
async function runEngine<T>(op: string, input: unknown, cwd: string): Promise<T> {
  const { EngineBridge } = await import('@tickratesim/engine-client')
  const bridge = new EngineBridge({
    module: ENGINE_MODULE,
    cwd: join(cwd, 'services', 'engine', 'src'),
  })
  return await bridge.call<T>({ op, input })
}

function validateTableTool(cwd: string): Tool<{ table: unknown }, TableValidation> {
  return {
    name: 'validate_table',
    description:
      'Check a netcode transition table before you replay anything against it. Reports ' +
      'unreachable states, dead ends, terminal states with exits, inverted or negative tick ' +
      'budgets, and edges declared twice. Run this first: a table that fails here will produce ' +
      'misleading replay results.',
    inputSchema: TABLE_ONLY_INPUT_SCHEMA,
    outputSchema: REPORT_SCHEMAS.validateTable,
    permissions: ['proc:spawn'],
    surface: 'core',
    handler: async (input) =>
      await runEngine<TableValidation>('validate_table', { table: parseTable(input.table) }, cwd),
  }
}

function replayTraceTool(cwd: string): Tool<{ table: unknown; trace: unknown }, ReplayReport> {
  return {
    name: 'replay_trace',
    description:
      'Replay an observed tick trace against a transition table and report every transition ' +
      'the table does not permit. Returns the full timeline, the first violation (the one ' +
      'worth reading first), every later violation, and which declared edges the trace never ' +
      'exercised. The walk never stops at a violation, so a trace with three problems returns ' +
      'all three.',
    inputSchema: TABLE_TRACE_INPUT_SCHEMA,
    outputSchema: REPORT_SCHEMAS.replay,
    permissions: ['proc:spawn'],
    surface: 'core',
    handler: async (input) => {
      const table = parseTable(input.table)
      const trace = parseTrace(input.trace)
      assertPaired(table, trace)
      return await runEngine<ReplayReport>('replay', { table, trace }, cwd)
    },
  }
}

function tickrateStatsTool(cwd: string): Tool<{ table: unknown; trace: unknown }, TickrateStats> {
  return {
    name: 'tickrate_stats',
    description:
      'Measure the tick rate a trace actually achieved, from its wall-clock anchors: effective ' +
      'Hz, drift in parts per million against the declared rate, and inter-arrival jitter. Use ' +
      'it when a replay is clean but players still report stutter - the transition table can be ' +
      'honoured perfectly by a server that is running slow. Needs at least two anchors.',
    inputSchema: TABLE_TRACE_INPUT_SCHEMA,
    outputSchema: REPORT_SCHEMAS.tickrate,
    permissions: ['proc:spawn'],
    surface: 'core',
    handler: async (input) => {
      const table = parseTable(input.table)
      const trace = parseTrace(input.trace)
      assertPaired(table, trace)
      return await runEngine<TickrateStats>('tickrate_stats', { table, trace }, cwd)
    },
  }
}

function budgetProfileTool(cwd: string): Tool<{ table: unknown; trace: unknown }, BudgetProfile> {
  return {
    name: 'budget_profile',
    description:
      'Compare every declared rule tick budget against what a trace actually spent, and report ' +
      'which declared edges the trace never took. Use it to find a minTicks of 3 where ' +
      'production always takes 3, or a maxTicks of 600 that nothing has ever approached.',
    inputSchema: TABLE_TRACE_INPUT_SCHEMA,
    outputSchema: REPORT_SCHEMAS.budgetProfile,
    permissions: ['proc:spawn'],
    surface: 'core',
    handler: async (input) => {
      const table = parseTable(input.table)
      const trace = parseTrace(input.trace)
      assertPaired(table, trace)
      return await runEngine<BudgetProfile>('budget_profile', { table, trace }, cwd)
    },
  }
}

function diffTablesTool(cwd: string): Tool<{ before: unknown; after: unknown }, TableDiff> {
  return {
    name: 'diff_tables',
    description:
      'Compare two revisions of a transition table and name the changes that would make a ' +
      'passing trace fail. Use it in review: raising a minTicks or capping a previously ' +
      'unbounded maxTicks is breaking even though no edge was added or removed.',
    inputSchema: DIFF_INPUT_SCHEMA,
    outputSchema: REPORT_SCHEMAS.diffTables,
    permissions: ['proc:spawn'],
    surface: 'core',
    handler: async (input) => {
      const document = input as { before?: unknown; after?: unknown }
      if (document.before === undefined)
        throw new ValidationError('"before" is required', { field: 'before' })
      if (document.after === undefined) throw new ValidationError('"after" is required', { field: 'after' })
      const before = parseTable(document.before, 'before')
      const after = parseTable(document.after, 'after')
      return await runEngine<TableDiff>('diff_tables', { before, after }, cwd)
    },
  }
}

/** A minimal, dependency-free logger for the tool context. */
export function createContext(requestId = 'cli'): ToolContext {
  return {
    requestId,
    now: () => Date.now(),
    log: (level, message, fields) => {
      process.stderr.write(`${JSON.stringify({ level, message, requestId, ...fields })}\n`)
    },
    dataDir: process.env.PRODUCT_DATA_DIR ?? '.data',
  }
}
