"""The state machine walk. This is the part of tickrate-sim that must never be a model call.

The trace is an observation of what a server *did*. The table is a statement of what it was
*allowed* to do. `replay` walks the trace against the table and reports every place reality
outgrew the declaration.

One decision shapes everything else: **the walk never stops at a violation.** A trace is a
recording of a real run; if a server jumped from `lobby` straight to `live`, that jump
happened, and refusing to model it would make every later tick unreportable. So after an
illegal edge the walk *repairs* by adopting the observed target state and keeps going. The
first violation is still called out separately, because "the first thing that went wrong" is
the only one a human wants; the tail is for tests that must exercise the whole trace.

That repair is why every input yields a total result: replay cannot fail, only report.
"""

from __future__ import annotations

from typing import Final, TypedDict

from .model import (
    RuleId,
    StateName,
    StateSpec,
    Table,
    Trace,
    TraceEvent,
    TransitionRule,
    index_rules_by_position,
    index_states,
)

# Violation codes. Stable strings: they appear in CLI output, MCP results and JSON fixtures.
UNDECLARED_TRANSITION: Final[str] = "UNDECLARED_TRANSITION"
TERMINAL_EXIT: Final[str] = "TERMINAL_EXIT"
UNKNOWN_STATE: Final[str] = "UNKNOWN_STATE"
BUDGET_UNDERRUN: Final[str] = "BUDGET_UNDERRUN"
BUDGET_OVERRUN: Final[str] = "BUDGET_OVERRUN"
NON_MONOTONIC_TICK: Final[str] = "NON_MONOTONIC_TICK"
EVENT_OUT_OF_RANGE: Final[str] = "EVENT_OUT_OF_RANGE"
REPEAT_TRANSITION: Final[str] = "REPEAT_TRANSITION"

#: Tolerance when rounding a frequency to Hz. A 64 Hz tick budget is 15.625 ms, so quoting
#: more precision than this is precision the source data does not contain.
PRECISION: Final[int] = 4


class Violation(TypedDict):
    code: str
    tick: int
    state: StateName
    target: StateName
    rule: RuleId | None
    ticksInState: int
    message: str


class TimelineStep(TypedDict):
    tick: int
    state: StateName
    ticksInState: int
    #: The rule that was satisfied, for display.
    via: RuleId | None
    #: That rule's position in `table.transitions`. Identity, not display: a table may
    #: declare two rules with the same id, and merging their statistics would silently
    #: under-report coverage.
    viaIndex: int | None
    legal: bool


class Coverage(TypedDict):
    declared: int
    exercised: int
    ratio: float
    uncovered: list[RuleId]


class ReplayReport(TypedDict):
    traceId: str
    tableId: str
    ok: bool
    tickrateHz: int
    startTick: int
    endTick: int
    startState: StateName
    endState: StateName
    ticksElapsed: int
    eventsObserved: int
    violations: list[Violation]
    firstViolation: Violation | None
    timeline: list[TimelineStep]
    coverage: Coverage


class BudgetRow(TypedDict):
    rule: RuleId
    #: Position in `table.transitions`. Identity, so two rules sharing an id stay distinct.
    index: int
    source: StateName
    target: StateName
    declaredMin: int
    declaredMax: int | None
    observedCount: int
    observedMin: int | None
    observedMax: int | None
    utilisation: float | None
    verdict: str


class BudgetProfile(TypedDict):
    traceId: str
    tableId: str
    rows: list[BudgetRow]
    overruns: int
    underruns: int
    unused: int


class _Site(TypedDict):
    """Where a violation happened. Bundled so a violation reads as `where` plus `what`."""

    tick: int
    state: StateName
    target: StateName
    rule: RuleId | None
    ticksInState: int


class _Walk(TypedDict):
    """Mutable accumulator. Local to one `replay` call; never escapes it."""

    state: StateName
    enteredAt: int
    lastTick: int
    sawEvent: bool
    timeline: list[TimelineStep]
    violations: list[Violation]
    counts: dict[int, int]


