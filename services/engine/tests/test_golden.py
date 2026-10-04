"""The anti-drift gate.

The corpus in `apps/web/data` is committed, and every expected result in it was produced by
the engine. This test re-derives all of them and fails if anything moved. Without it, a
change to the walk would silently invalidate every documented example and every number the
web app renders.

Regenerate deliberately, never automatically:

    python services/engine/scripts/sync_cases.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from tickrate_sim import (
    budget_profile,
    diff_tables,
    parse_table,
    parse_trace,
    replay,
    tickrate_stats,
    validate_table,
)
from tickrate_sim.replay import (
    BUDGET_OVERRUN,
    BUDGET_UNDERRUN,
    REPEAT_TRANSITION,
    TERMINAL_EXIT,
    UNDECLARED_TRANSITION,
)

from conftest import DATA


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def first_difference(left: Any, right: Any, path: str = "$") -> str | None:
    """Locate the first place two JSON documents disagree, for a readable failure.

    Written as one accumulator and one exit rather than as a chain of early returns: a
    recursive comparison has enough cases that a return-per-case version hides the one place
    the recursion actually recurses.
    """
    found: str | None = None

    if type(left) is not type(right):
        found = f"{path}: type {type(left).__name__} != {type(right).__name__}"
    elif isinstance(left, dict):
        found = _first_key_difference(left, right, path)
    elif isinstance(left, list):
        found = _first_index_difference(left, right, path)
    elif left != right:
        found = f"{path}: {left!r} != {right!r}"

    return found


def _first_key_difference(left: dict[Any, Any], right: dict[Any, Any], path: str) -> str | None:
    for key in sorted(set(left) | set(right)):
        if key not in left:
            return f"{path}.{key}: missing on the left"
        if key not in right:
            return f"{path}.{key}: missing on the right"
        found = first_difference(left[key], right[key], f"{path}.{key}")
        if found is not None:
            return found
    return None


def _first_index_difference(left: list[Any], right: list[Any], path: str) -> str | None:
    if len(left) != len(right):
        return f"{path}: length {len(left)} != {len(right)}"
    for index, (a, b) in enumerate(zip(left, right, strict=True)):
        found = first_difference(a, b, f"{path}[{index}]")
        if found is not None:
            return found
    return None


class TestCommittedCorpus:
    def test_the_corpus_files_exist(self) -> None:
        for name in ("tables.json", "cases.json", "table-diffs.json", "table-checks.json"):
            assert (DATA / name).is_file(), f"{name} is missing; run sync_cases.py"

    def test_every_case_replays_to_its_committed_report(self) -> None:
        cases = json.loads((DATA / "cases.json").read_text(encoding="utf8"))
        assert cases, "the corpus is empty"
        for case in cases:
            table = parse_table(case["table"])
            trace = parse_trace(case["trace"])
            actual = replay(table, trace)
            expected = case["expected"]["replay"]
            difference = first_difference(expected, actual)
            assert difference is None, f"case {case['id']} drifted at {difference}"

    def test_every_case_budgets_to_its_committed_profile(self) -> None:
        cases = json.loads((DATA / "cases.json").read_text(encoding="utf8"))
        for case in cases:
            actual = budget_profile(parse_table(case["table"]), parse_trace(case["trace"]))
            difference = first_difference(case["expected"]["budgetProfile"], actual)
            assert difference is None, f"case {case['id']} budget drifted at {difference}"

    def test_every_case_measures_to_its_committed_stats(self) -> None:
        cases = json.loads((DATA / "cases.json").read_text(encoding="utf8"))
        for case in cases:
            actual = tickrate_stats(parse_table(case["table"]), parse_trace(case["trace"]))
            difference = first_difference(case["expected"]["tickrate"], actual)
            assert difference is None, f"case {case['id']} stats drifted at {difference}"

    def test_every_table_validates_to_its_committed_report(self) -> None:

        checks = json.loads((DATA / "table-checks.json").read_text(encoding="utf8"))
        for check in checks:
            actual = validate_table(parse_table(check["table"]))
            difference = first_difference(check["expected"], actual)
            assert difference is None, f"check {check['id']} drifted at {difference}"

    def test_every_diff_matches_its_committed_report(self) -> None:
        entries = json.loads((DATA / "table-diffs.json").read_text(encoding="utf8"))
        for entry in entries:
            actual = diff_tables(parse_table(entry["before"]), parse_table(entry["after"]))
            difference = first_difference(entry["expected"], actual)
            assert difference is None, f"diff {entry['id']} drifted at {difference}"


class TestCorpusCoverage:
    """The corpus has to exercise every violation code, or it is not a test suite."""

    def test_every_violation_code_appears_somewhere_in_the_corpus(self) -> None:
        cases = json.loads((DATA / "cases.json").read_text(encoding="utf8"))
        seen = {
            violation["code"]
            for case in cases
            for violation in case["expected"]["replay"]["violations"]
        }
        # EVENT_OUT_OF_RANGE and UNKNOWN_STATE are covered by unit tests rather than by the
        # corpus, because a shipped case with them would be a case nobody would ship.
        assert {
            BUDGET_OVERRUN,
            BUDGET_UNDERRUN,
            REPEAT_TRANSITION,
            TERMINAL_EXIT,
            UNDECLARED_TRANSITION,
        } <= seen

    def test_the_corpus_has_a_clean_case_and_failing_cases(self) -> None:
        cases = json.loads((DATA / "cases.json").read_text(encoding="utf8"))
        outcomes = [case["expected"]["replay"]["ok"] for case in cases]
        assert True in outcomes
        assert False in outcomes

    def test_the_corpus_covers_every_table(self) -> None:
        cases = json.loads((DATA / "cases.json").read_text(encoding="utf8"))
        used = {case["table"]["id"] for case in cases}
        assert used == {"skirmish-64"}


class TestRegenerationIsReproducible:
    def test_running_the_generator_twice_produces_identical_bytes(self) -> None:
        before = {
            path.name: path.read_bytes()
            for path in sorted(DATA.glob("*.json"))
        }

        repo_root = Path(__file__).resolve().parents[3]
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [sys.executable, "services/engine/scripts/sync_cases.py"],
            cwd=repo_root,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr.decode("utf8", "replace")
        for path in sorted(DATA.glob("*.json")):
            assert path.read_bytes() == before[path.name], f"{path.name} is not reproducible"

    def test_the_committed_files_are_canonical_json(self) -> None:
        for path in sorted(DATA.glob("*.json")):
            raw = path.read_text(encoding="utf8")
            assert raw.endswith("\n"), f"{path.name} has no trailing newline"
            assert "\r\n" not in raw, f"{path.name} has CRLF line endings"
            assert canonical(json.loads(raw)) is not None
