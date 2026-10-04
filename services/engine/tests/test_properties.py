"""Property-based tests for the invariants the engine must never break.

These are the assertions a reviewer should not have to take on trust. Each one is a property
that holds for *every* input, not a fact about the fixtures above.

    determinism      - the same input always produces the same output
    totality         - replay reports, it never raises
    coverage bounds  - 0 <= ratio <= 1 and exercised + uncovered == declared
    repair           - the walk always ends in the last observed state
    budget integrity - observed bounds are within the ticks the walk actually saw
    diff idempotence - a table never differs from itself
    diff symmetry    - added and removed swap when the order is reversed
    non-regression   - relaxing a budget never marks a change breaking
"""

from __future__ import annotations

import json
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from tickrate_sim import Table, Trace, budget_profile, diff_tables, parse_table, parse_trace, replay
from tickrate_sim import validate_table
from tickrate_sim.diffing import ADDED, MODIFIED, REMOVED

STATE_NAMES = st.sampled_from(["a", "b", "c", "d"])

states = st.lists(
    st.builds(lambda name, terminal: {"name": name, "terminal": terminal}, STATE_NAMES, st.booleans()),
    min_size=1,
    max_size=4,
    unique_by=lambda state: state["name"],
)

transitions = st.lists(
    st.fixed_dictionaries(
        {
            "id": st.text(alphabet="abcdefghijklmnopqrstuvwxyz", min_size=1, max_size=6),
            "source": STATE_NAMES,
            "target": STATE_NAMES,
            "minTicks": st.integers(min_value=0, max_value=20),
            "maxTicks": st.one_of(st.none(), st.integers(min_value=0, max_value=40)),
            "repeatable": st.booleans(),
        }
    ),
    max_size=6,
)

tables = st.builds(
    lambda states_, transitions_, entry, tickrate: {
        "id": "generated",
        "tickrateHz": tickrate,
        "entry": entry,
        "states": states_,
        "transitions": transitions_,
    },
    states,
    transitions,
    STATE_NAMES,
    st.sampled_from([32, 64, 128]),
)

events = st.lists(
    st.fixed_dictionaries(
        {"tick": st.integers(min_value=0, max_value=500), "target": STATE_NAMES}
    ),
    max_size=8,
)

anchors = st.lists(
    st.fixed_dictionaries(
        {"tick": st.integers(min_value=0, max_value=1000), "ms": st.integers(min_value=0, max_value=5000)}
    ),
    max_size=6,
)

traces = st.builds(
    lambda id_, start, end, events_, anchors_: {
        "id": id_,
        "tableId": "generated",
        "startTick": start,
        "endTick": end,
        "events": events_,
        "anchors": anchors_,
    },
    st.text(alphabet="abcdefgh", min_size=1, max_size=5),
    st.integers(min_value=0, max_value=100),
    st.integers(min_value=100, max_value=1000),
    events,
    anchors,
)

SETTINGS = settings(max_examples=150, deadline=None)

#: Edges as distinct pairs, with ids drawn to be distinct too. Together they guarantee no two
#: rules share an id *or* an edge - which is exactly what `validate_table` requires before a
#: subject in the diff is unambiguous. Property tests should target the documented contract.
edges = st.lists(
    st.tuples(STATE_NAMES, STATE_NAMES),
    min_size=0,
    max_size=6,
    unique=True,
)

rule_ids = st.lists(
    st.text(alphabet="abcdefgh", min_size=1, max_size=4),
    min_size=6,
    max_size=6,
    unique=True,
)

budgets = st.integers(min_value=0, max_value=20)

caps = st.one_of(st.none(), st.integers(min_value=0, max_value=40))

valid_tables = st.builds(
    lambda states_, edges_, ids_, entry, tickrate: {
        "id": "generated",
        "tickrateHz": tickrate,
        "entry": entry,
        "states": states_,
        "transitions": [
            {
                "id": ids_[index],
                "source": source,
                "target": target,
                "minTicks": 0,
                "maxTicks": None,
                "repeatable": True,
            }
            for index, (source, target) in enumerate(edges_)
        ],
    },
    states,
    edges,
    rule_ids,
    STATE_NAMES,
    st.sampled_from([32, 64, 128]),
)


def load(table_doc: dict[str, Any], trace_doc: dict[str, Any]) -> tuple[Table, Trace]:
    return parse_table(table_doc), parse_trace(trace_doc)


