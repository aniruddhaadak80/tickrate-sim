import { diffTables } from '@/lib/engine'
import { DIFFS } from '@/lib/corpus'

export const dynamic = 'force-static'

/**
 * Which change to a transition table would make a trace that used to pass start failing.
 *
 * Computed here with the browser mirror of `diff_tables`, the same mirror the board uses and the
 * parity test proves equal to the engine. This is the review view: a netcode change is almost
 * always a budget change rather than a new edge, and a diff that only listed added and removed
 * edges would call those revisions harmless.
 */
export default function DiffPage() {
  const results = DIFFS.map((entry) => ({ ...entry, diff: diffTables(entry.before, entry.after) }))

  return (
    <>
      <section className="lede">
        <p className="lede-what">
          Which changes to a declared table would make a passing trace fail. Raising a <code>minTicks</code>{' '}
          or capping a previously unbounded <code>maxTicks</code> counts as breaking, even though no edge was
          added or removed.
        </p>
      </section>

      {results.map((entry) => (
        <section className="panel" key={entry.id} aria-labelledby={`d-${entry.id}`}>
          <h2 id={`d-${entry.id}`}>
            <span className="mono">{entry.diff.fromId}</span>
            <span aria-hidden="true"> &rarr; </span>
            <span className="mono">{entry.diff.toId}</span>
          </h2>

          <p className="verdict" data-ok={entry.diff.compatible}>
            {entry.diff.compatible ? (
              <>
                <strong>Compatible.</strong> No change here rejects a trace that previously passed.
              </>
            ) : (
              <>
                <strong>
                  {entry.diff.breaking.length} breaking change{entry.diff.breaking.length === 1 ? '' : 's'}.
                </strong>{' '}
                <span className="mono">{entry.diff.breaking.join(', ')}</span>
              </>
            )}
          </p>

          <dl className="stats">
            <div>
              <dt>Unchanged edges</dt>
              <dd className="mono">{entry.diff.unchanged}</dd>
            </div>
            <div>
              <dt>Rules added</dt>
              <dd className="mono">{entry.diff.rulesAdded.length}</dd>
            </div>
            <div>
              <dt>Rules removed</dt>
              <dd className="mono">{entry.diff.rulesRemoved.length}</dd>
            </div>
            <div>
              <dt>Rules modified</dt>
              <dd className="mono">{entry.diff.rulesChanged.length}</dd>
            </div>
            <div>
              <dt>Tickrate</dt>
              <dd className="mono">
                {entry.diff.tickrateBefore} &rarr; {entry.diff.tickrateAfter} Hz
              </dd>
            </div>
          </dl>

          {entry.diff.changes.length === 0 ? (
            <p className="state" data-kind="empty">
              These two revisions are identical.
            </p>
          ) : (
            <table className="table">
              <caption className="sr-only">Every difference between the two table revisions</caption>
              <thead>
                <tr>
                  <th scope="col">Impact</th>
                  <th scope="col">Change</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {entry.diff.changes.map((change) => (
                  <tr key={`${change.kind}-${change.subject}`} data-breaking={change.breaking}>
                    <td className="mono">{change.breaking ? 'breaking' : change.kind}</td>
                    <td className="mono">{change.kind}</td>
                    <td className="mono">{change.subject}</td>
                    <td>{change.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </>
  )
}
