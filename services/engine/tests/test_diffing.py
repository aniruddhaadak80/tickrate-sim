"""Diffing two revisions of a table, and which changes make a passing trace fail."""

from __future__ import annotations

from typing import Any

import pytest

from tickrate_sim import Table, TableChange, TableDiff, diff_tables, parse_table


def change_for(diff: TableDiff, subject: str) -> TableChange:
    return next(change for change in diff["changes"] if change["subject"] == subject)


def table_with(**overrides: Any) -> Table:
    document: dict[str, Any] = {
        "id": "t",
        "tickrateHz": 64,
        "entry": "a",
        "states": [{"name": "a"}, {"name": "b"}, {"name": "z", "terminal": True}],
        "transitions": [
            {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10},
            {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
        ],
    }
    document.update(overrides)
    return parse_table(document)


class TestNoChange:
    def test_a_table_diffed_against_itself_is_empty(self) -> None:
        diff = diff_tables(table_with(), table_with())
        assert diff["changes"] == []
        assert diff["breaking"] == []
        assert diff["compatible"] is True
        assert diff["unchanged"] == 2
        assert diff["tickrateChanged"] is False

    def test_diffing_is_idempotent_under_repetition(self) -> None:
        base = table_with()
        assert diff_tables(base, base) == diff_tables(base, base)


class TestBreakingChanges:
    def test_raising_a_floor_rejects_old_traces(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 5, "maxTicks": 10},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
            ]
        )
        diff = diff_tables(table_with(), after)
        assert diff["compatible"] is False
        assert diff["breaking"] == ["rule:a->b (ab)"]
        assert change_for(diff, "rule:a->b (ab)")["reason"].startswith("minTicks moved from 0 to 5")

    def test_lowering_a_ceiling_rejects_old_traces(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 4},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
            ]
        )
        assert diff_tables(table_with(), after)["breaking"] == ["rule:a->b (ab)"]

    def test_putting_a_ceiling_on_an_unbounded_rule_is_breaking(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": 100},
            ]
        )
        assert diff_tables(table_with(), after)["breaking"] == ["rule:b->z (bz)"]

    def test_removing_an_edge_is_breaking(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10},
            ]
        )
        diff = diff_tables(table_with(), after)
        assert diff["rulesRemoved"] == ["bz"]
        assert "UNDECLARED_TRANSITION" in change_for(diff, "rule:b->z (bz)")["reason"]
        assert diff["breaking"] == ["rule:b->z (bz)"]

    def test_removing_a_state_is_breaking(self) -> None:
        after = table_with(states=[{"name": "a"}, {"name": "b"}])
        diff = diff_tables(table_with(), after)
        assert diff["statesRemoved"] == ["z"]
        assert "UNKNOWN_STATE" in change_for(diff, "state:z")["reason"]
        assert diff["breaking"] == ["state:z"]


class TestRelaxingChanges:
    def test_lowering_a_floor_is_not_breaking(self) -> None:
        before = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 5, "maxTicks": 10},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
            ]
        )
        diff = diff_tables(before, table_with())
        assert diff["compatible"] is True
        assert diff["rulesChanged"] == ["ab"]
        assert "widened" in change_for(diff, "rule:a->b (ab)")["reason"]

    def test_raising_a_ceiling_is_not_breaking(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 20},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
            ]
        )
        diff = diff_tables(table_with(), after)
        assert diff["compatible"] is True

    def test_dropping_an_unbounded_ceiling_is_not_breaking(self) -> None:
        before = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": 100},
            ]
        )
        assert diff_tables(before, table_with())["compatible"] is True

    def test_adding_an_edge_is_not_breaking(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
                {"id": "ba", "source": "b", "target": "a", "maxTicks": None},
            ]
        )
        diff = diff_tables(table_with(), after)
        assert diff["rulesAdded"] == ["ba"]
        assert diff["compatible"] is True

    def test_editing_only_a_guard_is_not_breaking(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10, "guard": "ready"},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": None},
            ]
        )
        diff = diff_tables(table_with(), after)
        assert diff["compatible"] is True
        assert change_for(diff, "rule:a->b (ab)")["fields"] == ["guard"]


class TestSymmetry:
    def test_added_and_removed_swap_when_the_order_is_reversed(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 5, "maxTicks": 10},
            ]
        )
        forward = diff_tables(table_with(), after)
        backward = diff_tables(after, table_with())
        assert forward["rulesRemoved"] == backward["rulesAdded"]
        assert forward["rulesAdded"] == backward["rulesRemoved"]
        assert forward["statesAdded"] == backward["statesRemoved"]
        assert forward["statesRemoved"] == backward["statesAdded"]

    def test_a_subject_is_breaking_in_at_most_one_direction(self) -> None:
        """`breaking` is directional on purpose, and that is the property worth asserting.

        Raising a floor breaks the old table; lowering it again does not break the new one.
        If `breaking` were symmetric it would be naming "changed", not "rejects".
        """
        tightened = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 5, "maxTicks": 10},
                {"id": "bz", "source": "b", "target": "z", "maxTicks": 1},
            ]
        )
        forward = diff_tables(table_with(), tightened)
        backward = diff_tables(tightened, table_with())
        assert forward["breaking"] == ["rule:a->b (ab)", "rule:b->z (bz)"]
        assert backward["breaking"] == []
        assert set(forward["breaking"]) & set(backward["breaking"]) == set()

    def test_the_same_subjects_are_modified_in_both_directions(self) -> None:
        tightened = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 5, "maxTicks": 10},
            ]
        )
        forward = diff_tables(table_with(), tightened)
        backward = diff_tables(tightened, table_with())
        assert forward["rulesChanged"] == backward["rulesChanged"]
        assert forward["unchanged"] == backward["unchanged"]

    def test_a_removal_is_breaking_in_the_direction_that_deletes(self) -> None:
        after = table_with(
            transitions=[
                {"id": "ab", "source": "a", "target": "b", "minTicks": 0, "maxTicks": 10},
            ]
        )
        assert diff_tables(table_with(), after)["breaking"] == ["rule:b->z (bz)"]
        # Adding it back is a relaxation, not a break.
        assert diff_tables(after, table_with())["breaking"] == []


class TestShippedRevisions:
    def test_the_shipped_revision_is_incompatible(self, tables: dict[str, Table]) -> None:
        diff = diff_tables(tables["skirmish-64"], tables["skirmish-64-r2"])
        assert diff["compatible"] is False
        assert diff["breaking"] == [
            "rule:countdown->live (start_match)",
            "rule:lobby->ended (abandon_match)",
        ]
        assert diff["rulesRemoved"] == ["abandon_match"]
        assert diff["rulesChanged"] == ["start_match"]

    def test_the_reason_names_the_budget_that_moved(
        self, tables: dict[str, Table]
    ) -> None:
        diff = diff_tables(tables["skirmish-64"], tables["skirmish-64-r2"])
        assert "192 to 256" in change_for(diff, "rule:countdown->live (start_match)")["reason"]

    def test_a_tickrate_change_is_reported_separately(self) -> None:
        diff = diff_tables(table_with(), table_with(id="t2", tickrateHz=128))
        assert diff["tickrateChanged"] is True
        assert diff["tickrateAfter"] == 128
        assert diff["compatible"] is True

    @pytest.mark.parametrize("table_id", ["skirmish-64", "skirmish-64-r2", "skirmish-broken"])
    def test_no_revision_is_ever_diffed_against_itself_with_changes(
        self, tables: dict[str, Table], table_id: str
    ) -> None:
        assert diff_tables(tables[table_id], tables[table_id])["changes"] == []