@SETTINGS
@given(tables, traces)
def test_replay_is_deterministic(table_doc: dict[str, Any], trace_doc: dict[str, Any]) -> None:
    table, trace = load(table_doc, trace_doc)
    first = json.dumps(replay(table, trace), sort_keys=True)
    second = json.dumps(replay(table, trace), sort_keys=True)
    assert first == second


@SETTINGS
@given(tables, traces)
def test_replay_never_raises(table_doc: dict[str, Any], trace_doc: dict[str, Any]) -> None:
    table, trace = load(table_doc, trace_doc)
    report = replay(table, trace)
    assert isinstance(report["violations"], list)


@SETTINGS
@given(tables, traces)
def test_the_walk_ends_in_the_last_observed_state(
    table_doc: dict[str, Any], trace_doc: dict[str, Any]
) -> None:
    table, trace = load(table_doc, trace_doc)
    report = replay(table, trace)
    expected = trace["events"][-1]["target"] if trace["events"] else table["entry"]
    assert report["endState"] == expected


@SETTINGS
@given(tables, traces)
def test_the_timeline_has_one_step_per_event_plus_the_entry(
    table_doc: dict[str, Any], trace_doc: dict[str, Any]
) -> None:
    table, trace = load(table_doc, trace_doc)
    report = replay(table, trace)
    assert len(report["timeline"]) == len(trace["events"]) + 1
    assert report["eventsObserved"] == len(trace["events"])


@SETTINGS
@given(tables, traces)
def test_a_clean_walk_reports_no_violations(
    table_doc: dict[str, Any], trace_doc: dict[str, Any]
) -> None:
    table, trace = load(table_doc, trace_doc)
    report = replay(table, trace)
    assert (report["violations"] == []) == report["ok"]
    assert (report["firstViolation"] is None) == report["ok"]


@SETTINGS
@given(tables, traces)
def test_coverage_is_a_bounded_partition(table_doc: dict[str, Any], trace_doc: dict[str, Any]) -> None:
    table, trace = load(table_doc, trace_doc)
    coverage = replay(table, trace)["coverage"]
    assert 0.0 <= coverage["ratio"] <= 1.0
    assert coverage["exercised"] + len(coverage["uncovered"]) == coverage["declared"]
    assert coverage["declared"] == len(table["transitions"])
    assert coverage["uncovered"] == sorted(coverage["uncovered"])


@SETTINGS
@given(tables, traces)
def test_the_budget_profile_agrees_with_the_walk(
    table_doc: dict[str, Any], trace_doc: dict[str, Any]
) -> None:
    table, trace = load(table_doc, trace_doc)
    report = replay(table, trace)
    profile = budget_profile(table, trace)
    for row in profile["rows"]:
        steps = [step for step in report["timeline"] if step["viaIndex"] == row["index"]]
        assert row["observedCount"] == len(steps)
        if steps:
            ticks = [step["ticksInState"] for step in steps]
            assert row["observedMin"] == min(ticks)
            assert row["observedMax"] == max(ticks)


@SETTINGS
@given(traces)
def test_rules_sharing_an_id_stay_counted_separately(trace_doc: dict[str, Any]) -> None:
    """Two rules with one id are two declared edges, and coverage must count both.

    `validate_table` reports the duplicate as an error, but the walk still has to keep them
    apart: merging their statistics would under-report coverage, which is the one failure a
    trace-regression suite cannot notice. The table is fixed rather than generated so the
    duplicate is guaranteed rather than filtered for.
    """
    table = parse_table(
        {
            "id": "generated",
            "tickrateHz": 64,
            "entry": "a",
            "states": [{"name": "a"}, {"name": "b"}],
            "transitions": [
                {"id": "dup", "source": "a", "target": "b", "maxTicks": None},
                {"id": "dup", "source": "b", "target": "a", "maxTicks": None},
            ],
        }
    )
    trace = parse_trace(trace_doc)
    coverage = replay(table, trace)["coverage"]
    assert coverage["declared"] == 2
    assert coverage["exercised"] + len(coverage["uncovered"]) == 2
    profile = budget_profile(table, trace)
    assert [row["index"] for row in profile["rows"]] == [0, 1]


@SETTINGS
@given(tables)
def test_a_table_never_differs_from_itself(table_doc: dict[str, Any]) -> None:
    table = parse_table(table_doc)
    diff = diff_tables(table, table)
    assert diff["changes"] == []
    assert diff["breaking"] == []
    assert diff["compatible"] is True


