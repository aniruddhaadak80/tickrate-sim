import Link from 'next/link'
import { CASES } from '@/lib/corpus'

export default function NotFound() {
  return (
    <>
      <section className="lede">
        <p className="lede-what">
          No trace with that id. The shipped corpus is the list below - every one of them is reachable, and
          every one is replayed live rather than read from a recording.
        </p>
      </section>

      <ul className="plain-list">
        {CASES.map((entry) => (
          <li key={entry.id}>
            <Link href={`/cases/${entry.id}`}>{entry.title}</Link> <span className="mono">{entry.id}</span>
          </li>
        ))}
      </ul>

      <p style={{ marginTop: 'var(--space-5)' }}>
        <Link href="/">Back to the board</Link>
      </p>
    </>
  )
}
