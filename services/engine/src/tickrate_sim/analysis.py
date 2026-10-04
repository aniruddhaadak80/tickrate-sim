"""The operation table. One entry point per capability, one JSON document in and out.

This module is the router and nothing else. Every operation is a pure function imported from
a sibling module, so the dependency graph is a flat list of leaves with one fan-out point
here. Adding a sixth operation means adding a module and one line below - not editing logic
that already has tests.

Every handler receives the parsed document, not raw JSON: parsing happens once, in
`model.py`, so no operation ever re-validates a field another operation already checked.
"""

from __future__ import annotations

from typing import Any, Final

from .diffing import TableDiff, diff_tables
from .model import Table, Trace, parse_table, parse_trace
from .protocol import EngineError
from .replay import BudgetProfile, ReplayReport, budget_profile, replay
from .stats import TickrateStats, tickrate_stats
from .table import TableValidation, validate_table

#: What each operation is for, in the words a caller needs to pick one. Surfaced verbatim by
#: `tickrate-sim tools --json`, so it is documentation that cannot drift from the code.
OPERATIONS: Final[dict[str, str]] = {
    "validate_table": (
        "Check a transition table's structure: unreachable states, dead ends, terminal states "
        "with exits, inverted or negative tick budgets, and edges declared twice."
    ),
    "replay": (
        "Walk an observed tick trace against a transition table and report every transition "
        "the table does not permit, plus which declared edges the trace never exercised."
    ),
    "tickrate_stats": (
        "Measure the tick rate a trace actually achieved from its wall-clock anchors: effective "
        "Hz, drift in parts per million against the declared rate, and inter-arrival jitter."
    ),
    "budget_profile": (
        "Compare each declared rule's tick budget against what the trace actually spent, so you "
        "can see which allowances are tight and which are fiction."
    ),
    "diff_tables": (
        "Compare two revisions of a transition table and name the changes that would make a "
        "passing trace fail."
    ),
}


def _pair(payload: Any) -> tuple[Table, Trace]:
    """Parse a `{table, trace}` document.

    Cross-checking the ids belongs here rather than in `replay`, because this is the only
    layer that can write a message a human can act on: replay is deliberately total and
    reports on whatever it is handed.
    """
    table = parse_table(_field(payload, "table"))
    trace = parse_trace(_field(payload, "trace"))
    if trace["tableId"] != table["id"]:
        raise EngineError(
            "TRACE_TABLE_MISMATCH",
            f"trace {trace['id']!r} references table {trace['tableId']!r} "
            f"but was handed table {table['id']!r}",
        )
    return table, trace


def _field(payload: Any, key: str) -> Any:
    """Read one named field, so every op takes the same `{...}` envelope its schema declares.

    The wire shape is owned by the JSON Schema the tool publishes, not by whichever module
    happens to parse it. Without this, `validate_table` would take a bare table while every
    other operation takes an envelope - a mismatch that only shows up as a runtime error in a
    different language from the one that defines the contract.
    """
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", f"expected an object with {key!r}")
    if key not in payload:
        raise EngineError("MISSING_FIELD", f"expected {key!r}")
    return payload[key]


def op_validate_table(payload: Any) -> TableValidation:
    return validate_table(parse_table(_field(payload, "table")))


def op_replay(payload: Any) -> ReplayReport:
    table, trace = _pair(payload)
    return replay(table, trace)


def op_tickrate_stats(payload: Any) -> TickrateStats:
    table, trace = _pair(payload)
    return tickrate_stats(table, trace)


def op_budget_profile(payload: Any) -> BudgetProfile:
    table, trace = _pair(payload)
    return budget_profile(table, trace)


def op_diff_tables(payload: Any) -> TableDiff:
    before = parse_table(_field(payload, "before"))
    after = parse_table(_field(payload, "after"))
    return diff_tables(before, after)


HANDLERS: Final[dict[str, Any]] = {
    "validate_table": op_validate_table,
    "replay": op_replay,
    "tickrate_stats": op_tickrate_stats,
    "budget_profile": op_budget_profile,
    "diff_tables": op_diff_tables,
}


def analyse(op: str, payload: Any) -> Any:
    """Route to an operation, turning an unknown name into a stable error code."""
    handler = HANDLERS.get(op)
    if handler is None:
        known = ", ".join(sorted(HANDLERS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)
