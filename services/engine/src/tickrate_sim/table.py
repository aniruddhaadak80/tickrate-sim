"""Structural analysis of a transition table.

This answers a question you can only answer once, before any trace exists: *is the
declaration itself coherent?* A table can be syntactically valid and still be a broken
design - a state nobody can reach, a state with no way out that is not marked terminal, two
edges that claim the same pair and therefore leave the walk ambiguous.

Finding those before you have a trace is the difference between "the trace is wrong" and
"the design is wrong", and the two lead to completely different fixes.
"""

from __future__ import annotations

from typing import Final, TypedDict

from .model import (
    RuleId,
    StateName,
    StateSpec,
    Table,
    TransitionRule,
    index_rules,
    index_states,
)

#: Severity is not a judgement of the author; it is how much the finding constrains the
#: walk. `error` findings make a replay meaningless, `warn` findings make it suspicious.
ERROR: Final[str] = "error"
WARN: Final[str] = "warn"

_SEVERITY_ORDER: Final[dict[str, int]] = {ERROR: 0, WARN: 1}


class TableIssue(TypedDict):
    code: str
    severity: str
    subject: str
    message: str


class TableValidation(TypedDict):
    tableId: str
    #: True only when no finding is error-severity. Warnings are reported without failing,
    #: because an unreachable state is a smell rather than a contradiction.
    ok: bool
    errors: int
    warnings: int
    states: int
    transitions: int
    entry: str
    tickrateHz: int
    issues: list[TableIssue]
    unreachable: list[StateName]
    deadEnds: list[StateName]
    terminal: list[StateName]
    conflictingRules: list[RuleId]


def _issue(code: str, severity: str, subject: str, message: str) -> TableIssue:
    return TableIssue(code=code, severity=severity, subject=subject, message=message)


def _duplicates(names: list[str]) -> list[str]:
    seen: set[str] = set()
    dupes: set[str] = set()
    for name in names:
        if name in seen:
            dupes.add(name)
        seen.add(name)
    return sorted(dupes)


def _reachable_from(table: Table) -> set[StateName]:
    """Breadth-first walk of the declared graph from the entry state.

    Deterministic because the frontier is consumed in sorted rule order, so the result does
    not depend on declaration order or on dict iteration order.
    """
    grouped = index_rules(table)
    seen: set[StateName] = {table["entry"]}
    frontier: list[StateName] = [table["entry"]]
    while frontier:
        current = frontier.pop()
        outgoing = sorted(grouped.get(current, []), key=lambda rule: rule["id"])
        for rule in outgoing:
            target = rule["target"]
            if target not in seen:
                seen.add(target)
                frontier.append(target)
    return seen


def _edge_groups(grouped: dict[StateName, list[TransitionRule]]) -> list[tuple[str, str, list[str]]]:
    """Every (source, target) pair with more than one rule, sorted."""
    clashes: list[tuple[str, str, list[str]]] = []
    for source in sorted(grouped):
        by_target: dict[str, list[str]] = {}
        for rule in grouped[source]:
            by_target.setdefault(rule["target"], []).append(rule["id"])
        for target in sorted(by_target):
            ids = sorted(by_target[target])
            if len(ids) > 1:
                clashes.append((source, target, ids))
    return clashes


def _rule_issues(
    table: Table,
    grouped: dict[StateName, list[TransitionRule]],
) -> list[TableIssue]:
    issues: list[TableIssue] = []
    declared = {state["name"] for state in table["states"]}

    for rule in table["transitions"]:
        issues.extend(_single_rule_issues(rule, declared))

    for source, target, ids in _edge_groups(grouped):
        issues.append(
            _issue(
                "AMBIGUOUS_EDGE",
                ERROR,
                ids[0],
                f"{source!r} -> {target!r} is declared {len(ids)} times ({', '.join(ids)}); "
                f"a trace cannot say which rule it satisfied",
            )
        )
    return issues


