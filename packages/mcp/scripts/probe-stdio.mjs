/**
 * Real MCP protocol proof over real stdio.
 *
 * This is not a unit test with a mocked transport. It spawns `tickrate-sim mcp serve` as a
 * child process, speaks JSON-RPC to it over a pipe, and asserts on what comes back - because
 * the failure mode this catches is a protocol regression that a mocked client would happily
 * agree with.
 *
 * Run with: node packages/mcp/scripts/probe-stdio.mjs
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js')

const EXPECTED_TOOLS = [
  'budget_profile',
  'diff_tables',
  'list_plugins',
  'list_skills',
  'replay_trace',
  'tickrate_stats',
  'validate_table',
]

const TABLE = {
  id: 'probe',
  tickrateHz: 64,
  entry: 'idle',
  states: [{ name: 'idle' }, { name: 'working' }, { name: 'done', terminal: true }],
  transitions: [
    { id: 'start', source: 'idle', target: 'working', minTicks: 10, maxTicks: 10, repeatable: true },
    { id: 'finish', source: 'working', target: 'done', minTicks: 0, maxTicks: null, repeatable: true },
  ],
}

const TRACE = {
  id: 'probe-trace',
  tableId: 'probe',
  startTick: 0,
  endTick: 100,
  events: [
    { tick: 3, target: 'working' },
    { tick: 9, target: 'done' },
  ],
  anchors: [],
}

class Stdio {
  #child
  #pending = new Map()
  #nextId = 1

  constructor(command, args, cwd) {
    this.#child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: this.#child.stdout })
    lines.on('line', (line) => {
      if (line.trim() === '') return
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      const waiter = this.#pending.get(message.id)
      if (waiter !== undefined) {
        this.#pending.delete(message.id)
        waiter(message)
      }
    })
    this.#child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') process.stderr.write(`[server stderr] ${text}\n`)
    })
  }

  async request(method, params) {
    const id = this.#nextId++
    const waiter = new Promise((resolvePromise) => this.#pending.set(id, resolvePromise))
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    let timer
    const expiry = new Promise((resolveExpiry) => {
      timer = setTimeout(() => resolveExpiry(undefined), 30_000)
    })
    const response = await Promise.race([waiter, expiry])
    clearTimeout(timer)
    if (response === undefined) throw new Error(`${method} timed out`)
    return response
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async close() {
    this.#child.stdin.end()
    this.#child.kill()
  }
}

const checks = []
function check(label, condition, detail = '') {
  checks.push({ label, ok: Boolean(condition), detail })
  process.stdout.write(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail === '' ? '' : ` - ${detail}`}\n`)
}

const transport = new Stdio(process.execPath, [CLI, 'mcp', 'serve'], REPO)

try {
  const init = await transport.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stdio-probe', version: '0.1.0' },
  })
  const serverInfo = init.result?.serverInfo
  check('initialize returns serverInfo', serverInfo?.name === 'tickrate-sim', JSON.stringify(serverInfo))
  transport.notify('notifications/initialized', {})

  const listed = await transport.request('tools/list', {})
  const tools = listed.result?.tools ?? []
  const names = tools.map((tool) => tool.name).sort()
  check(
    'tools/list advertises every product tool',
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
    names.join(', '),
  )
  check(
    'every tool carries a description a model can act on',
    tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 40),
  )
  check(
    'every tool carries an object inputSchema',
    tools.every(
      (tool) =>
        typeof tool.inputSchema === 'object' &&
        tool.inputSchema !== null &&
        tool.inputSchema.type === 'object' &&
        Array.isArray(tool.inputSchema.required),
    ),
  )

  const validateCall = await transport.request('tools/call', {
    name: 'validate_table',
    arguments: { table: TABLE },
  })
  const validateReport = JSON.parse(validateCall.result.content[0].text)
  check(
    'tools/call validate_table reaches the Python engine',
    validateCall.result.isError !== true && validateReport.ok === true,
    `tableId=${validateReport.tableId}`,
  )

  const replayCall = await transport.request('tools/call', {
    name: 'replay_trace',
    arguments: { table: TABLE, trace: TRACE },
  })
  const replayReport = JSON.parse(replayCall.result.content[0].text)
  check(
    'tools/call replay_trace reports the first violation',
    replayReport.firstViolation?.code === 'BUDGET_UNDERRUN',
    `first=${replayReport.firstViolation?.code} tick=${replayReport.firstViolation?.tick}`,
  )
  check(
    'the replay report reaches the caller intact',
    Array.isArray(replayReport.timeline) && replayReport.timeline.length === 3,
    `${replayReport.timeline?.length} timeline steps`,
  )

  const badCall = await transport.request('tools/call', {
    name: 'replay_trace',
    arguments: { table: TABLE, trace: { ...TRACE, tableId: 'some-other-table' } },
  })
  check(
    'an invalid input returns an error envelope, not a crash',
    badCall.result.isError === true && /VALIDATION_FAILED/.test(badCall.result.content[0].text),
    badCall.result.content[0].text.slice(0, 80),
  )

  const unknownCall = await transport.request('tools/call', { name: 'no_such_tool', arguments: {} })
  check('an unknown tool returns an error envelope', unknownCall.result.isError === true)
} finally {
  await transport.close()
}

const failed = checks.filter((entry) => !entry.ok)
process.stdout.write(`\n  ${checks.length - failed.length} passed, ${failed.length} failed\n`)
process.exit(failed.length === 0 ? 0 : 1)