def _violation(code: str, site: _Site, message: str) -> Violation:
    return Violation(
        code=code,
        tick=site["tick"],
        state=site["state"],
        target=site["target"],
        rule=site["rule"],
        ticksInState=site["ticksInState"],
        message=message,
    )


def _new_walk(table: Table, start_tick: int) -> _Walk:
    return _Walk(
        state=table["entry"],
        enteredAt=start_tick,
        lastTick=start_tick,
        sawEvent=False,
        timeline=[
            TimelineStep(
                tick=start_tick,
                state=table["entry"],
                ticksInState=0,
                via=None,
                viaIndex=None,
                legal=True,
            )
        ],
        violations=[],
        counts={},
    )


def _match_rule(
    rules: list[tuple[int, TransitionRule]], target: StateName
) -> tuple[int, TransitionRule] | None:
    for position, rule in rules:
        if rule["target"] == target:
            return position, rule
    return None


def _declared_targets(rules: list[tuple[int, TransitionRule]]) -> list[str]:
    return sorted({rule["target"] for _, rule in rules})


def _ordering_violations(
    walk: _Walk,
    event: TraceEvent,
    start_tick: int,
    end_tick: int,
) -> list[Violation]:
    """Tick-number sanity, checked before the transition itself.

    Order matters here: a trace that goes backwards in time has no meaningful state machine
    at all, so it is reported first and the walk continues from where it was.
    """
    tick = event["tick"]
    target = event["target"]
    state = walk["state"]
    elapsed = tick - walk["enteredAt"]
    site = _Site(
        tick=tick,
        state=state,
        target=target,
        rule=None,
        ticksInState=elapsed,
    )
    problems: list[Violation] = []

    if walk["sawEvent"] and tick < walk["lastTick"]:
        problems.append(
            _violation(
                NON_MONOTONIC_TICK,
                site,
                f"tick {tick} precedes the previous event at tick {walk['lastTick']}; "
                f"a server cannot un-run a tick",
            )
        )
    if tick < start_tick or tick > end_tick:
        problems.append(
            _violation(
                EVENT_OUT_OF_RANGE,
                site,
                f"tick {tick} lies outside the declared window [{start_tick}, {end_tick}]",
            )
        )
    return problems


def _budget_violations(
    rule: TransitionRule,
    ticks_in_state: int,
    seen_before: bool,
    tick: int,
) -> list[Violation]:
    problems: list[Violation] = []
    site = _Site(
        tick=tick,
        state=rule["source"],
        target=rule["target"],
        rule=rule["id"],
        ticksInState=ticks_in_state,
    )

    if seen_before and not rule["repeatable"]:
        problems.append(
            _violation(
                REPEAT_TRANSITION,
                site,
                f"rule {rule['id']!r} is declared once-only but was taken more than once",
            )
        )

    min_ticks = rule["minTicks"]
    if ticks_in_state < min_ticks:
        problems.append(
            _violation(
                BUDGET_UNDERRUN,
                site,
                f"rule {rule['id']!r} requires {min_ticks} tick(s) in {rule['source']!r} "
                f"before it may fire; only {ticks_in_state} elapsed",
            )
        )

    max_ticks = rule["maxTicks"]
    if max_ticks is not None and ticks_in_state > max_ticks:
        problems.append(
            _violation(
                BUDGET_OVERRUN,
                site,
                f"rule {rule['id']!r} allows at most {max_ticks} tick(s) in {rule['source']!r}; "
                f"{ticks_in_state} elapsed",
            )
        )
    return problems


