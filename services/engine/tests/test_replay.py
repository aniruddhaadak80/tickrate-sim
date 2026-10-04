"""The state machine walk: the part that must be exactly right."""

from __future__ import annotations

import json

import pytest

from tickrate_sim import ReplayReport, Table, Trace, budget_profile, parse_table, replay
from tickrate_sim.replay import (
    BUDGET_OVERRUN,
    BUDGET_UNDERRUN,
    EVENT_OUT_OF_RANGE,
    NON_MONOTONIC_TICK,
    REPEAT_TRANSITION,
    TERMINAL_EXIT,
    UNDECLARED_TRANSITION,
    UNKNOWN_STATE,
)

from conftest import empty_trace, make_trace

# A three-state table with a hard deadline, so every budget rule is reachable in one test.
SIMPLE: dict[str, object] = {
    "id": "simple",
    "tickrateHz": 64,
    "entry": "idle",
    "states": [
        {"name": "idle"},
        {"name": "working"},
        {"name": "done", "terminal": True},
    ],
    "transitions": [
        {"id": "start", "source": "idle", "target": "working", "minTicks": 10, "maxTicks": 10},
        {"id": "finish", "source": "working", "target": "done", "maxTicks": None},
    ],
}


@pytest.fixture(scope="module")
def simple() -> Table:

    return parse_table(SIMPLE)


def violation_codes(report: ReplayReport) -> list[str]:
    return [item["code"] for item in report["violations"]]


class TestLegalWalks:
    def test_an_empty_trace_is_legal_and_covers_nothing(self, simple: Table) -> None:
        report = replay(simple, empty_trace("simple"))
        assert report["ok"] is True
        assert report["violations"] == []
        assert report["endState"] == "idle"
        assert report["coverage"]["ratio"] == 0.0
        assert report["coverage"]["uncovered"] == ["finish", "start"]

    def test_a_walk_within_budget_is_clean(self, simple: Table) -> None:
        trace = make_trace("ok", "simple", [(10, "working"), (60, "done")])
        report = replay(simple, trace)
        assert report["ok"] is True
        assert report["endState"] == "done"
        assert report["coverage"] == {
            "declared": 2,
            "exercised": 2,
            "ratio": 1.0,
            "uncovered": [],
        }

    def test_ticks_in_state_is_measured_from_the_previous_transition(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(10, "working"), (35, "done")])
        report = replay(simple, trace)
        assert [step["ticksInState"] for step in report["timeline"]] == [0, 10, 25]

    def test_timeline_names_the_rule_that_was_satisfied(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(10, "working")])
        steps = replay(simple, trace)["timeline"]
        assert steps[0]["via"] is None
        assert steps[1]["via"] == "start"
        assert steps[1]["legal"] is True


class TestIllegalWalks:
    def test_an_edge_the_table_never_declared_is_rejected(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(5, "done")])
        report = replay(simple, trace)
        assert violation_codes(report) == [UNDECLARED_TRANSITION]
        first = report["firstViolation"]
        assert first is not None
        assert first["state"] == "idle"
        assert first["target"] == "done"
        assert first["rule"] is None
        assert "no rule permits" in first["message"]

    def test_the_illegal_message_lists_what_was_allowed_instead(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(10, "working"), (12, "idle")])
        first = replay(simple, trace)["firstViolation"]
        assert first is not None
        assert "'done'" in first["message"]

    def test_firing_too_early_is_an_underrun(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(9, "working")])
        report = replay(simple, trace)
        assert violation_codes(report) == [BUDGET_UNDERRUN]
        first = report["firstViolation"]
        assert first is not None
        assert first["rule"] == "start"
        assert first["ticksInState"] == 9

    def test_firing_too_late_is_an_overrun(self) -> None:

        table = parse_table(
            {
                **SIMPLE,
                "transitions": [
                    {"id": "start", "source": "idle", "target": "working", "maxTicks": 5},
                    {"id": "finish", "source": "working", "target": "done", "maxTicks": None},
                ],
            }
        )
        report = replay(table, make_trace("t", "simple", [(6, "working")]))
        assert violation_codes(report) == [BUDGET_OVERRUN]
        first = report["firstViolation"]
        assert first is not None
        assert first["ticksInState"] == 6

    def test_an_unbounded_rule_never_overruns(self, simple: Table) -> None:
        trace = make_trace(
            "t", "simple", [(10, "working"), (100_000, "done")], end_tick=100_000
        )
        assert replay(simple, trace)["ok"] is True

    def test_leaving_a_terminal_state_is_reported(self) -> None:

        table = parse_table(
            {
                "id": "simple",
                "tickrateHz": 64,
                "entry": "idle",
                "states": [{"name": "idle"}, {"name": "done", "terminal": True}],
                "transitions": [{"id": "finish", "source": "idle", "target": "done"}],
            }
        )
        trace = make_trace("t", "simple", [(1, "done"), (2, "idle")])
        report = replay(table, trace)
        assert violation_codes(report) == [TERMINAL_EXIT, UNDECLARED_TRANSITION]
        assert report["firstViolation"] is not None
        assert report["firstViolation"]["code"] == TERMINAL_EXIT

    def test_an_undeclared_state_in_the_trace_is_reported(self, simple: Table) -> None:
        report = replay(simple, make_trace("t", "simple", [(10, "working"), (20, "nowhere")]))
        assert UNKNOWN_STATE in violation_codes(report)

    def test_a_once_only_rule_taken_twice_is_reported(self) -> None:

        document = {
            "id": "loop",
            "tickrateHz": 64,
            "entry": "idle",
            "states": [{"name": "idle"}, {"name": "working"}],
            "transitions": [
                {"id": "start", "source": "idle", "target": "working", "repeatable": False},
                {"id": "stop", "source": "working", "target": "idle", "maxTicks": None},
            ],
        }
        report = replay(parse_table(document), make_trace(
            "t", "loop", [(1, "working"), (2, "idle"), (3, "working")]
        ))
        assert violation_codes(report) == [REPEAT_TRANSITION]

    def test_ticks_going_backwards_are_reported(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(10, "working"), (5, "done")])
        report = replay(simple, trace)
        assert NON_MONOTONIC_TICK in violation_codes(report)
        first = report["firstViolation"]
        assert first is not None
        assert "cannot un-run a tick" in first["message"]

    def test_an_event_outside_the_declared_window_is_reported(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(10, "working"), (5000, "done")], end_tick=1000)
        assert EVENT_OUT_OF_RANGE in violation_codes(replay(simple, trace))

    def test_violations_accumulate_in_tick_order(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(3, "working"), (4, "idle"), (5, "working")])
        report = replay(simple, trace)
        assert violation_codes(report) == [
            BUDGET_UNDERRUN,
            UNDECLARED_TRANSITION,
            BUDGET_UNDERRUN,
        ]
        assert report["firstViolation"] is not None
        assert report["firstViolation"]["tick"] == 3


