/**
 * Boundary validation for tool input, in the same spirit as `packages/core/src/registry.ts`
 * refusing a duplicate name: the check happens before the handler runs, and the error names
 * the path that is wrong.
 *
 * This is deliberately not `zod`. The core package takes zero runtime dependencies, and that
 * is a load-bearing constraint rather than an accident - the waist is imported by the MCP
 * server, the CLI and the web app, and every one of them would inherit the dependency. What
 * the product needs from validation is precise error messages, not a schema language.
 */

import { ValidationError } from './errors.js'
import type { Anchor, StateSpec, TickTrace, TraceEvent, TransitionRule, TransitionTable } from './contract.js'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(path: string, expectation: string, received: unknown): never {
  throw new ValidationError(`${path} ${expectation}`, {
    path,
    received: typeof received === 'object' ? JSON.stringify(received) : received,
  })
}

function object(value: unknown, path: string): Json {
  if (!isObject(value)) fail(path, 'must be an object', value)
  return value
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array', value)
  return value
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string', value)
  return value
}

function integer(value: unknown, path: string): number {
  // JSON has no integer type, but a boolean or a fractional tick count is always a mistake,
  // and silently accepting one would put a wrong tick number into a state machine walk.
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(path, 'must be an integer', value)
  }
  return value
}

function positive(value: unknown, path: string): number {
  const parsed = integer(value, path)
  if (parsed <= 0) fail(path, 'must be greater than zero', value)
  return parsed
}

function optionalBoolean(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(path, 'must be a boolean', value)
  return value
}

/**
 * Optional free text. Empty is a legitimate value here - `"guard": ""` means "no guard" -
 * so this deliberately differs from `text`, which is for identifiers where an empty string is
 * never what the caller meant.
 */
function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') fail(path, 'must be a string', value)
  return value
}

/** `minTicks` defaults to 0 and `maxTicks` defaults to unbounded - an idle lobby shape. */
export function parseRule(value: unknown, path: string): TransitionRule {
  const raw = object(value, path)
  const minTicks = raw['minTicks'] === undefined ? 0 : integer(raw['minTicks'], `${path}.minTicks`)
  const maxTicks =
    raw['maxTicks'] === undefined || raw['maxTicks'] === null
      ? null
      : integer(raw['maxTicks'], `${path}.maxTicks`)
  const guard = optionalString(raw['guard'], `${path}.guard`)
  return {
    id: text(raw['id'], `${path}.id`),
    source: text(raw['source'], `${path}.source`),
    target: text(raw['target'], `${path}.target`),
    minTicks,
    maxTicks,
    repeatable: optionalBoolean(raw['repeatable'], `${path}.repeatable`, true),
    ...(guard === undefined ? {} : { guard }),
  }
}

export function parseState(value: unknown, path: string): StateSpec {
  const raw = object(value, path)
  const description = optionalString(raw['description'], `${path}.description`)
  return {
    name: text(raw['name'], `${path}.name`),
    terminal: optionalBoolean(raw['terminal'], `${path}.terminal`, false),
    ...(description === undefined ? {} : { description }),
  }
}

export function parseTable(value: unknown, path = 'table'): TransitionTable {
  const raw = object(value, path)
  return {
    id: text(raw['id'], `${path}.id`),
    tickrateHz: positive(raw['tickrateHz'], `${path}.tickrateHz`),
    entry: text(raw['entry'], `${path}.entry`),
    states: array(raw['states'], `${path}.states`).map((state, index) =>
      parseState(state, `${path}.states[${index}]`),
    ),
    transitions: array(raw['transitions'], `${path}.transitions`).map((rule, index) =>
      parseRule(rule, `${path}.transitions[${index}]`),
    ),
  }
}

function parseEvent(value: unknown, path: string): TraceEvent {
  const raw = object(value, path)
  const note = optionalString(raw['note'], `${path}.note`)
  return {
    tick: integer(raw['tick'], `${path}.tick`),
    target: text(raw['target'], `${path}.target`),
    ...(note === undefined ? {} : { note }),
  }
}

function parseAnchor(value: unknown, path: string): Anchor {
  const raw = object(value, path)
  return { tick: integer(raw['tick'], `${path}.tick`), ms: integer(raw['ms'], `${path}.ms`) }
}

export function parseTrace(value: unknown, path = 'trace'): TickTrace {
  const raw = object(value, path)
  const startTick = integer(raw['startTick'], `${path}.startTick`)
  const endTick = integer(raw['endTick'], `${path}.endTick`)
  if (endTick < startTick) {
    throw new ValidationError(`${path}.endTick must not precede ${path}.startTick`, {
      path,
      startTick,
      endTick,
    })
  }
  return {
    id: text(raw['id'], `${path}.id`),
    tableId: text(raw['tableId'], `${path}.tableId`),
    startTick,
    endTick,
    events: array(raw['events'], `${path}.events`).map((event, index) =>
      parseEvent(event, `${path}.events[${index}]`),
    ),
    anchors:
      raw['anchors'] === undefined
        ? []
        : array(raw['anchors'], `${path}.anchors`).map((anchor, index) =>
            parseAnchor(anchor, `${path}.anchors[${index}]`),
          ),
  }
}

/**
 * A trace replayed against the wrong table is a caller mistake with an obvious fix, so it is
 * caught here where the message can name both ids.
 */
export function assertPaired(table: TransitionTable, trace: TickTrace): void {
  if (trace.tableId !== table.id) {
    throw new ValidationError(`trace.tableId "${trace.tableId}" does not match table.id "${table.id}"`, {
      tableId: table.id,
      traceTableId: trace.tableId,
    })
  }
}
