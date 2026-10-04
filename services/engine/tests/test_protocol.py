from __future__ import annotations

import io
import json

import pytest

from tickrate_sim.__main__ import handle
from tickrate_sim.analysis import OPERATIONS
from tickrate_sim.protocol import EngineError, dispatch, read_request, write_response


class TestReadRequest:
    def test_parses_a_valid_request(self) -> None:
        op, payload = read_request(io.StringIO('{"op":"validate_table","input":{"id":"t"}}'))
        assert op == "validate_table"
        assert payload == {"id": "t"}

    @pytest.mark.parametrize(
        ("raw", "code"),
        [
            ("", "EMPTY_INPUT"),
            ("{not json", "BAD_JSON"),
            ("[1,2,3]", "BAD_SHAPE"),
            ('{"input":1}', "MISSING_OP"),
            ('{"op":"","input":1}', "MISSING_OP"),
        ],
    )
    def test_rejects_malformed_input_with_a_stable_code(self, raw: str, code: str) -> None:
        with pytest.raises(EngineError) as caught:
            read_request(io.StringIO(raw))
        assert caught.value.code == code

    def test_rejects_an_oversized_request(self) -> None:
        oversized = io.StringIO('{"op":"x","input":"' + "a" * (9 * 1024 * 1024) + '"}')
        with pytest.raises(EngineError) as caught:
            read_request(oversized)
        assert caught.value.code == "INPUT_TOO_LARGE"


class TestWriteResponse:
    def test_writes_exactly_one_line_of_json(self) -> None:
        buffer = io.StringIO()
        write_response({"ok": True, "value": {"a": 1}, "durationMs": 2}, stream=buffer)
        lines = buffer.getvalue().strip().split("\n")
        assert len(lines) == 1
        assert json.loads(lines[0]) == {"ok": True, "value": {"a": 1}, "durationMs": 2}

    def test_writes_an_error_response_without_raising(self) -> None:
        buffer = io.StringIO()
        write_response(
            {"ok": False, "error": {"code": "X", "message": "y"}, "durationMs": 0},
            stream=buffer,
        )
        assert json.loads(buffer.getvalue())["ok"] is False


class TestDispatch:
    def test_routes_to_a_handler(self) -> None:
        assert dispatch({"echo": lambda payload: payload}, "echo", 7) == 7

    def test_unknown_op_names_the_available_ones(self) -> None:
        with pytest.raises(EngineError) as caught:
            dispatch({}, "nope", None)
        assert caught.value.code == "UNKNOWN_OP"
        assert "available" in caught.value.message


MINIMAL_TABLE: dict[str, object] = {
    "id": "t",
    "tickrateHz": 64,
    "entry": "a",
    "states": [{"name": "a"}, {"name": "b"}, {"name": "z", "terminal": True}],
    "transitions": [{"id": "ab", "source": "a", "target": "b"}],
}


class TestHandle:
    def test_routes_to_a_real_operation(self) -> None:
        assert handle("validate_table", {"table": MINIMAL_TABLE})["ok"] is True

    def test_unknown_operation_is_an_error_not_a_crash(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("nope", None)
        assert caught.value.code == "UNKNOWN_OP"

    def test_a_failing_handler_propagates_its_code(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("replay", {"table": MINIMAL_TABLE, "trace": {"id": "x"}})
        assert caught.value.code == "MISSING_FIELD"

    def test_a_mismatched_trace_is_rejected_before_the_walk(self) -> None:
        trace = {"id": "x", "tableId": "other", "startTick": 0, "endTick": 1, "events": []}
        with pytest.raises(EngineError) as caught:
            handle("replay", {"table": MINIMAL_TABLE, "trace": trace})
        assert caught.value.code == "TRACE_TABLE_MISMATCH"

    def test_every_advertised_operation_is_routable(self) -> None:
        for op in OPERATIONS:
            with pytest.raises(EngineError) as caught:
                handle(op, {})
            # An empty document is a bad request, never an unknown operation.
            assert caught.value.code != "UNKNOWN_OP"


class TestOperationEnvelope:
    """Every operation takes the envelope its published JSON Schema declares.

    The TypeScript tool layer owns that schema, and it sends `{table: ...}` /
    `{table, trace: ...}` / `{before, after}`. If an operation here quietly accepted a bare
    document instead, the mismatch would only surface as a runtime error in a different
    language from the one that defines the contract - which is exactly the class of bug this
    class of test exists to catch.
    """

    TRACE = {
        "id": "t",
        "tableId": "t",
        "startTick": 0,
        "endTick": 100,
        "events": [{"tick": 10, "target": "b"}],
        "anchors": [{"tick": 0, "ms": 0}, {"tick": 10, "ms": 156}],
    }

    def test_validate_table_takes_an_envelope_not_a_bare_table(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("validate_table", MINIMAL_TABLE)
        assert caught.value.code == "MISSING_FIELD"

    def test_validate_table_reads_the_envelope(self) -> None:
        assert handle("validate_table", {"table": MINIMAL_TABLE})["tableId"] == "t"

    @pytest.mark.parametrize("op", ["replay", "tickrate_stats", "budget_profile"])
    def test_table_and_trace_operations_take_both_fields(self, op: str) -> None:
        report = handle(op, {"table": MINIMAL_TABLE, "trace": self.TRACE})
        assert report["tableId"] == "t"

    @pytest.mark.parametrize("op", ["replay", "tickrate_stats", "budget_profile"])
    def test_table_and_trace_operations_refuse_a_bare_table(self, op: str) -> None:
        with pytest.raises(EngineError) as caught:
            handle(op, MINIMAL_TABLE)
        assert caught.value.code == "MISSING_FIELD"

    def test_diff_takes_before_and_after(self) -> None:
        diff = handle("diff_tables", {"before": MINIMAL_TABLE, "after": MINIMAL_TABLE})
        assert diff["compatible"] is True

    def test_diff_refuses_a_single_table(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("diff_tables", {"before": MINIMAL_TABLE})
        assert caught.value.code == "MISSING_FIELD"

    def test_a_non_object_envelope_is_rejected_with_a_useful_message(self) -> None:
        with pytest.raises(EngineError) as caught:
            handle("validate_table", ["not", "an", "object"])
        assert caught.value.code == "BAD_SHAPE"
        assert "table" in caught.value.message
