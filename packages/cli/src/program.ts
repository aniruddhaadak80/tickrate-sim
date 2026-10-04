import { Command } from 'commander'
import {
  ProductError,
  parseTable,
  parseTrace,
  type BudgetProfile,
  type ReplayReport,
  type TableDiff,
  type TableValidation,
  type TickrateStats,
  type TransitionTable,
} from '@tickratesim/core'
import { buildToolRegistry, createContext, ENGINE_MODULE } from './bootstrap.js'
import { doctor, renderReport } from './doctor.js'
import { findCase, loadCorpus, parseJsonFile, renderCaseList } from './corpus.js'
import {
  renderBudget,
  renderDiff,
  renderReplay,
  renderTableSummary,
  renderTickrate,
  renderValidation,
} from './render.js'

const VERSION = '0.1.0'

/** Permissions the CLI grants on a user's behalf. Every tool that spawns Python needs these. */
const GRANTED = ['fs:read', 'net:fetch', 'proc:spawn'] as const

/**
 * Exit codes are part of the contract: 0 ok, 1 runtime failure, 2 usage error.
 *
 * A replay that found violations still exits 0 - the tool worked, the trace did not. Only a
 * failure to produce an answer is an error, because a CI job wants to distinguish "no bugs
 * found" from "the tool could not run".
 */
export function buildProgram(): Command {
  const program = new Command()

  program
    .name('tickrate-sim')
    .description(
      'Replay a recorded multiplayer tick trace against your declared netcode state machine, ' +
        'and get the first transition the table does not permit - with its tick, its rule and ' +
        'its budget.',
    )
    .version(VERSION, '-v, --version', 'print the version')
    .exitOverride((error) => {
      process.exitCode = error.exitCode === 0 ? 0 : 2
      throw error
    })

  program
    .command('doctor')
    .description('diagnose every subsystem and print an actionable report')
    .option('--json', 'machine-readable output')
    .action(async () => {
      const report = await doctor()
      process.stdout.write(
        process.argv.includes('--json')
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${renderReport(report)}\n`,
      )
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('tools')
    .description('list the registered tools - the authoritative capability list')
    .option('--json', 'machine-readable output')
    .action(() => {
      const registry = buildToolRegistry()
      const tools = registry.list().map((tool) => ({
        name: tool.name,
        description: tool.description,
        surface: registry.surfaceOf(tool.name),
        source: registry.sourceOf(tool.name),
        permissions: tool.permissions,
        inputSchema: tool.inputSchema,
      }))
      if (process.argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
        return
      }
      const width = Math.max(...tools.map((entry) => entry.name.length), 4)
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name.padEnd(width)}  [${tool.surface}]  ${tool.description}\n`)
      }
    })

  registerEngineCommands(program)
  registerCorpusCommands(program)
  registerMcpCommands(program)

  program
    .command('version')
    .description('print version and runtime information as JSON')
    .action(() => {
      process.stdout.write(
        `${JSON.stringify(
          {
            name: 'tickrate-sim',
            version: VERSION,
            node: process.versions.node,
            engine: ENGINE_MODULE,
            platform: process.platform,
            tools: buildToolRegistry().size,
          },
          null,
          2,
        )}\n`,
      )
    })

  return program
}

/**
 * Every engine-backed command goes through the tool registry, never through the bridge
 * directly. That is the narrow waist doing its job: `replay_trace` called from a terminal and
 * `replay_trace` called by an MCP client run the same code, so they cannot disagree.
 */
function registerEngineCommands(program: Command): void {
  program
    .command('validate')
    .description('check a transition table for unreachable states, dead ends and bad budgets')
    .argument('<table.json>', 'path to a transition table document')
    .option('--json', 'machine-readable output')
    .action(async (path: string) => {
      const table = parseTable(parseJsonFile<unknown>(path), 'table')
      const report = await invoke<TableValidation>('validate_table', { table })
      process.stdout.write(`${wantsJson() ? JSON.stringify(report, null, 2) : renderValidation(report)}\n`)
      if (!report.ok) process.exitCode = 1
    })

  program
    .command('table')
    .description('print a transition table in readable form')
    .argument('<table.json>', 'path to a transition table document')
    .action((path: string) => {
      const table = parseTable(parseJsonFile<unknown>(path), 'table')
      process.stdout.write(`${renderTableSummary(table)}\n`)
    })

  registerTraceCommand(
    program,
    'replay',
    'walk a trace against the table and report every violation',
    renderReplay,
  )
  registerTraceCommand(
    program,
    'stats',
    'measure the tick rate a trace actually achieved, and how much it wobbled',
    renderTickrate,
  )
  registerTraceCommand(
    program,
    'budget',
    'compare each declared tick budget against what the trace spent',
    renderBudget,
  )

  program
    .command('diff')
    .description('compare two table revisions and name the changes that break a passing trace')
    .argument('<before.json>', 'the earlier transition table')
    .argument('<after.json>', 'the later transition table')
    .option('--json', 'machine-readable output')
    .action(async (beforePath: string, afterPath: string) => {
      const before = parseTable(parseJsonFile<unknown>(beforePath), 'before')
      const after = parseTable(parseJsonFile<unknown>(afterPath), 'after')
      const diff = await invoke<TableDiff>('diff_tables', { before, after })
      process.stdout.write(`${wantsJson() ? JSON.stringify(diff, null, 2) : renderDiff(diff)}\n`)
      if (!diff.compatible) process.exitCode = 1
    })
}