def _single_rule_issues(rule: TransitionRule, declared: set[StateName]) -> list[TableIssue]:
    subject = rule["id"]
    issues: list[TableIssue] = []

    if rule["source"] not in declared:
        issues.append(
            _issue(
                "UNKNOWN_SOURCE",
                ERROR,
                subject,
                f"transition {rule['source']!r} -> {rule['target']!r} leaves undeclared state "
                f"{rule['source']!r}",
            )
        )
    if rule["target"] not in declared:
        issues.append(
            _issue(
                "UNKNOWN_TARGET",
                ERROR,
                subject,
                f"transition {rule['source']!r} -> {rule['target']!r} enters undeclared state "
                f"{rule['target']!r}",
            )
        )
    if rule["minTicks"] < 0:
        issues.append(
            _issue(
                "NEGATIVE_BUDGET",
                ERROR,
                subject,
                f"minTicks is {rule['minTicks']}; a negative tick count is meaningless",
            )
        )

    max_ticks = rule["maxTicks"]
    if max_ticks is not None and max_ticks < 0:
        issues.append(
            _issue(
                "NEGATIVE_BUDGET",
                ERROR,
                subject,
                f"maxTicks is {max_ticks}; a negative tick count is meaningless",
            )
        )
    elif max_ticks is not None and max_ticks < rule["minTicks"]:
        issues.append(
            _issue(
                "BUDGET_INVERTED",
                ERROR,
                subject,
                f"maxTicks ({max_ticks}) is below minTicks ({rule['minTicks']}); "
                f"no tick count can satisfy this rule",
            )
        )
    return issues


def _reachability_issues(
    table: Table,
    states: dict[StateName, StateSpec],
) -> list[TableIssue]:
    issues: list[TableIssue] = []
    reachable = _reachable_from(table)
    grouped = index_rules(table)

    for name in sorted(set(states) - reachable):
        issues.append(
            _issue(
                "UNREACHABLE_STATE",
                WARN,
                name,
                f"state {name!r} cannot be reached from entry {table['entry']!r}; it is dead design",
            )
        )

    for name in sorted(states):
        issues.extend(_state_issues(name, states[name], grouped.get(name, [])))
    return issues


def _state_issues(
    name: StateName,
    spec: StateSpec,
    outgoing: list[TransitionRule],
) -> list[TableIssue]:
    terminal = bool(spec.get("terminal", False))
    if not outgoing and not terminal:
        return [
            _issue(
                "DEAD_END",
                WARN,
                name,
                f"state {name!r} has no outgoing transition but is not marked terminal, "
                f"so a trace that reaches it can never finish",
            )
        ]
    if terminal and outgoing:
        return [
            _issue(
                "TERMINAL_WITH_EXIT",
                ERROR,
                name,
                f"state {name!r} is terminal yet declares {len(outgoing)} outgoing transition(s)",
            )
        ]
    return []


def _duplicate_issues(table: Table) -> list[TableIssue]:
    issues: list[TableIssue] = []
    for name in _duplicates([state["name"] for state in table["states"]]):
        issues.append(
            _issue(
                "DUPLICATE_STATE",
                ERROR,
                name,
                f"state {name!r} is declared more than once; the last declaration wins silently",
            )
        )
    for rule_id in _duplicates([rule["id"] for rule in table["transitions"]]):
        issues.append(
            _issue(
                "DUPLICATE_RULE_ID",
                ERROR,
                rule_id,
                f"transition id {rule_id!r} is used more than once, "
                f"so a violation cannot name a rule",
            )
        )
    return issues


def validate_table(table: Table) -> TableValidation:
    """Analyse a table and report every structural problem, most severe first.

    This never raises for a merely bad table - a broken declaration is a finding, not an
    exception. Only a malformed document raises, and that was already rejected by
    `parse_table`.
    """
    states = index_states(table)
    grouped = index_rules(table)

    issues: list[TableIssue] = []
    if not table["states"]:
        issues.append(_issue("NO_STATES", ERROR, table["id"], "the table declares no states"))
    if table["entry"] not in states:
        issues.append(
            _issue(
                "ENTRY_UNDECLARED",
                ERROR,
                table["entry"],
                f"entry state {table['entry']!r} is not declared in states",
            )
        )
    issues.extend(_duplicate_issues(table))
    issues.extend(_rule_issues(table, grouped))
    issues.extend(_reachability_issues(table, states))
    issues.sort(
        key=lambda issue: (_SEVERITY_ORDER[issue["severity"]], issue["code"], issue["subject"])
    )

    reachable = _reachable_from(table)
    declared = sorted(states)
    dead_ends = sorted(
        name
        for name in declared
        if not grouped.get(name, []) and not bool(states[name].get("terminal", False))
    )
    clashes = _edge_groups(grouped)
    errors = sum(1 for issue in issues if issue["severity"] == ERROR)

    return TableValidation(
        tableId=table["id"],
        ok=errors == 0,
        errors=errors,
        warnings=len(issues) - errors,
        states=len(declared),
        transitions=len(table["transitions"]),
        entry=table["entry"],
        tickrateHz=table["tickrateHz"],
        issues=issues,
        unreachable=sorted(set(declared) - reachable),
        deadEnds=dead_ends,
        terminal=sorted(name for name in declared if bool(states[name].get("terminal", False))),
        conflictingRules=sorted({rule_id for _, _, ids in clashes for rule_id in ids}),
    )
