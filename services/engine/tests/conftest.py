"""Shared fixtures. Every test builds its tables from these, so one edit changes them all."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from tickrate_sim import Table, Trace, parse_table, parse_trace

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA = REPO_ROOT / "apps" / "web" / "data"


def load_json(name: str) -> Any:
    return json.loads((DATA / name).read_text(encoding="utf8"))


@pytest.fixture(scope="session")
def corpus() -> dict[str, Any]:
    """The shipped corpus, exactly as committed.

    Tests read the committed files rather than rebuilding the data, so a drift between the
    generator and the committed fixture fails a test instead of passing silently.
    """
    return {
        "tables": load_json("tables.json"),
        "cases": load_json("cases.json"),
        "diffs": load_json("table-diffs.json"),
        "checks": load_json("table-checks.json"),
    }


@pytest.fixture(scope="session")
def tables(corpus: dict[str, Any]) -> dict[str, Table]:
    return {table["id"]: parse_table(table) for table in corpus["tables"]}


@pytest.fixture(scope="session")
def skirmish(tables: dict[str, Table]) -> Table:
    return tables["skirmish-64"]


@pytest.fixture(scope="session")
def traces(corpus: dict[str, Any]) -> dict[str, Trace]:
    return {case["trace"]["id"]: parse_trace(case["trace"]) for case in corpus["cases"]}


def make_trace(
    trace_id: str,
    table_id: str,
    events: list[tuple[int, str]],
    *,
    start_tick: int = 0,
    end_tick: int = 1000,
    anchors: list[dict[str, int]] | None = None,
) -> Trace:
    """Build a trace in one call, so a test only states what it is about."""
    return parse_trace(
        {
            "id": trace_id,
            "tableId": table_id,
            "startTick": start_tick,
            "endTick": end_tick,
            "events": [{"tick": tick, "target": target} for tick, target in events],
            "anchors": anchors or [],
        }
    )


def empty_trace(table_id: str, *, end_tick: int = 1000) -> Trace:
    return make_trace("empty", table_id, [], end_tick=end_tick)
