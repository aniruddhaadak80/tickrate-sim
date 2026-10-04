"""Structural diff between two revisions of a transition table.

Reviewing a netcode change means answering one question: *which traces that used to pass
would now fail?* A diff that lists added and removed edges answers a weaker question. So
every change here is classified `breaking` or not, using the same budget semantics the walk
uses - tightening a `minTicks` or capping a previously unbounded `maxTicks` breaks passing
traces even though no edge was added or removed at all.

Two design decisions in this module exist because property testing found the alternative
wrong, and both are worth stating because they look like over-engineering until they are not:

  * **Subjects are edge-qualified.** `breaking` is the headline output, so it may not be
    ambiguous. Two rules can share an id, and a state and a rule can share a name, so a
    subject is `rule:<source>-><target> (<id>)` or `state:<name>`. Never a bare name.
  * **Duplicate edges are paired positionally, not by key.** Collapsing them into a dict
    would silently drop one of them from the diff, and a review tool that quietly omits a
    change is worse than one that reports an error.
"""

from __future__ import annotations

from itertools import zip_longest
from typing import Any, Final, TypedDict

from .model import RuleId, StateName, Table, TransitionRule, index_states

ADDED: Final[str] = "added"
REMOVED: Final[str] = "removed"
MODIFIED: Final[str] = "modified"

#: Budget fields whose direction decides whether a modification rejects old traces.
_BUDGET_FIELDS: Final[tuple[str, ...]] = ("minTicks", "maxTicks")

Edge = tuple[str, str]


class TableChange(TypedDict):
    kind: str
    subject: str
    breaking: bool
    fields: list[str]
    before: Any
    after: Any
    reason: str


class TableDiff(TypedDict):
    fromId: str
    toId: str
    statesAdded: list[StateName]
    statesRemoved: list[StateName]
    rulesAdded: list[RuleId]
    rulesRemoved: list[RuleId]
    rulesChanged: list[RuleId]
    unchanged: int
    tickrateBefore: int
    tickrateAfter: int
    tickrateChanged: bool
    changes: list[TableChange]
    breaking: list[str]
    compatible: bool


def state_subject(name: StateName) -> str:
    return f"state:{name}"


def rule_subject(rule: TransitionRule) -> str:
    """An unambiguous name for one declared edge.

    The edge is the identity a rule is paired on, so it belongs in the subject. Two rules
    sharing an id then still get different subjects, and a reviewer reading `breaking` can see
    which edge moved without cross-referencing anything.
    """
    return f"rule:{rule['source']}->{rule['target']} ({rule['id']})"


def _grouped_by_edge(table: Table) -> dict[Edge, list[TransitionRule]]:
    grouped: dict[Edge, list[TransitionRule]] = {}
    for rule in table["transitions"]:
        grouped.setdefault((rule["source"], rule["target"]), []).append(rule)
    return grouped


def _changed_fields(before: Any, after: Any) -> list[str]:
    left = dict(before) if isinstance(before, dict) else {}
    right = dict(after) if isinstance(after, dict) else {}
    return sorted(key for key in set(left) | set(right) if left.get(key) != right.get(key))


def _is_tighter(field: str, before: Any, after: Any) -> bool:
    """True when a budget move rejects traces that previously passed.

    `minTicks` rising tightens. `maxTicks` falling tightens. `None` means unbounded, so
    capping a previously unbounded rule tightens and dropping a cap relaxes. Getting that
    backwards is the classic bug in a hand-rolled diff, which is why it is a named function
    with its own tests rather than an inline comparison.
    """
    if field == "minTicks":
        return isinstance(before, int) and isinstance(after, int) and after > before
    if before is None:
        return isinstance(after, int)
    if after is None:
        return False
    return isinstance(before, int) and isinstance(after, int) and after < before


def _modification(before: TransitionRule, after: TransitionRule) -> TableChange | None:
    fields = _changed_fields(before, after)
    if not fields:
        return None

    tightener = next(
        (
            field
            for field in fields
            if field in _BUDGET_FIELDS
            and _is_tighter(field, before.get(field), after.get(field))
        ),
        None,
    )
    if tightener is not None:
        reason = (
            f"{tightener} moved from {before.get(tightener)} to {after.get(tightener)}, "
            f"which rejects traces that used to pass"
        )
    elif any(field in _BUDGET_FIELDS for field in fields):
        reason = "budget widened; traces that used to pass still pass"
    else:
        reason = "metadata only; no tick behaviour changed"

    return TableChange(
        kind=MODIFIED,
        subject=rule_subject(after),
        breaking=tightener is not None,
        fields=fields,
        before=dict(before),
        after=dict(after),
        reason=reason,
    )