function registerTraceCommand(
  program: Command,
  name: 'replay' | 'stats' | 'budget',
  description: string,
  render: (report: never) => string,
): void {
  const tool = { replay: 'replay_trace', stats: 'tickrate_stats', budget: 'budget_profile' }[name]
  program
    .command(name)
    .description(description)
    .argument('<trace.json>', 'path to a recorded tick trace')
    .requiredOption('-t, --table <table.json>', 'path to the transition table to replay against')
    .option('--json', 'machine-readable output')
    .action(async (path: string, options: { table: string }) => {
      const table = parseTable(parseJsonFile<unknown>(options.table), 'table')
      const trace = parseTrace(parseJsonFile<unknown>(path), 'trace')
      const report = await invoke<ReplayReport | TickrateStats | BudgetProfile>(tool, { table, trace })
      process.stdout.write(`${wantsJson() ? JSON.stringify(report, null, 2) : render(report as never)}\n`)
    })
}

function registerCorpusCommands(program: Command): void {
  const corpus = program
    .command('corpus')
    .description('list the shipped cases - real traces with known verdicts')

  corpus
    .command('list', { isDefault: true })
    .description('one line per shipped case')
    .action(() => {
      process.stdout.write(`${renderCaseList(loadCorpus())}\n`)
    })

  corpus
    .command('show')
    .description('replay one shipped case through the engine and print the report')
    .argument('<id>', 'case id, as listed by "tickrate-sim corpus"')
    .option('--json', 'machine-readable output')
    .action(async (id: string) => {
      const found = findCase(loadCorpus(), id)
      if (found === undefined) {
        throw new ProductError('NOT_FOUND', `no shipped case with id "${id}"`, { id })
      }
      const report = await invoke<ReplayReport>('replay_trace', { table: found.table, trace: found.trace })
      if (wantsJson()) {
        process.stdout.write(`${JSON.stringify({ case: found.id, replay: report }, null, 2)}\n`)
        return
      }
      process.stdout.write([`${found.title}`, `  ${found.summary}`, '', renderReplay(report)].join('\n'))
    })

  corpus
    .command('tables')
    .description('print every shipped transition table')
    .action(() => {
      const { tables } = loadCorpus()
      for (const table of tables) {
        process.stdout.write(`${renderTableSummary(table as TransitionTable)}\n\n`)
      }
    })
}

function registerMcpCommands(program: Command): void {
  const mcp = program.command('mcp').description('Model Context Protocol commands')

  mcp
    .command('serve')
    .description('run the MCP server over stdio')
    .action(async () => {
      const { serveStdio } = await import('@tickratesim/mcp')
      const registry = buildToolRegistry()
      // stdout belongs to the protocol from here on; diagnostics must go to stderr.
      await serveStdio(registry, createContext('mcp'))
    })

  mcp
    .command('call')
    .description('invoke one tool directly, without MCP')
    .argument('<tool>', 'tool name')
    .argument('<input>', 'JSON input document')
    .action(async (tool: string, raw: string) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        process.stderr.write(`error: input is not valid JSON - ${String(cause)}\n`)
        process.exitCode = 2
        return
      }
      const value = await invoke(tool, parsed)
      process.stdout.write(`${JSON.stringify(value ?? null, null, 2)}\n`)
    })
}

async function invoke<T>(tool: string, input: unknown): Promise<T> {
  const registry = buildToolRegistry()
  try {
    return (await registry.invoke(tool, input, createContext('cli'), [...GRANTED])) as T
  } catch (cause) {
    const code = (cause as { code?: string }).code ?? 'INTERNAL'
    process.stderr.write(`${code}: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = cause instanceof ProductError && cause.code === 'VALIDATION_FAILED' ? 2 : 1
    throw cause
  }
}

function wantsJson(): boolean {
  return process.argv.includes('--json')
}
