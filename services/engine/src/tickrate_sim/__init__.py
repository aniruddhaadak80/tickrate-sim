"""Deterministic engine for tickrate-sim.

The engine is deliberately dependency-free. Every operation is a pure function: same input,
same output, no clock, no network, no randomness. Time and any entropy must be passed in by
the caller.

The five operations, and the question each one answers:

    validate_table  - is the declaration coherent?
    replay          - where did reality outgrow the declaration?
    tickrate_stats  - what rate did the server actually hit, and how much did it wobble?
    budget_profile  - which tick budgets are tight, and which are fiction?
    diff_tables     - which change would make a passing trace fail?
"""

from .analysis import HANDLERS, OPERATIONS, analyse
from .diffing import TableChange, TableDiff, diff_tables
from .model import (
    Anchor,
    StateName,
    StateSpec,
    Table,
    Trace,
    TraceEvent,
    TransitionRule,
    parse_table,
    parse_trace,
)
from .protocol import EngineError
from .replay import (
    BudgetProfile,
    BudgetRow,
    Coverage,
    ReplayReport,
    TimelineStep,
    Violation,
    budget_profile,
    replay,
)
from .stats import TickrateStats, tickrate_stats
from .table import TableIssue, TableValidation, validate_table

__all__ = [
    "Anchor",
    "BudgetProfile",
    "BudgetRow",
    "Coverage",
    "EngineError",
    "HANDLERS",
    "OPERATIONS",
    "ReplayReport",
    "StateName",
    "StateSpec",
    "Table",
    "TableChange",
    "TableDiff",
    "TableIssue",
    "TableValidation",
    "TickrateStats",
    "TimelineStep",
    "Trace",
    "TraceEvent",
    "TransitionRule",
    "Violation",
    "analyse",
    "budget_profile",
    "diff_tables",
    "parse_table",
    "parse_trace",
    "replay",
    "tickrate_stats",
    "validate_table",
]
__version__ = "0.1.0"
