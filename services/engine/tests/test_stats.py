"""Tickrate arithmetic: effective rate, drift in ppm, and jitter."""

from __future__ import annotations

import pytest

from tickrate_sim import Table, Trace, tickrate_stats
from tickrate_sim.protocol import EngineError

from conftest import make_trace

MS_PER_TICK = 1000.0 / 64.0


def anchors(pairs: list[tuple[int, int]]) -> list[dict[str, int]]:
    return [{"tick": tick, "ms": ms} for tick, ms in pairs]


def even_anchors(count: int = 10) -> list[dict[str, int]]:
    """One anchor per 64 ticks of a perfectly on-rate 64 Hz server."""
    return anchors([(index * 64, int(round(index * 64 * MS_PER_TICK))) for index in range(count)])


class TestEffectiveRate:
    def test_a_perfect_server_reports_exactly_its_declared_rate(
        self, skirmish: Table
    ) -> None:
        stats = tickrate_stats(skirmish, make_trace("t", "skirmish-64", [], anchors=even_anchors()))
        assert stats["effectiveHz"] == 64.0
        assert stats["driftPpm"] == 0
        assert stats["driftRatio"] == 1.0
        assert stats["verdict"] == "on_rate"

    def test_a_slow_server_reports_negative_drift(self, skirmish: Table) -> None:
        trace = make_trace("t", "skirmish-64", [], anchors=anchors([(0, 0), (1000, 17241)]))
        stats = tickrate_stats(skirmish, trace)
        assert stats["effectiveHz"] == pytest.approx(58.0008, abs=1e-3)
        assert stats["driftPpm"] == -93_730
        assert stats["driftRatio"] is not None and stats["driftRatio"] < 1.0
        assert stats["verdict"] == "drifting"

    def test_the_tick_budget_is_quoted_in_milliseconds(self, skirmish: Table) -> None:
        stats = tickrate_stats(skirmish, make_trace("t", "skirmish-64", [], anchors=even_anchors()))
        assert stats["tickBudgetMs"] == 15.625

    def test_the_note_names_both_rates(self, skirmish: Table) -> None:
        stats = tickrate_stats(skirmish, make_trace("t", "skirmish-64", [], anchors=even_anchors()))
        assert "64 Hz" in stats["note"]
        assert "15.625 ms" in stats["note"]


class TestJitter:
    def test_jitter_is_the_spread_of_interval_rates_not_of_the_mean(
        self, skirmish: Table
    ) -> None:
        # Every 4 ticks of a 64 Hz server is 62.5 ms. Alternating 50 ms and 75 ms gaps average
        # to exactly that, so the mean is perfect while no interval is.
        trace = make_trace(
            "j",
            "skirmish-64",
            [],
            anchors=anchors([(0, 0), (4, 50), (8, 125), (12, 175), (16, 250)]),
        )
        stats = tickrate_stats(skirmish, trace)
        assert stats["minHz"] == pytest.approx(53.3333, abs=1e-3)
        assert stats["maxHz"] == pytest.approx(80.0, abs=1e-3)
        assert stats["effectiveHz"] == 64.0
        assert stats["driftPpm"] == 0
        assert stats["jitterHz"] == pytest.approx(26.6667, abs=1e-3)
        assert stats["jitterPpm"] == 500_000

    def test_a_steady_server_has_zero_jitter(self, skirmish: Table) -> None:
        stats = tickrate_stats(skirmish, make_trace("t", "skirmish-64", [], anchors=even_anchors()))
        assert stats["jitterHz"] == 0.0
        assert stats["jitterPpm"] == 0

    def test_the_median_of_an_odd_number_of_samples_is_the_middle_one(
        self, skirmish: Table
    ) -> None:
        trace = make_trace(
            "t", "skirmish-64", [], anchors=anchors([(0, 0), (30, 300), (60, 450), (90, 550)])
        )
        stats = tickrate_stats(skirmish, trace)
        # Interval rates: 100 Hz, 200 Hz, 300 Hz -> middle is 200.
        assert stats["medianHz"] == 200.0

    def test_the_median_of_an_even_number_of_samples_is_the_mean_of_the_middle_two(
        self, skirmish: Table
    ) -> None:
        trace = make_trace(
            "t",
            "skirmish-64",
            [],
            anchors=anchors([(0, 0), (30, 300), (60, 450), (90, 550), (120, 625)]),
        )
        stats = tickrate_stats(skirmish, trace)
        # Interval rates: 100, 200, 300, 400 -> middle two are 200 and 300.
        assert stats["medianHz"] == 250.0


class TestInsufficientData:
    def test_no_anchors_is_reported_as_no_data_not_as_zero(self, skirmish: Table) -> None:
        stats = tickrate_stats(skirmish, make_trace("t", "skirmish-64", []))
        assert stats["verdict"] == "under_anchored"
        assert stats["effectiveHz"] is None
        assert stats["driftPpm"] is None
        assert stats["jitterHz"] is None
        assert "at least 2 anchors" in stats["note"]

    def test_one_anchor_is_still_no_data(self, skirmish: Table) -> None:
        stats = tickrate_stats(skirmish, make_trace("t", "skirmish-64", [], anchors=anchors([(0, 0)])))
        assert stats["verdict"] == "under_anchored"
        assert stats["samples"] == 0


class TestAnchorValidation:
    @pytest.mark.parametrize(
        "bad",
        [
            [(0, 0), (64, 0)],
            [(0, 100), (64, 50)],
            [(64, 0), (0, 100)],
            [(0, 0), (0, 100)],
        ],
    )
    def test_non_monotonic_anchors_are_rejected(self, skirmish: Table, bad: list[tuple[int, int]]) -> None:
        with pytest.raises(EngineError) as caught:
            tickrate_stats(skirmish, make_trace("t", "skirmish-64", [], anchors=anchors(bad)))
        assert caught.value.code == "ANCHOR_NOT_MONOTONIC"

    def test_the_error_names_the_offending_index(self, skirmish: Table) -> None:
        with pytest.raises(EngineError) as caught:
            tickrate_stats(
                skirmish,
                make_trace("t", "skirmish-64", [], anchors=anchors([(0, 0), (10, 10), (5, 20)])),
            )
        assert "anchors[2]" in caught.value.message


class TestShippedTraces:
    def test_the_drift_case_reports_drift(self, skirmish: Table, traces: dict[str, Trace]) -> None:
        stats = tickrate_stats(skirmish, traces["tick-drift"])
        assert stats["verdict"] == "drifting"
        # Per-anchor millisecond rounding makes this a few ppm away from the ideal 58 Hz
        # figure, which is exactly why drift is reported in ppm rather than to the nearest Hz.
        assert stats["driftPpm"] == -93_738

    def test_the_jitter_case_is_on_rate_but_wobbles(self, skirmish: Table, traces: dict[str, Trace]) -> None:
        stats = tickrate_stats(skirmish, traces["jittery-frames"])
        assert stats["driftPpm"] == 0
        assert stats["jitterHz"] is not None and stats["jitterHz"] > 20

    def test_every_shipped_trace_with_anchors_measures_something(
        self, skirmish: Table, traces: dict[str, Trace]
    ) -> None:
        for trace in traces.values():
            assert tickrate_stats(skirmish, trace)["declaredHz"] == 64
