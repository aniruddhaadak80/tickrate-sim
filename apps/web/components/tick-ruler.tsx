import type { ReplayReport, TransitionTable } from '@tickratesim/core'

/**
 * The tick ruler: this product's one signature visual element.
 *
 * Every screenshot of this page is identifiable by it. A single hairline column per tick span,
 * shaded by the state the machine was in, with a magenta marker at the first illegal tick. It
 * answers "where did it break" in one glance and in one image, which is the question the whole
 * product exists to answer.
 *
 * It is drawn as spans rather than a canvas so it stays selectable, printable, screen-readable,
 * and legible at any zoom. The width is a percentage of the trace window, so it reflows at
 * every viewport without a resize listener.
 */
export interface TickRulerProps {
  readonly table: TransitionTable
  readonly report: ReplayReport
  /** How many spans to draw. Bounds the DOM on a long trace. */
  readonly maxSpans?: number
}

/** Stable colour per state, so the same state is the same shade in every ruler on the page. */
function stateShade(table: TransitionTable, state: string): string {
  const order = table.states.map((entry) => entry.name)
  const palette = [
    'var(--state-idle)',
    'var(--state-run)',
    'var(--state-hold)',
    'var(--state-warm)',
    'var(--state-break)',
  ]
  const index = order.indexOf(state)
  if (index < 0) return 'var(--state-illegal)'
  return palette[index % palette.length] as string
}

interface Span {
  readonly state: string
  readonly from: number
  readonly to: number
  readonly legal: boolean
  readonly marker: string | null
}

export function buildSpans(table: TransitionTable, report: ReplayReport, maxSpans: number): Span[] {
  const window = Math.max(1, report.endTick - report.startTick)
  // Always the full span count. The ruler's job is to show the shape of a whole trace, so its
  // density comes from the trace's length, not from how many events happened to be recorded -
  // a trace with two events over eight thousand ticks still has to read as eight thousand ticks.
  const steps = Math.max(1, maxSpans)
  const buckets: { state: string; legal: boolean; marker: string | null }[][] = Array.from(
    { length: steps },
    () => [],
  )

  for (const step of report.timeline) {
    const position = Math.min(
      steps - 1,
      Math.max(0, Math.floor(((step.tick - report.startTick) / window) * steps)),
    )
    const bucket = buckets[position]
    if (bucket === undefined) continue
    bucket.push({ state: step.state, legal: step.legal, marker: step.via })
  }

  const firstIllegal = report.firstViolation
  const spans: Span[] = []
  for (let index = 0; index < steps; index += 1) {
    const bucket = buckets[index] ?? []
    const illegal = firstIllegal !== null && bucket.some((entry) => !entry.legal)
    const state = bucket[0]?.state ?? report.startState
    spans.push({
      state,
      from: report.startTick + Math.round((index / steps) * window),
      to: report.startTick + Math.round(((index + 1) / steps) * window),
      legal: !illegal,
      marker: illegal ? (firstIllegal?.code ?? null) : (bucket[0]?.marker ?? null),
    })
  }
  return spans
}

export function TickRuler({ table, report, maxSpans = 96 }: TickRulerProps) {
  const spans = buildSpans(table, report, maxSpans)
  const illegalCount = spans.filter((span) => !span.legal).length

  return (
    <figure className="ruler" aria-labelledby="ruler-caption">
      <div
        className="ruler-track"
        role="img"
        aria-label={
          report.ok
            ? `Tick ruler: ${report.ticksElapsed} ticks from ${report.startState} to ${report.endState}, every observed transition declared.`
            : `Tick ruler: ${report.ticksElapsed} ticks from ${report.startState} to ${report.endState}, first violation at tick ${report.firstViolation?.tick ?? 0} (${report.firstViolation?.code ?? 'unknown'}).`
        }
      >
        {spans.map((span, index) => (
          <span
            key={`${span.from}-${index}`}
            className="ruler-tick"
            data-legal={span.legal}
            style={{ background: span.legal ? stateShade(table, span.state) : 'var(--state-illegal)' }}
          />
        ))}
      </div>
      <figcaption id="ruler-caption" className="ruler-caption">
        <span className="mono">
          tick {report.startTick} &rarr; {report.endTick}
        </span>
        <span className="ruler-caption-sep" aria-hidden="true">
          /
        </span>
        <span>
          {report.ticksElapsed} ticks
          {!report.ok && (
            <>
              <span className="ruler-caption-sep" aria-hidden="true">
                /
              </span>
              <span className="accent">{illegalCount} span(s) illegal</span>
            </>
          )}
        </span>
      </figcaption>
    </figure>
  )
}
