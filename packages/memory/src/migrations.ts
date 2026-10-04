/**
 * Migrations are numbered, ordered, and idempotent. Never edit an applied migration —
 * append a new one. `user_version` is the source of truth for the applied prefix.
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly up: readonly string[]
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: [
      `CREATE TABLE IF NOT EXISTS records (
         id         TEXT PRIMARY KEY,
         kind       TEXT NOT NULL,
         payload    TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS records_kind_idx ON records (kind, updated_at DESC)`,
    ],
  },
  {
    version: 2,
    name: 'full_text',
    up: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
         id UNINDEXED, body, tokenize = 'porter unicode61'
       )`,
    ],
  },
  {
    version: 3,
    name: 'triage_ledger',
    up: [
      // One row per judged trace. The point of the store in this product is history: a
      // regression suite that only remembers its last run cannot tell you when a trace
      // started failing, and "when did this break" is the question after every incident.
      //
      // The verdict columns are stored as they were reported rather than recomputed, so a
      // ledger is a record of what the engine said at the time. Recomputing history would
      // quietly rewrite it whenever the engine changes.
      `CREATE TABLE IF NOT EXISTS triage (
         trace_id      TEXT NOT NULL,
         table_id      TEXT NOT NULL,
         verdict       TEXT NOT NULL CHECK (verdict IN ('legal', 'violating')),
         violations    INTEGER NOT NULL,
         first_code    TEXT,
         first_tick    INTEGER,
         coverage      REAL NOT NULL,
         drift_ppm     INTEGER,
         recorded_at   INTEGER NOT NULL,
         PRIMARY KEY (trace_id, table_id, recorded_at)
       )`,
      `CREATE INDEX IF NOT EXISTS triage_trace_idx ON triage (trace_id, recorded_at DESC)`,
      `CREATE INDEX IF NOT EXISTS triage_failing_idx ON triage (verdict, recorded_at DESC)`,
    ],
  },
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0

export function pendingMigrations(current: number): readonly Migration[] {
  return MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
}
