"""Structural validation of a transition table."""

from __future__ import annotations


import pytest

from tickrate_sim import Table, TableValidation, parse_table, validate_table
from tickrate_sim.protocol import EngineError


def codes(report: TableValidation) -> set[str]:
    return {issue["code"] for issue in report["issues"]}


class TestValidTables:
    def test_a_coherent_table_has_no_findings(self, skirmish: Table) -> None:
        report = validate_table(skirmish)
        assert report["ok"] is True
        assert report["errors"] == 0
        assert report["warnings"] == 0
        assert report["issues"] == []

    def test_counts_and_terminals_are_reported(self, skirmish: Table) -> None:
        report = validate_table(skirmish)
        assert report["states"] == 6
        assert report["transitions"] == 8
        assert report["terminal"] == ["ended"]
        assert report["entry"] == "lobby"
        assert report["tickrateHz"] == 64


class TestStructuralFindings:
    def test_finds_every_class_of_defect_in_a_broken_table(
        self, tables: dict[str, Table]
    ) -> None:
        report = validate_table(tables["skirmish-broken"])
        assert report["ok"] is False
        assert codes(report) == {
            "AMBIGUOUS_EDGE",
            "BUDGET_INVERTED",
            "DUPLICATE_STATE",
            "ENTRY_UNDECLARED",
            "NEGATIVE_BUDGET",
            "TERMINAL_WITH_EXIT",
            "UNKNOWN_TARGET",
            "DEAD_END",
            "UNREACHABLE_STATE",
        }
        assert report["errors"] == 7
        assert report["warnings"] == 6
        assert report["errors"] + report["warnings"] == len(report["issues"])

    def test_error_and_warning_counts_match_the_issue_list(
        self, tables: dict[str, Table]
    ) -> None:
        for table in tables.values():
            report = validate_table(table)
            errors = sum(1 for issue in report["issues"] if issue["severity"] == "error")
            assert report["errors"] == errors
            assert report["warnings"] == len(report["issues"]) - errors

    def test_errors_sort_before_warnings(self, tables: dict[str, Table]) -> None:
        severities = [issue["severity"] for issue in validate_table(tables["skirmish-broken"])["issues"]]
        assert severities == sorted(severities, key=lambda level: 0 if level == "error" else 1)

    def test_an_unreachable_state_is_a_warning_not_an_error(self) -> None:
        table = parse_table(
            {
                "id": "t",
                "tickrateHz": 64,
                "entry": "a",
                "states": [{"name": "a"}, {"name": "b"}, {"name": "island"}],
                "transitions": [{"id": "ab", "source": "a", "target": "b", "maxTicks": None}],
            }
        )
        report = validate_table(table)
        assert report["ok"] is True
        assert report["unreachable"] == ["island"]
        assert "UNREACHABLE_STATE" in codes(report)

    def test_a_non_terminal_leaf_is_reported_as_a_dead_end(self) -> None:
        table = parse_table(
            {
                "id": "t",
                "tickrateHz": 64,
                "entry": "a",
                "states": [{"name": "a"}, {"name": "b"}],
                "transitions": [{"id": "ab", "source": "a", "target": "b", "maxTicks": None}],
            }
        )
        assert validate_table(table)["deadEnds"] == ["b"]

    def test_a_terminal_state_with_an_exit_is_an_error(self) -> None:
        table = parse_table(
            {
                "id": "t",
                "tickrateHz": 64,
                "entry": "b",
                "states": [{"name": "a"}, {"name": "b", "terminal": True}],
                "transitions": [
                    {"id": "ba", "source": "b", "target": "a", "maxTicks": None},
                    {"id": "ab", "source": "a", "target": "b", "maxTicks": None},
                ],
            }
        )
        report = validate_table(table)
        assert "TERMINAL_WITH_EXIT" in codes(report)
        assert report["ok"] is False

    def test_two_rules_on_the_same_edge_are_reported_as_ambiguous(self) -> None:
        table = parse_table(
            {
                "id": "t",
                "tickrateHz": 64,
                "entry": "a",
                "states": [{"name": "a"}, {"name": "b"}],
                "transitions": [
                    {"id": "first", "source": "a", "target": "b", "maxTicks": None},
                    {"id": "second", "source": "a", "target": "b", "maxTicks": None},
                ],
            }
        )
        report = validate_table(table)
        assert "AMBIGUOUS_EDGE" in codes(report)
        assert report["conflictingRules"] == ["first", "second"]

    def test_an_inverted_budget_names_both_bounds(self) -> None:
        table = parse_table(
            {
                "id": "t",
                "tickrateHz": 64,
                "entry": "a",
                "states": [{"name": "a"}, {"name": "b"}],
                "transitions": [
                    {"id": "bad", "source": "a", "target": "b", "minTicks": 90, "maxTicks": 30}
                ],
            }
        )
        issue = next(i for i in validate_table(table)["issues"] if i["code"] == "BUDGET_INVERTED")
        assert "90" in issue["message"]
        assert "30" in issue["message"]

    def test_a_table_with_no_states_is_an_error(self) -> None:
        table = parse_table({"id": "t", "tickrateHz": 64, "entry": "a", "states": [], "transitions": []})
        assert "NO_STATES" in codes(validate_table(table))

    def test_a_non_positive_tickrate_is_rejected_at_the_boundary(self) -> None:
        with pytest.raises(EngineError) as caught:
            parse_table({"id": "t", "tickrateHz": 0, "entry": "a", "states": [], "transitions": []})
        assert caught.value.code == "BAD_SHAPE"

    def test_repeated_migrations_of_the_same_table_are_identical(self, skirmish: Table) -> None:
        assert validate_table(skirmish) == validate_table(skirmish)


class TestInputValidation:
    def test_a_transition_leaving_an_undeclared_state_is_an_error(self) -> None:
        table = parse_table(
            {
                "id": "t",
                "tickrateHz": 64,
                "entry": "a",
                "states": [{"name": "a"}],
                "transitions": [{"id": "x", "source": "ghost", "target": "a"}],
            }
        )
        assert "UNKNOWN_SOURCE" in codes(validate_table(table))

    @pytest.mark.parametrize("missing", ["id", "tickrateHz", "entry", "states", "transitions"])
    def test_a_missing_required_field_raises(self, missing: str) -> None:
        document = {
            "id": "t",
            "tickrateHz": 64,
            "entry": "a",
            "states": [{"name": "a"}],
            "transitions": [],
        }
        del document[missing]
        with pytest.raises(EngineError) as caught:
            parse_table(document)
        assert caught.value.code == "MISSING_FIELD"

    def test_a_boolean_where_a_tick_count_belongs_is_rejected(self) -> None:
        with pytest.raises(EngineError) as caught:
            parse_table(
                {
                    "id": "t",
                    "tickrateHz": 64,
                    "entry": "a",
                    "states": [{"name": "a"}],
                    "transitions": [
                        {"id": "x", "source": "a", "target": "a", "minTicks": True}
                    ],
                }
            )
        assert caught.value.code == "BAD_SHAPE"
