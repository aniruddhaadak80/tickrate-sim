"""Tickrate arithmetic over wall-clock anchors.

A netcode engineer cares about three numbers and none of them are the number the config
claims: the rate the server *actually* achieved, how far that is from the declared rate in
parts per million, and how much the inter-arrival rate wobbles. Jitter is the one that
explains a bug: a server that averages 64 Hz but alternates between 40 Hz and 90 Hz frames
will drop clients that assume a steady budget.

All of it is arithmetic over a handful of integers, which is exactly why it must be code.
A language model asked to compute the drift of 4096 anchors will produce a plausible number
that is not the number.
"""

from __future__ import annotations

from typing import Final, TypedDict

from .model import Table, Trace
from .protocol import EngineError

PRECISION: Final[int] = 4
PPM: Final[int] = 1_000_000

ON_RATE: Final[str] = "on_rate"
DRIFTING: Final[str] = "drifting"
UNDER_ANCHORED: Final[str] = "under_anchored"


class TickrateStats(TypedDict):
    traceId: str
    tableId: str
    declaredHz: int
    tickBudgetMs: float
    effectiveHz: float | None
    driftPpm: int | None
    driftRatio: float | None
    samples: int
    minHz: float | None
    medianHz: float | None
    maxHz: float | None
    jitterHz: float | None
    jitterPpm: int | None
    verdict: str
    note: str


def _require_monotonic(trace: Trace) -> None:
    """Anchors must advance in both tick and wall clock, or the rates below are fiction."""
    anchors = trace["anchors"]
    for index in range(1, len(anchors)):
        previous = anchors[index - 1]
        current = anchors[index]
        if current["tick"] <= previous["tick"]:
            raise EngineError(
                "ANCHOR_NOT_MONOTONIC",
                f"anchors[{index}].tick ({current['tick']}) must exceed "
                f"anchors[{index - 1}].tick ({previous['tick']})",
            )
        if current["ms"] <= previous["ms"]:
            raise EngineError(
                "ANCHOR_NOT_MONOTONIC",
                f"anchors[{index}].ms ({current['ms']}) must exceed "
                f"anchors[{index - 1}].ms ({previous['ms']})",
            )


def _interval_rates(trace: Trace) -> list[float]:
    """Per-interval tick rate in Hz, for each pair of consecutive anchors."""
    anchors = trace["anchors"]
    return [
        (right["tick"] - left["tick"]) * 1000.0 / (right["ms"] - left["ms"])
        for left, right in zip(anchors, anchors[1:], strict=False)
    ]


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _ppm(ratio: float) -> int:
    return int(round(ratio * PPM))


def _under_anchored(table: Table, trace: Trace, budget_ms: float) -> TickrateStats:
    return TickrateStats(
        traceId=trace["id"],
        tableId=table["id"],
        declaredHz=table["tickrateHz"],
        tickBudgetMs=budget_ms,
        effectiveHz=None,
        driftPpm=None,
        driftRatio=None,
        samples=0,
        minHz=None,
        medianHz=None,
        maxHz=None,
        jitterHz=None,
        jitterPpm=None,
        verdict=UNDER_ANCHORED,
        note=(
            f"need at least 2 anchors to measure a rate; "
            f"got {len(trace['anchors'])}"
        ),
    )


def tickrate_stats(table: Table, trace: Trace) -> TickrateStats:
    """Measure the achieved tick rate, drift and jitter from a trace's anchors.

    Fewer than two anchors is reported as `under_anchored` rather than as a confident zero,
    because "no data" and "perfect" must never render as the same number.
    """
    _require_monotonic(trace)
    declared = table["tickrateHz"]
    budget_ms = round(1000.0 / declared, PRECISION)
    rates = _interval_rates(trace)

    if not rates:
        return _under_anchored(table, trace, budget_ms)

    first, last = trace["anchors"][0], trace["anchors"][-1]
    tick_span = last["tick"] - first["tick"]
    ms_span = last["ms"] - first["ms"]
    # Exact values first, rounding only at the point of output. Computing ppm from an
    # already-rounded Hz would compound two roundings into a figure that is wrong by
    # hundreds of ppm - which is the entire magnitude this function exists to report.
    exact_hz = tick_span * 1000.0 / ms_span
    exact_ratio = exact_hz / declared

    min_hz = min(rates)
    max_hz = max(rates)
    exact_jitter = max_hz - min_hz

    return TickrateStats(
        traceId=trace["id"],
        tableId=table["id"],
        declaredHz=declared,
        tickBudgetMs=budget_ms,
        effectiveHz=round(exact_hz, PRECISION),
        driftPpm=_ppm(exact_ratio - 1.0),
        driftRatio=round(exact_ratio, PRECISION),
        samples=len(rates),
        minHz=round(min_hz, PRECISION),
        medianHz=round(_median(rates), PRECISION),
        maxHz=round(max_hz, PRECISION),
        jitterHz=round(exact_jitter, PRECISION),
        jitterPpm=_ppm(exact_jitter / min_hz) if min_hz > 0 else None,
        verdict=ON_RATE if _ppm(exact_ratio - 1.0) == 0 else DRIFTING,
        note=(
            f"effective {round(exact_hz, PRECISION)} Hz against a declared {declared} Hz "
            f"({budget_ms} ms per tick) over {tick_span} ticks in {ms_span} ms"
        ),
    )