def _state_change(name: StateName, before: Any, after: Any) -> TableChange:
    present = after is not None
    return TableChange(
        kind=ADDED if present else REMOVED,
        subject=state_subject(name),
        breaking=not present,
        fields=["name", "terminal"],
        before=before,
        after=after,
        reason=(
            "new state; only traces that reach it are affected"
            if present
            else "state deleted; any trace that entered it now fails with UNKNOWN_STATE"
        ),
    )


def _rule_change(rule: TransitionRule, present: bool) -> TableChange:
    return TableChange(
        kind=ADDED if present else REMOVED,
        subject=rule_subject(rule),
        breaking=not present,
        fields=["id", "source", "target", "minTicks", "maxTicks"],
        before=None if present else dict(rule),
        after=dict(rule) if present else None,
        reason=(
            "new edge; traces that previously failed here now have a rule to satisfy"
            if present
            else "edge deleted; any trace that took it now fails with UNDECLARED_TRANSITION"
        ),
    )


def _edge_changes(
    left: dict[Edge, list[TransitionRule]],
    right: dict[Edge, list[TransitionRule]],
) -> tuple[list[TableChange], list[RuleId], list[RuleId], list[RuleId], int]:
    """Pair rules edge by edge and, within an edge, by declaration order.

    `zip_longest` is what keeps this total: a table that declares the same edge twice is an
    `error` in `validate_table`, but the diff still reports every rule rather than letting a
    dict collapse two of them into one.
    """
    changes: list[TableChange] = []
    added: list[RuleId] = []
    removed: list[RuleId] = []
    changed: list[RuleId] = []
    unchanged = 0

    for edge in sorted(set(left) | set(right)):
        for old, new in zip_longest(left.get(edge, []), right.get(edge, [])):
            if old is None and new is None:
                continue
            if old is None and new is not None:
                added.append(new["id"])
                changes.append(_rule_change(new, True))
                continue
            if new is None and old is not None:
                removed.append(old["id"])
                changes.append(_rule_change(old, False))
                continue
            assert old is not None and new is not None  # narrowed by the guards above
            modification = _modification(old, new)
            if modification is None:
                unchanged += 1
                continue
            changed.append(new["id"])
            changes.append(modification)

    return changes, added, removed, changed, unchanged


def diff_tables(before: Table, after: Table) -> TableDiff:
    """Classify every difference between two table revisions.

    Symmetric in shape, directional in meaning: `diff(a, b)` and `diff(b, a)` name the same
    edges as added and removed with the labels swapped, but `breaking` names whichever
    revision does the rejecting. Diffing a table against itself yields no changes and
    `compatible: true`.
    """
    left_states = index_states(before)
    right_states = index_states(after)

    edge_changes, added, removed, changed, unchanged = _edge_changes(
        _grouped_by_edge(before), _grouped_by_edge(after)
    )

    changes: list[TableChange] = []
    for name in sorted(set(right_states) - set(left_states)):
        changes.append(_state_change(name, None, dict(right_states[name])))
    for name in sorted(set(left_states) - set(right_states)):
        changes.append(_state_change(name, dict(left_states[name]), None))
    changes.extend(edge_changes)

    return TableDiff(
        fromId=before["id"],
        toId=after["id"],
        statesAdded=sorted(set(right_states) - set(left_states)),
        statesRemoved=sorted(set(left_states) - set(right_states)),
        rulesAdded=sorted(added),
        rulesRemoved=sorted(removed),
        rulesChanged=sorted(changed),
        unchanged=unchanged,
        tickrateBefore=before["tickrateHz"],
        tickrateAfter=after["tickrateHz"],
        tickrateChanged=before["tickrateHz"] != after["tickrateHz"],
        changes=changes,
        breaking=sorted({change["subject"] for change in changes if change["breaking"]}),
        compatible=not any(change["breaking"] for change in changes),
    )
