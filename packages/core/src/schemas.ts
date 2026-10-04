/**
 * Zod-free JSON Schemas for the five engine tools.
 *
 * Deliberately hand-written rather than derived: the MCP server and the CLI both need to send
 * these to a model, and a schema a model can fill in is worth more here than one generated
 * perfectly. Each tool's `inputSchema` is validated at the tool boundary in `tools.ts` before
 * the handler runs, so a schema that drifts from the parser fails loudly in the TypeScript
 * test rather than becoming a runtime surprise.
 *
 * Field names match the Python engine exactly. Anything else is a bug, not a rename.
 */

export const TABLE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Table identifier, e.g. "skirmish-64".' },
    tickrateHz: { type: 'number', description: 'Declared tick rate. 64 means 15.625 ms per tick.' },
    entry: { type: 'string', description: 'State the machine starts in.' },
    states: {
      type: 'array',
      description: 'Every state the game server can be in.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          terminal: {
            type: 'boolean',
            description: 'True when the machine may never leave this state.',
          },
        },
        required: ['name'],
      },
    },
    transitions: {
      type: 'array',
      description:
        'Declared edges. minTicks and maxTicks bound how many ticks may elapse in the source ' +
        'state before the edge is taken. maxTicks null means unbounded.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          target: { type: 'string' },
          minTicks: { type: 'number' },
          maxTicks: { type: ['number', 'null'] },
          repeatable: {
            type: 'boolean',
            description: 'False means the edge may be taken at most once per match.',
          },
        },
        required: ['id', 'source', 'target'],
      },
    },
  },
  required: ['id', 'tickrateHz', 'entry', 'states', 'transitions'],
  additionalProperties: false,
} as const

export const TRACE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    tableId: { type: 'string', description: 'Must equal the id of the table it is replayed against.' },
    startTick: { type: 'number' },
    endTick: { type: 'number', description: 'Last tick of the recording window.' },
    events: {
      type: 'array',
      description: 'Observed transitions, in tick order. One per state entry.',
      items: {
        type: 'object',
        properties: { tick: { type: 'number' }, target: { type: 'string' } },
        required: ['tick', 'target'],
      },
    },
    anchors: {
      type: 'array',
      description:
        'Wall-clock readings, at least two to measure a rate. Strictly increasing in both ' + 'tick and ms.',
      items: {
        type: 'object',
        properties: { tick: { type: 'number' }, ms: { type: 'number' } },
        required: ['tick', 'ms'],
      },
    },
  },
  required: ['id', 'tableId', 'startTick', 'endTick', 'events'],
  additionalProperties: false,
} as const

export const TABLE_ONLY_INPUT_SCHEMA = {
  type: 'object',
  properties: { table: TABLE_SCHEMA },
  required: ['table'],
  additionalProperties: false,
} as const

export const TABLE_TRACE_INPUT_SCHEMA = {
  type: 'object',
  properties: { table: TABLE_SCHEMA, trace: TRACE_SCHEMA },
  required: ['table', 'trace'],
  additionalProperties: false,
} as const

export const DIFF_INPUT_SCHEMA = {
  type: 'object',
  properties: { before: TABLE_SCHEMA, after: TABLE_SCHEMA },
  required: ['before', 'after'],
  additionalProperties: false,
} as const

export const REPORT_SCHEMAS = {
  replay: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'True when nothing in the trace is undeclared.' },
      firstViolation: {
        type: ['object', 'null'],
        description: 'The first thing that went wrong, which is the one worth reading first.',
      },
      violations: { type: 'array' },
      timeline: { type: 'array' },
      coverage: {
        type: 'object',
        properties: { ratio: { type: 'number' }, uncovered: { type: 'array' } },
      },
    },
    required: ['ok', 'firstViolation', 'violations', 'timeline', 'coverage'],
  },
  budgetProfile: {
    type: 'object',
    properties: { rows: { type: 'array' }, overruns: { type: 'number' }, underruns: { type: 'number' } },
    required: ['rows', 'overruns', 'underruns', 'unused'],
  },
  tickrate: {
    type: 'object',
    properties: {
      effectiveHz: { type: ['number', 'null'] },
      driftPpm: { type: ['number', 'null'] },
      jitterHz: { type: ['number', 'null'] },
      verdict: { type: 'string', enum: ['on_rate', 'drifting', 'under_anchored'] },
    },
    required: ['effectiveHz', 'driftPpm', 'jitterHz', 'verdict'],
  },
  validateTable: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      errors: { type: 'number' },
      warnings: { type: 'number' },
      issues: { type: 'array' },
    },
    required: ['ok', 'errors', 'warnings', 'issues'],
  },
  diffTables: {
    type: 'object',
    properties: {
      compatible: { type: 'boolean', description: 'True when no change would reject a passing trace.' },
      breaking: { type: 'array' },
      changes: { type: 'array' },
    },
    required: ['compatible', 'breaking', 'changes'],
  },
} as const
