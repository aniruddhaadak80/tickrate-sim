"""The input contract: a netcode transition table and an observed tick trace.

Everything the engine accepts is validated here, once, at the boundary. After `parse_table`
and `parse_trace` return, the analysis modules can assume well-formed typed data and never
re-check a field. That is what keeps the walk in `replay.py` free of defensive noise.

Two kinds of thing are modelled, and the distinction is the whole product:

  * A **table** is a declaration. It says which state transitions a game server is allowed
    to perform, and how many ticks each transition may take. It is a design document.
  * A **trace** is an observation. It says which transitions a server actually performed,
    at which tick. It is a recording.

A violation is therefore never "the trace is malformed". It is "reality did something the
declaration does not permit", which is the only interesting question when debugging a
desync.
"""

from __future__ import annotations

from typing import Any, Final, NotRequired, TypedDict

from .protocol import EngineError

StateName = str
RuleId = str

DEFAULT_MIN_TICKS: Final[int] = 0


class StateSpec(TypedDict):
    """One declared state in the netcode state machine."""

    name: StateName
    terminal: bool
    description: NotRequired[str]


class TransitionRule(TypedDict):
    """One declared edge: `source` may become `target` after a bounded number of ticks.

    `minTicks` and `maxTicks` bound `ticksInState`: how many ticks elapsed in `source`
    before the edge was taken. `maxTicks: None` means the state may persist indefinitely,
    which is how an idle lobby is declared.
    """

    id: RuleId
    source: StateName
    target: StateName
    minTicks: int
    maxTicks: int | None
    repeatable: bool
    guard: NotRequired[str]


class Table(TypedDict):
    """A validated transition table."""

    id: str
    tickrateHz: int
    entry: StateName
    states: list[StateSpec]
    transitions: list[TransitionRule]


class TraceEvent(TypedDict):
    """One observed transition: the server entered `target` on this tick."""

    tick: int
    target: StateName
    note: NotRequired[str]


class Anchor(TypedDict):
    """A wall-clock reading taken while the trace was recorded."""

    tick: int
    ms: int


class Trace(TypedDict):
    """A validated trace: ordered observations against one table."""

    id: str
    tableId: str
    startTick: int
    endTick: int
    events: list[TraceEvent]
    anchors: list[Anchor]


