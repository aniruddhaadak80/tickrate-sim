import Database from 'better-sqlite3'
import { MIGRATIONS, LATEST_VERSION, pendingMigrations } from './migrations.js'

export interface RecordRow {
  id: string
  kind: string
  payload: string
  created_at: number
  updated_at: number
}

/**
 * Every write goes through `transaction()`. No ad-hoc db.exec outside it — that rule is
 * what makes concurrent writers safe and makes a failed write leave no partial state.
 */
export class Store {
  readonly #db: Database.Database

  constructor(path = ':memory:') {
    this.#db = new Database(path)
    this.#db.pragma('journal_mode = WAL')
    this.#db.pragma('foreign_keys = ON')
    this.migrate()
  }

  get version(): number {
    return (this.#db.pragma('user_version', { simple: true }) as number) ?? 0
  }

  get isPending(): boolean {
    return pendingMigrations(this.version).length > 0
  }

  migrate(): number {
    const from = this.version
    for (const migration of pendingMigrations(from)) {
      this.transaction(() => {
        for (const statement of migration.up) this.#db.exec(statement)
        this.#db.pragma(`user_version = ${migration.version}`)
      })
    }
    return this.version
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)()
  }

  /**
   * A prepared statement from the underlying connection.
   *
   * Exposed so a subsystem can own its own tables without this class knowing what they mean -
   * the triage ledger does not belong in a generic key-value store's API. The rule this does
   * *not* relax: writes still go through `transaction()`, so a subsystem cannot bypass it by
   * reaching for a connection.
   */
  prepare(sql: string): Database.Statement {
    return this.#db.prepare(sql)
  }

  put(record: { id: string; kind: string; payload: unknown; now: number }): void {
    const text = JSON.stringify(record.payload)
    this.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO records (id, kind, payload, created_at, updated_at)
           VALUES (@id, @kind, @payload, @now, @now)
           ON CONFLICT(id) DO UPDATE SET
             payload = excluded.payload,
             updated_at = excluded.updated_at`,
        )
        .run({ id: record.id, kind: record.kind, payload: text, now: record.now })

      // FTS5 virtual tables do not support UPSERT (ON CONFLICT), so the index row is
      // replaced explicitly. This is a SQLite limitation, not a style preference.
      this.#db.prepare('DELETE FROM records_fts WHERE id = ?').run(record.id)
      this.#db.prepare('INSERT INTO records_fts (id, body) VALUES (?, ?)').run(record.id, text)
    })
  }

  get(id: string): RecordRow | undefined {
    return this.#db.prepare('SELECT * FROM records WHERE id = ?').get(id) as RecordRow | undefined
  }

  list(kind: string, limit = 50): readonly RecordRow[] {
    return this.#db
      .prepare('SELECT * FROM records WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
      .all(kind, limit) as RecordRow[]
  }

  search(query: string, limit = 50): readonly RecordRow[] {
    return this.#db
      .prepare(
        `SELECT r.* FROM records_fts f
           JOIN records r ON r.id = f.id
           WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as RecordRow[]
  }

  delete(id: string): boolean {
    return this.transaction(() => {
      const result = this.#db.prepare('DELETE FROM records WHERE id = ?').run(id)
      this.#db.prepare('DELETE FROM records_fts WHERE id = ?').run(id)
      return result.changes > 0
    })
  }

  close(): void {
    this.#db.close()
  }
}

export { LATEST_VERSION, MIGRATIONS }