@SETTINGS
@given(valid_tables, valid_tables)
def test_diff_swaps_added_and_removed(left: dict[str, Any], right: dict[str, Any]) -> None:
    forward = diff_tables(parse_table(left), parse_table(right))
    backward = diff_tables(parse_table(right), parse_table(left))
    assert forward["rulesAdded"] == backward["rulesRemoved"]
    assert forward["rulesRemoved"] == backward["rulesAdded"]
    assert forward["statesAdded"] == backward["statesRemoved"]
    assert forward["statesRemoved"] == backward["statesAdded"]
    assert forward["unchanged"] == backward["unchanged"]
    # `rulesChanged` is deliberately *not* compared: it names rules by their id in the new
    # revision, so renaming a rule changes the name the diff reports. What must match is the
    # set of edges involved, with added and removed swapped.
    assert sorted(change["kind"] for change in forward["changes"]).count(ADDED) == sorted(
        change["kind"] for change in backward["changes"]
    ).count(REMOVED)
    assert sorted(change["kind"] for change in forward["changes"]).count(REMOVED) == sorted(
        change["kind"] for change in backward["changes"]
    ).count(ADDED)
    assert sorted(change["kind"] for change in forward["changes"]).count(MODIFIED) == sorted(
        change["kind"] for change in backward["changes"]
    ).count(MODIFIED)


@SETTINGS
@given(valid_tables, valid_tables)
def test_a_subject_is_breaking_in_at_most_one_direction(
    left: dict[str, Any], right: dict[str, Any]
) -> None:
    """`breaking` names "rejects input that used to pass", which is a one-way relation.

    Tightening a budget breaks the old table; loosening it again does not break the new one.
    A subject cannot be breaking both ways, because that would mean neither revision rejects
    anything the other accepted. Asserted over tables whose rules have distinct ids and
    distinct edges, which is the contract `diff_tables` documents for subject uniqueness.
    """
    forward = diff_tables(parse_table(left), parse_table(right))
    backward = diff_tables(parse_table(right), parse_table(left))
    assert not (set(forward["breaking"]) & set(backward["breaking"]))


@SETTINGS
@given(tables)
def test_validation_is_deterministic_and_never_raises(table_doc: dict[str, Any]) -> None:
    table = parse_table(table_doc)
    assert validate_table(table) == validate_table(table)


@SETTINGS
@given(tables, st.integers(min_value=0, max_value=20))
def test_lowering_a_floor_is_never_breaking_by_itself(
    table_doc: dict[str, Any], reduction: int
) -> None:
    """Lowering `minTicks` accepts strictly more traces, so it cannot reject one.

    Scoped to changes where `maxTicks` did not move, because a change that lowers the floor
    *and* caps the ceiling is breaking for the second reason and would prove nothing here.
    """
    relaxed = {
        **table_doc,
        "transitions": [
            {**rule, "minTicks": max(0, rule["minTicks"] - reduction)}
            for rule in table_doc["transitions"]
        ],
    }
    diff = diff_tables(parse_table(table_doc), parse_table(relaxed))
    for change in diff["changes"]:
        if change["kind"] != MODIFIED or "minTicks" not in change["fields"]:
            continue
        before = change["before"]
        after = change["after"]
        if after["minTicks"] < before["minTicks"] and after["maxTicks"] == before["maxTicks"]:
            assert not change["breaking"], change


@SETTINGS
@given(tables, st.integers(min_value=1, max_value=20))
def test_raising_a_floor_is_always_breaking_by_itself(
    table_doc: dict[str, Any], raise_by: int
) -> None:
    """The mirror of the property above: a higher floor rejects traces that used to pass."""
    raised = {
        **table_doc,
        "transitions": [
            {**rule, "minTicks": rule["minTicks"] + raise_by} for rule in table_doc["transitions"]
        ],
    }
    diff = diff_tables(parse_table(table_doc), parse_table(raised))
    checked = 0
    for change in diff["changes"]:
        if change["kind"] != MODIFIED or "minTicks" not in change["fields"]:
            continue
        before = change["before"]
        after = change["after"]
        if after["minTicks"] > before["minTicks"] and after["maxTicks"] == before["maxTicks"]:
            assert change["breaking"], change
            checked += 1
    # The strategy always shifts every rule, so at least one change must have been examined.
    assert len(table_doc["transitions"]) == 0 or checked > 0