# --------------------------------------------------------------------------- helpers


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EngineError("BAD_SHAPE", f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise EngineError("BAD_SHAPE", f"{label} must be an array")
    return value


def _string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise EngineError("BAD_SHAPE", f"{label} must be a string")
    if not allow_empty and not value.strip():
        raise EngineError("BAD_SHAPE", f"{label} must not be empty")
    return value


def _integer(value: Any, label: str) -> int:
    # bool is an int subclass in Python; a JSON `true` where a tick count belongs is a bug.
    if isinstance(value, bool) or not isinstance(value, int):
        raise EngineError("BAD_SHAPE", f"{label} must be an integer")
    return value


def _required(source: dict[str, Any], key: str, label: str) -> Any:
    if key not in source:
        raise EngineError("MISSING_FIELD", f"{label} is missing {key!r}")
    return source[key]


def _optional_bool(source: dict[str, Any], key: str, label: str, default: bool) -> bool:
    if key not in source:
        return default
    value = source[key]
    if not isinstance(value, bool):
        raise EngineError("BAD_SHAPE", f"{label}.{key} must be a boolean")
    return value


def _optional_note(source: dict[str, Any], key: str, label: str) -> str:
    if key not in source:
        return ""
    return _string(source[key], f"{label}.{key}", allow_empty=True)


# --------------------------------------------------------------------------- parsers


def _parse_state(raw: Any, index: int) -> StateSpec:
    label = f"states[{index}]"
    source = _object(raw, label)
    return StateSpec(
        name=_string(_required(source, "name", label), f"{label}.name"),
        terminal=_optional_bool(source, "terminal", label, False),
        description=_optional_note(source, "description", label),
    )


def _parse_rule(raw: Any, index: int) -> TransitionRule:
    label = f"transitions[{index}]"
    source = _object(raw, label)
    raw_max = source.get("maxTicks", None)
    if raw_max is not None:
        raw_max = _integer(raw_max, f"{label}.maxTicks")
    return TransitionRule(
        id=_string(_required(source, "id", label), f"{label}.id"),
        source=_string(_required(source, "source", label), f"{label}.source"),
        target=_string(_required(source, "target", label), f"{label}.target"),
        minTicks=_integer(source.get("minTicks", DEFAULT_MIN_TICKS), f"{label}.minTicks"),
        maxTicks=raw_max,
        repeatable=_optional_bool(source, "repeatable", label, True),
        guard=_optional_note(source, "guard", label),
    )


def parse_table(raw: Any) -> Table:
    """Parse and shape-check a transition table. Structural analysis lives in `table.py`."""
    source = _object(raw, "table")
    states = [
        _parse_state(item, index)
        for index, item in enumerate(_array(_required(source, "states", "table"), "table.states"))
    ]
    transitions = [
        _parse_rule(item, index)
        for index, item in enumerate(
            _array(_required(source, "transitions", "table"), "table.transitions")
        )
    ]
    table = Table(
        id=_string(_required(source, "id", "table"), "table.id"),
        tickrateHz=_integer(_required(source, "tickrateHz", "table"), "table.tickrateHz"),
        entry=_string(_required(source, "entry", "table"), "table.entry"),
        states=states,
        transitions=transitions,
    )
    if table["tickrateHz"] <= 0:
        raise EngineError("BAD_SHAPE", "table.tickrateHz must be greater than zero")
    return table


def _parse_event(raw: Any, index: int) -> TraceEvent:
    label = f"trace.events[{index}]"
    source = _object(raw, label)
    return TraceEvent(
        tick=_integer(_required(source, "tick", label), f"{label}.tick"),
        target=_string(_required(source, "target", label), f"{label}.target"),
        note=_optional_note(source, "note", label),
    )


def _parse_anchor(raw: Any, index: int) -> Anchor:
    label = f"trace.anchors[{index}]"
    source = _object(raw, label)
    return Anchor(
        tick=_integer(_required(source, "tick", label), f"{label}.tick"),
        ms=_integer(_required(source, "ms", label), f"{label}.ms"),
    )


def parse_trace(raw: Any) -> Trace:
    """Parse and shape-check a trace. Ordering invariants live in the analysis modules."""
    source = _object(raw, "trace")
    events = [
        _parse_event(item, index)
        for index, item in enumerate(
            _array(_required(source, "events", "trace"), "trace.events")
        )
    ]
    anchors = [
        _parse_anchor(item, index)
        for index, item in enumerate(
            _array(source.get("anchors", []), "trace.anchors")
        )
    ]
    trace = Trace(
        id=_string(_required(source, "id", "trace"), "trace.id"),
        tableId=_string(_required(source, "tableId", "trace"), "trace.tableId"),
        startTick=_integer(_required(source, "startTick", "trace"), "trace.startTick"),
        endTick=_integer(_required(source, "endTick", "trace"), "trace.endTick"),
        events=events,
        anchors=anchors,
    )
    if trace["endTick"] < trace["startTick"]:
        raise EngineError("BAD_SHAPE", "trace.endTick must not precede trace.startTick")
    return trace


def index_states(table: Table) -> dict[StateName, StateSpec]:
    """State name -> spec. Last declaration wins, and `validate_table` reports the duplicate."""
    return {state["name"]: state for state in table["states"]}


def index_rules(table: Table) -> dict[StateName, list[TransitionRule]]:
    """Source state -> every rule that leaves it, in declaration order."""
    grouped: dict[StateName, list[TransitionRule]] = {}
    for rule in table["transitions"]:
        grouped.setdefault(rule["source"], []).append(rule)
    return grouped


def index_rules_by_position(
    table: Table,
) -> dict[StateName, list[tuple[int, TransitionRule]]]:
    """Source state -> (position in `transitions`, rule), in declaration order.

    The walk counts things per *rule*, not per id. A table with two rules sharing an id is
    already an error in `validate_table`, but an analysis module that quietly merged them would
    under-report coverage - and under-reporting coverage is the one failure mode a trace
    regression suite cannot detect.
    """
    grouped: dict[StateName, list[tuple[int, TransitionRule]]] = {}
    for position, rule in enumerate(table["transitions"]):
        grouped.setdefault(rule["source"], []).append((position, rule))
    return grouped