def _apply_event(
    walk: _Walk,
    event: TraceEvent,
    grouped: dict[StateName, list[tuple[int, TransitionRule]]],
    states: dict[StateName, StateSpec],
) -> None:
    """Consume one observed event, appending any violation it causes."""
    tick = event["tick"]
    target = event["target"]
    state = walk["state"]
    ticks_in_state = tick - walk["enteredAt"]
    legal = True

    if target not in states:
        walk["violations"].append(
            _violation(
                UNKNOWN_STATE,
                _Site(
                    tick=tick,
                    state=state,
                    target=target,
                    rule=None,
                    ticksInState=ticks_in_state,
                ),
                f"trace enters state {target!r}, which the table never declares",
            )
        )
        legal = False

    if _is_terminal(state, states):
        walk["violations"].append(
            _violation(
                TERMINAL_EXIT,
                _Site(
                    tick=tick,
                    state=state,
                    target=target,
                    rule=None,
                    ticksInState=ticks_in_state,
                ),
                f"state {state!r} is terminal, so leaving it is not a legal move",
            )
        )
        legal = False

    match = _match_rule(grouped.get(state, []), target)
    if match is None:
        declared = _declared_targets(grouped.get(state, []))
        allowed = ", ".join(repr(name) for name in declared) or "no outgoing transitions"
        walk["violations"].append(
            _violation(
                UNDECLARED_TRANSITION,
                _Site(
                    tick=tick,
                    state=state,
                    target=target,
                    rule=None,
                    ticksInState=ticks_in_state,
                ),
                f"no rule permits {state!r} -> {target!r}; the table allows {allowed}",
            )
        )
        legal = False
    else:
        position, rule = match
        seen_before = walk["counts"].get(position, 0) > 0
        for problem in _budget_violations(rule, ticks_in_state, seen_before, tick):
            walk["violations"].append(problem)
            legal = False
        walk["counts"][position] = walk["counts"].get(position, 0) + 1

    walk["timeline"].append(
        TimelineStep(
            tick=tick,
            state=target,
            ticksInState=ticks_in_state,
            via=match[1]["id"] if match is not None else None,
            viaIndex=match[0] if match is not None else None,
            legal=legal,
        )
    )
    walk["state"] = target
    walk["enteredAt"] = tick
    walk["lastTick"] = tick
    walk["sawEvent"] = True


def _is_terminal(state: StateName, states: dict[StateName, StateSpec]) -> bool:
    """True when the state we are leaving is declared terminal.

    A terminal state that also declares exits is already an `error` in `validate_table`, but
    a server leaving a terminal state is a fact about the server regardless of how the
    table was written, so the walk reports the observation either way.
    """
    spec = states.get(state)
    return spec is not None and bool(spec.get("terminal", False))


def _coverage(table: Table, walk: _Walk) -> Coverage:
    """Which declared edges this trace actually exercised.

    Coverage is the question a trace-regression suite really asks, and it is the one thing a
    replay that stopped at the first violation could not answer. Keyed by rule position, so
    two rules sharing an id are counted as two declared edges - which is what the table says,
    even if `validate_table` also reports the duplicate.
    """
    total = len(table["transitions"])
    uncovered = sorted(
        rule["id"]
        for position, rule in enumerate(table["transitions"])
        if walk["counts"].get(position, 0) == 0
    )
    exercised = total - len(uncovered)
    ratio = round(exercised / total, PRECISION) if total else 0.0
    return Coverage(
        declared=total,
        exercised=exercised,
        ratio=ratio,
        uncovered=uncovered,
    )


def replay(table: Table, trace: Trace) -> ReplayReport:
    """Walk `trace` against `table`, reporting every declared-vs-observed disagreement.

    Pure and total: the same inputs always produce identical JSON, and no input makes it
    raise. `trace.tableId` is deliberately not cross-checked here - a mismatch is a caller
    mistake, and it is reported by the tool layer where a good message can be written.
    """
    walk = _new_walk(table, trace["startTick"])
    grouped = index_rules_by_position(table)
    states = index_states(table)

    for event in trace["events"]:
        walk["violations"].extend(
            _ordering_violations(walk, event, trace["startTick"], trace["endTick"])
        )
        _apply_event(walk, event, grouped, states)

    return ReplayReport(
        traceId=trace["id"],
        tableId=table["id"],
        ok=not walk["violations"],
        tickrateHz=table["tickrateHz"],
        startTick=trace["startTick"],
        endTick=trace["endTick"],
        startState=table["entry"],
        endState=walk["state"],
        ticksElapsed=trace["endTick"] - trace["startTick"],
        eventsObserved=len(trace["events"]),
        violations=walk["violations"],
        firstViolation=walk["violations"][0] if walk["violations"] else None,
        timeline=walk["timeline"],
        coverage=_coverage(table, walk),
    )