class TestTotality:
    """The walk repairs and continues, so no input can make it fail."""

    def test_every_illegal_jump_is_reported_not_just_the_first(
        self, simple: Table
    ) -> None:
        # `idle -> done` is undeclared, so all three jumps are violations.
        trace = make_trace("t", "simple", [(1, "done"), (2, "idle"), (3, "done")])
        report = replay(simple, trace)
        undeclared = [
            item for item in report["violations"] if item["code"] == UNDECLARED_TRANSITION
        ]
        assert len(undeclared) == 3
        assert [item["tick"] for item in undeclared] == [1, 2, 3]

    def test_the_walk_adopts_the_observed_state_so_later_ticks_stay_reportable(
        self, simple: Table
    ) -> None:
        trace = make_trace("t", "simple", [(1, "done"), (2, "idle"), (10, "working")])
        report = replay(simple, trace)
        # The illegal jump is repaired, so the next legal edge is still matched and judged.
        assert [step["via"] for step in report["timeline"]] == [None, None, None, "start"]
        assert report["endState"] == "working"
        assert report["eventsObserved"] == 3

    def test_replay_is_json_serialisable_and_byte_stable(
        self, skirmish: Table, traces: dict[str, Trace]
    ) -> None:
        for trace in traces.values():
            first = json.dumps(replay(skirmish, trace), sort_keys=False)
            second = json.dumps(replay(skirmish, trace), sort_keys=False)
            assert first == second

    def test_replay_never_raises_on_any_shipped_trace(
        self, skirmish: Table, traces: dict[str, Trace]
    ) -> None:
        for trace in traces.values():
            assert replay(skirmish, trace)["tableId"] == "skirmish-64"


class TestBudgetProfile:
    def test_reports_observed_against_declared(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(12, "working"), (60, "done")])
        rows = {row["rule"]: row for row in budget_profile(simple, trace)["rows"]}
        assert rows["start"]["declaredMin"] == 10
        assert rows["start"]["observedMin"] == 12
        # The window is 10..10 and 12 ticks were spent, so the rule is over budget.
        assert rows["start"]["verdict"] == "slower_than_declared"
        assert rows["start"]["utilisation"] == 1.2

    def test_an_unused_rule_has_no_observation_and_says_so(self, simple: Table) -> None:
        rows = {row["rule"]: row for row in budget_profile(simple, empty_trace("simple"))["rows"]}
        assert rows["start"]["verdict"] == "unused"
        assert rows["start"]["observedCount"] == 0
        assert rows["start"]["observedMin"] is None
        assert rows["start"]["utilisation"] is None

    def test_an_unbounded_rule_reports_no_utilisation(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(10, "working"), (900, "done")])
        rows = {row["rule"]: row for row in budget_profile(simple, trace)["rows"]}
        assert rows["finish"]["declaredMax"] is None
        assert rows["finish"]["utilisation"] is None

    def test_counts_overruns_and_underruns_separately(self, simple: Table) -> None:
        trace = make_trace("t", "simple", [(1, "working"), (2, "done")])
        profile = budget_profile(simple, trace)
        assert profile["underruns"] >= 1
        assert profile["overruns"] == 0

    def test_every_declared_rule_appears_exactly_once(self, skirmish: Table, traces: dict[str, Trace]) -> None:
        for trace in traces.values():
            rows = budget_profile(skirmish, trace)["rows"]
            assert [row["rule"] for row in rows] == [
                rule["id"] for rule in skirmish["transitions"]
            ]

    def test_unused_counts_the_rules_a_trace_never_takes(
        self, skirmish: Table, traces: dict[str, Trace]
    ) -> None:
        profile = budget_profile(skirmish, traces["clean-64hz"])
        assert profile["unused"] == 3
        assert profile["overruns"] == 0
        assert profile["underruns"] == 0
