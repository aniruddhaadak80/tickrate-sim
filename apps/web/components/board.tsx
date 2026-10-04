'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { BudgetProfile, ReplayReport, TickrateStats, TransitionTable } from '@/lib/engine-contract'
import { Inspector } from './inspector'

/**
 * The triage board: three columns and an inspector.
 *
 * This is the only client component on the page, and it exists for one reason - clicking a
 * card should not cost a navigation. Every card is also a real `<a>` to `/cases/<id>`, and the
 * initial selection is chosen on the server, so the HTML that arrives already contains a
 * populated inspector with real numbers in it. With JavaScript disabled the board is still a
 * complete, readable index that links to a full report per trace.
 */

export interface BoardEntry {
  readonly id: string
  readonly title: string
  readonly column: 'captured' | 'replayed' | 'blocking'
  readonly severity: 'clean' | 'minor' | 'major' | 'critical'
  readonly summary: string
  readonly table: TransitionTable
  readonly report: ReplayReport
  readonly stats: TickrateStats
  readonly budget: BudgetProfile
}

export interface BoardColumnSpec {
  readonly id: BoardEntry['column']
  readonly label: string
  readonly blurb: string
}

export interface BoardProps {
  readonly columns: readonly BoardColumnSpec[]
  readonly entries: readonly BoardEntry[]
  readonly selectedId: string
}

export function Board({ columns, entries, selectedId }: BoardProps) {
  const [active, setActive] = useState(selectedId)
  const chosen = entries.find((entry) => entry.id === active) ?? entries[0]

  return (
    <div className="board-layout">
      <div className="board" role="list" aria-label="Triage board">
        {columns.map((column) => {
          const inColumn = entries.filter((entry) => entry.column === column.id)
          return (
            <section className="board-column" key={column.id} aria-labelledby={`col-${column.id}`}>
              <header className="board-column-head">
                <h2 id={`col-${column.id}`}>
                  {column.label} <span className="count">{inColumn.length}</span>
                </h2>
                <p>{column.blurb}</p>
              </header>

              {inColumn.length === 0 ? (
                <p className="state" data-kind="empty">
                  Nothing in this column. A trace lands here once it has been replayed.
                </p>
              ) : (
                <ul className="board-list">
                  {inColumn.map((entry) => {
                    const isActive = entry.id === active
                    return (
                      <li key={entry.id}>
                        <Link
                          href={`/cases/${entry.id}`}
                          className="case-card"
                          data-active={isActive}
                          aria-current={isActive ? 'true' : undefined}
                          onClick={(event) => {
                            // Only intercept a plain left click; modified clicks and
                            // middle-click must keep navigating so the link stays honest.
                            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                            event.preventDefault()
                            setActive(entry.id)
                          }}
                        >
                          <span className="badge" data-tone={entry.severity}>
                            {entry.severity}
                          </span>
                          <span className="case-title">{entry.title}</span>
                          <span className="case-summary">{entry.summary}</span>
                          <span className="case-metrics mono">
                            {entry.report.ticksElapsed} ticks
                            <span aria-hidden="true"> · </span>
                            {entry.report.violations.length === 0
                              ? 'legal'
                              : `${entry.report.violations.length} violation${entry.report.violations.length === 1 ? '' : 's'}`}
                            <span aria-hidden="true"> · </span>
                            {entry.report.coverage.exercised}/{entry.report.coverage.declared} edges
                          </span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <aside className="board-inspector" aria-live="polite">
        {chosen === undefined ? (
          <p className="state" data-kind="empty">
            No trace selected.
          </p>
        ) : (
          <Inspector
            title={chosen.title}
            summary={chosen.summary}
            severity={chosen.severity}
            report={chosen.report}
            stats={chosen.stats}
            budget={chosen.budget}
            table={chosen.table}
            href={`/cases/${chosen.id}`}
          />
        )}
      </aside>
    </div>
  )
}