class _Observation(TypedDict):
    count: int
    minimum: int | None
    maximum: int | None


def _observations(report: ReplayReport) -> dict[int, _Observation]:
    """Fold the timeline into per-rule tick-count statistics, keyed by rule position.

    Derived from the timeline rather than tracked during the walk, so `budget_profile`
    cannot disagree with `replay` about what happened.
    """
    stats: dict[int, _Observation] = {}
    for step in report["timeline"]:
        position = step["viaIndex"]
        if position is None:
            continue
        ticks = step["ticksInState"]
        entry = stats.get(position)
        if entry is None:
            stats[position] = _Observation(count=1, minimum=ticks, maximum=ticks)
            continue
        entry["count"] += 1
        entry["minimum"] = ticks if entry["minimum"] is None else min(entry["minimum"], ticks)
        entry["maximum"] = ticks if entry["maximum"] is None else max(entry["maximum"], ticks)
    return stats


def _counts_by_code(report: ReplayReport) -> dict[str, int]:
    counts: dict[str, int] = {}
    for violation in report["violations"]:
        counts[violation["code"]] = counts.get(violation["code"], 0) + 1
    return counts


def _verdict(
    observed_count: int,
    observed_max: int | None,
    declared_min: int,
    declared_max: int | None,
) -> str:
    if observed_count == 0:
        return "unused"
    if declared_max is not None and observed_max is not None and observed_max > declared_max:
        return "slower_than_declared"
    if observed_max is not None and observed_max < declared_min:
        return "faster_than_declared"
    return "within_budget"


def _utilisation(observed_max: int | None, declared_max: int | None) -> float | None:
    """How much of the declared allowance the worst observed run consumed.

    `None` when the question is unanswerable - an unbounded rule has no allowance, and a
    rule never taken has no observation. Reporting 0.0 in either case would be a number
    that reads like a fact and is not one.
    """
    if observed_max is None or declared_max is None or declared_max <= 0:
        return None
    return round(observed_max / declared_max, PRECISION)


def budget_profile(table: Table, trace: Trace) -> BudgetProfile:
    """Per-rule budget accounting: declared bounds against observed tick counts.

    Separate from `replay` because the question is different. `replay` asks "did this run
    break the contract?"; this asks "how close to the edge does this run run?" - which is
    how you find a `minTicks` of 3 where production always takes 3, and a `maxTicks` of 600
    where nothing has ever exceeded 40.
    """
    report = replay(table, trace)
    stats = _observations(report)
    codes = _counts_by_code(report)

    rows: list[BudgetRow] = []
    unused = 0

    for position, rule in enumerate(table["transitions"]):
        rule_id = rule["id"]
        observed = stats.get(position)
        observed_count = observed["count"] if observed is not None else 0
        observed_min = observed["minimum"] if observed is not None else None
        observed_max = observed["maximum"] if observed is not None else None
        declared_max = rule["maxTicks"]
        if observed_count == 0:
            unused += 1

        rows.append(
            BudgetRow(
                rule=rule_id,
                index=position,
                source=rule["source"],
                target=rule["target"],
                declaredMin=rule["minTicks"],
                declaredMax=declared_max,
                observedCount=observed_count,
                observedMin=observed_min,
                observedMax=observed_max,
                utilisation=_utilisation(observed_max, declared_max),
                verdict=_verdict(observed_count, observed_max, rule["minTicks"], declared_max),
            )
        )

    return BudgetProfile(
        traceId=trace["id"],
        tableId=table["id"],
        rows=rows,
        overruns=codes.get(BUDGET_OVERRUN, 0),
        underruns=codes.get(BUDGET_UNDERRUN, 0),
        unused=unused,
    )
