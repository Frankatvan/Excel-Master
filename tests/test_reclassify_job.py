from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pandas as pd


WORKER_PATH = Path(__file__).resolve().parents[1] / "excel-master-app" / "api" / "internal" / "reclassify_job.py"
TEST_WORKER_SECRET = "test-worker-secret"


def load_worker_module():
    spec = importlib.util.spec_from_file_location("reclassify_job", WORKER_PATH)
    assert spec and spec.loader, "worker module spec should be loadable"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def authenticated_headers(content_length: int | str) -> dict[str, str]:
    return {
        "Content-Length": str(content_length),
        "X-AiWB-Worker-Secret": TEST_WORKER_SECRET,
    }


def test_build_reclassify_updates_returns_batch_updates_for_payable_and_final_detail():
    worker = load_worker_module()

    results = {
        "payable_decisions": [
            SimpleNamespace(category="ROE", rule_id="R107"),
            SimpleNamespace(category="GC", rule_id="R105"),
        ],
        "final_detail_decisions": [
            SimpleNamespace(category="ACC", rule_id="R201"),
        ],
    }

    updates, summary = worker.build_reclassify_updates(results)

    assert updates == [
        {"range": "Payable!A2:B2", "values": [["ROE", "R107"]]},
        {"range": "Payable!A3:B3", "values": [["GC", "R105"]]},
        {"range": "'Final Detail'!A2:B2", "values": [["ACC", "R201"]]},
    ]
    assert summary == {
        "payable_rows_written": 2,
        "final_detail_rows_written": 1,
        "draw_request_rows_written": 0,
        "draw_request_matched_rows": 0,
        "draw_request_unmatched_rows": 0,
        "draw_request_ambiguous_rows": 0,
        "mapping_warning_count": 0,
        "fallback_count": 0,
        "fallback_fields": [],
    }


def test_handler_returns_explicit_success_payload(monkeypatch):
    monkeypatch.setenv("RECLASSIFY_WORKER_SECRET", TEST_WORKER_SECRET)
    worker = load_worker_module()

    sent = {}

    class DummyWriter:
        def write(self, data):
            sent["body"] = data.decode("utf-8")

    request = SimpleNamespace(
        headers=authenticated_headers("31"),
        rfile=SimpleNamespace(read=Mock(return_value=b'{"spreadsheet_id":"sheet-123"}')),
        wfile=DummyWriter(),
        send_response=Mock(),
        send_header=Mock(),
        end_headers=Mock(),
    )

    service = Mock()
    service.spreadsheets.return_value.values.return_value.batchUpdate.return_value.execute.return_value = {}

    worker._load_worker_dependencies = Mock(return_value={"get_sheets_service": Mock(return_value=service)})
    worker.load_reclassify_sheet_map = Mock(return_value={"Payable": object(), "Final Detail": object()})
    worker.persist_reclassification_snapshot = Mock(return_value={"status": "skipped", "reason": "TEST"})
    worker.compute_reclassification_results = Mock(
        return_value={
            "payable_decisions": [SimpleNamespace(category="ROE", rule_id="R107")],
            "final_detail_decisions": [SimpleNamespace(category="ACC", rule_id="R201")],
        }
    )

    handler = worker.handler.__new__(worker.handler)
    handler.headers = authenticated_headers("31")
    handler.rfile = request.rfile
    handler.wfile = request.wfile
    handler.send_response = request.send_response
    handler.send_header = request.send_header
    handler.end_headers = request.end_headers
    handler.requestline = "POST /api/internal/reclassify_job HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/internal/reclassify_job"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()

    worker.handler.do_POST(handler)

    assert handler.send_response.called
    assert handler.send_response.call_args.args[0] == 200
    assert json.loads(sent["body"]) == {
        "ok": True,
        "message": "Reclassification worker completed.",
        "spreadsheet_id": "sheet-123",
        "summary": {
            "payable_rows_written": 1,
            "final_detail_rows_written": 1,
            "draw_request_rows_written": 0,
            "draw_request_matched_rows": 0,
            "draw_request_unmatched_rows": 0,
            "draw_request_ambiguous_rows": 0,
            "mapping_warning_count": 0,
            "fallback_count": 0,
            "fallback_fields": [],
        },
        "commit": {
            "api_calls": 1,
            "updated_ranges": 2,
            "responses": [{}],
        },
    }


def test_handler_fails_when_required_snapshot_manifest_is_missing(monkeypatch):
    monkeypatch.setenv("RECLASSIFY_WORKER_SECRET", TEST_WORKER_SECRET)
    worker = load_worker_module()

    sent = {}

    class DummyWriter:
        def write(self, data):
            sent["body"] = data.decode("utf-8")

    service = Mock()
    service.spreadsheets.return_value.values.return_value.batchUpdate.return_value.execute.return_value = {}

    worker._load_worker_dependencies = Mock(return_value={"get_sheets_service": Mock(return_value=service)})
    worker.load_reclassify_sheet_map = Mock(return_value={"Payable": object(), "Final Detail": object()})
    worker.persist_reclassification_snapshot = Mock(side_effect=RuntimeError("FORMULA_MAPPING_MANIFEST_MISSING"))
    worker.compute_reclassification_results = Mock(
        return_value={
            "payable_decisions": [SimpleNamespace(category="ROE", rule_id="R107")],
            "final_detail_decisions": [SimpleNamespace(category="ACC", rule_id="R201")],
        }
    )

    handler = worker.handler.__new__(worker.handler)
    handler.headers = authenticated_headers("31")
    handler.rfile = SimpleNamespace(read=Mock(return_value=b'{"spreadsheet_id":"sheet-123"}'))
    handler.wfile = DummyWriter()
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/internal/reclassify_job HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/internal/reclassify_job"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()

    worker.handler.do_POST(handler)

    assert handler.send_response.call_args.args[0] == 500
    payload = json.loads(sent["body"])
    assert payload["ok"] is False
    assert "FORMULA_MAPPING_MANIFEST_MISSING" in payload["message"]
    assert payload["spreadsheet_id"] == "sheet-123"


def test_handler_returns_explicit_failure_payload_for_missing_spreadsheet_id(monkeypatch):
    monkeypatch.setenv("RECLASSIFY_WORKER_SECRET", TEST_WORKER_SECRET)
    worker = load_worker_module()

    sent = {}

    class DummyWriter:
        def write(self, data):
            sent["body"] = data.decode("utf-8")

    handler = worker.handler.__new__(worker.handler)
    handler.headers = authenticated_headers("2")
    handler.rfile = SimpleNamespace(read=Mock(return_value=b"{}"))
    handler.wfile = DummyWriter()
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/internal/reclassify_job HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/internal/reclassify_job"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()

    worker.handler.do_POST(handler)

    assert handler.send_response.call_args.args[0] == 400
    assert json.loads(sent["body"]) == {
        "ok": False,
        "message": "spreadsheet_id is required",
    }


def test_handler_supports_validate_only_without_writing_updates(monkeypatch):
    monkeypatch.setenv("RECLASSIFY_WORKER_SECRET", TEST_WORKER_SECRET)
    worker = load_worker_module()

    sent = {}

    class DummyWriter:
        def write(self, data):
            sent["body"] = data.decode("utf-8")

    request_body = json.dumps({"spreadsheet_id": "sheet-123", "validate_only": True}).encode("utf-8")

    service = Mock()
    batch_get_response = {
        "valueRanges": [
            {"values": [["ROE", "R107"]]},
            {"values": [["ACC", "R201"]]},
        ]
    }
    service.spreadsheets.return_value.values.return_value.batchGet.return_value.execute.return_value = batch_get_response

    worker._load_worker_dependencies = Mock(return_value={"get_sheets_service": Mock(return_value=service)})
    worker.load_reclassify_sheet_map = Mock(return_value={"Payable": object(), "Final Detail": object()})
    worker.ensure_scoping_final_gmp_before_reclassification = Mock(return_value={"inserted": True})
    worker.persist_reclassification_snapshot = Mock(return_value={"status": "skipped", "reason": "TEST"})
    worker.compute_reclassification_results = Mock(
        return_value={
            "payable_decisions": [SimpleNamespace(category="ROE", rule_id="R107")],
            "final_detail_decisions": [SimpleNamespace(category="ACC", rule_id="R201")],
        }
    )

    handler = worker.handler.__new__(worker.handler)
    handler.headers = authenticated_headers(len(request_body))
    handler.rfile = SimpleNamespace(read=Mock(return_value=request_body))
    handler.wfile = DummyWriter()
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/internal/reclassify_job HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/internal/reclassify_job"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()

    worker.handler.do_POST(handler)

    worker.ensure_scoping_final_gmp_before_reclassification.assert_not_called()
    service.spreadsheets.return_value.batchUpdate.assert_not_called()
    service.spreadsheets.return_value.values.return_value.batchUpdate.assert_not_called()
    assert handler.send_response.call_args.args[0] == 200
    payload = json.loads(sent["body"])
    assert isinstance(payload["validation"]["checked_at"], str)
    assert payload["validation"]["checked_at"]
    payload["validation"]["checked_at"] = "<timestamp>"
    assert payload == {
        "ok": True,
        "message": "Reclassification validation completed.",
        "spreadsheet_id": "sheet-123",
        "validation": {
            "status": "ok",
            "checked_at": "<timestamp>",
            "totals": {
                "total_rows": 2,
                "matched_rows": 2,
                "mismatch_count": 0,
            },
            "sheets": {
                "payable": {
                    "sheet": "Payable",
                    "total_rows": 1,
                    "matched_rows": 1,
                    "mismatch_count": 0,
                    "mismatches": [],
                },
                "final_detail": {
                    "sheet": "Final Detail",
                    "total_rows": 1,
                    "matched_rows": 1,
                    "mismatch_count": 0,
                    "mismatches": [],
                },
            },
            "sample_mismatches": [],
            "message": "重分类校验通过",
        },
    }


def test_handler_supports_explicit_final_gmp_schema_operation(monkeypatch):
    monkeypatch.setenv("RECLASSIFY_WORKER_SECRET", TEST_WORKER_SECRET)
    worker = load_worker_module()

    sent = {}

    class DummyWriter:
        def write(self, data):
            sent["body"] = data.decode("utf-8")

    request_body = json.dumps(
        {"spreadsheet_id": "sheet-123", "operation": "ensure_final_gmp_schema"}
    ).encode("utf-8")

    service = Mock()
    worker._load_worker_dependencies = Mock(return_value={"get_sheets_service": Mock(return_value=service)})
    worker.load_reclassify_sheet_map = Mock(return_value={"Payable": object(), "Final Detail": object()})
    worker.ensure_scoping_final_gmp_before_reclassification = Mock(
        return_value={"inserted": True, "final_gmp_col_1based": 6}
    )
    worker.compute_reclassification_results = Mock()
    worker.push_reclassify_updates = Mock()
    worker.persist_reclassification_snapshot = Mock()

    handler = worker.handler.__new__(worker.handler)
    handler.headers = authenticated_headers(len(request_body))
    handler.rfile = SimpleNamespace(read=Mock(return_value=request_body))
    handler.wfile = DummyWriter()
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/internal/reclassify_job HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/internal/reclassify_job"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()

    worker.handler.do_POST(handler)

    worker.ensure_scoping_final_gmp_before_reclassification.assert_called_once()
    worker.compute_reclassification_results.assert_not_called()
    worker.push_reclassify_updates.assert_not_called()
    worker.persist_reclassification_snapshot.assert_not_called()
    assert handler.send_response.call_args.args[0] == 200
    assert json.loads(sent["body"]) == {
        "ok": True,
        "message": "Final GMP schema migration completed.",
        "operation": "ensure_final_gmp_schema",
        "spreadsheet_id": "sheet-123",
        "final_gmp": {"inserted": True, "final_gmp_col_1based": 6},
    }


def test_build_draw_request_cost_state_updates_uses_semantic_vendor_and_amount_to_disambiguate():
    worker = load_worker_module()

    payable_sheet = pd.DataFrame(
        [
            ["INV-001", "20_56", "Direct", "Vendor A", 100.0],
            ["INV-001", "20_56", "Income", "Vendor B", 200.0],
        ],
        columns=["Invoice No", "Cost Code", "Cost State", "Vendor", "Amount"],
    )
    draw_request_sheet = pd.DataFrame(
        [
            ["Project Name", "Sandy", "", "", "", ""],
            ["Draw Invoice", "Invoiced No", "Cost Code", "Vendor", "Amount", "Type"],
            ["D-01", "INV-001", "20_56", "Vendor A", 100.0, "AUTO"],
            ["D-02", "INV-001", "20_56", "Vendor B", 200.0, "AUTO"],
        ],
        columns=["col_1", "col_2", "col_3", "col_4", "col_5", "col_6"],
    )
    sheet_map = {
        "Payable": payable_sheet,
        "Draw request report": draw_request_sheet,
    }

    updates, summary = worker.build_draw_request_cost_state_updates(sheet_map)

    assert [item["values"] for item in updates] == [[["Direct"]], [["Income"]]]
    assert summary["draw_request_rows_written"] == 2
    assert summary["draw_request_matched_rows"] == 2
    assert summary["draw_request_ambiguous_rows"] == 0


def test_build_snapshot_payload_preserves_formula_templates_with_placeholders():
    worker = load_worker_module()
    results = {
        "payable_decisions": [SimpleNamespace(category="ROE", rule_id="R107")],
        "final_detail_decisions": [SimpleNamespace(category="ACC", rule_id="R201")],
        "mapping_metrics": {"mapping_warning_count": 0, "fallback_count": 0, "fallback_fields": []},
        "mapping_warnings": [],
    }
    payload, manifest = worker.build_snapshot_payload(
        spreadsheet_id="sheet-123",
        sync_run_id="run-123",
        code_manifest_hash="hash-abc",
        reclassify_summary={"payable_rows_written": 1, "final_detail_rows_written": 1},
        results=results,
        dashboard_summary={
            "project_name": "Snapshot Project",
            "highlights": [{"label": "收入", "value": "$1", "color": "green"}],
            "audit_tabs": {
                "external_recon": {"summary": "本次同步指标"},
                "manual_input": {"profit_statement_entries": [1]},
                "reclass_audit": {"overview": {"payable_count": 1}},
                "compare_109": {"metric_rows": [{"label": "收入", "year_rows": []}]},
            },
        },
        formula_mapping_manifest={
            "version": 1,
            "source": "snapshot_frozen",
            "mappings": {"Payable": {"amount": 21, "cost_code": 1, "year": 11}},
            "mapping_hash": "mapping-hash",
        },
        formula_plan_input=[
            {
                "sheet": "109",
                "cell": "N40",
                "logic": "Actual Warranty Expenses (Reversed)",
                "formula_template": '=SUMIFS(Payable!${Payable.amount}, Payable!${Payable.cost_code}, "RACC2", Payable!${Payable.year}, ${SELF_COL}10)',
            }
        ],
    )

    assert payload["formula_plan_template_count"] == 1
    assert payload["formula_plan_templates"][0]["formula_template"].count("${") == 4
    assert payload["classification_decisions"]["payable"][0]["category"] == "ROE"
    assert manifest["code_manifest_hash"] == "hash-abc"
    assert manifest["payload_size_bytes"] > 0


def test_build_snapshot_payload_rejects_empty_dashboard_summary():
    worker = load_worker_module()

    try:
        worker.build_snapshot_payload(
            spreadsheet_id="sheet-123",
            sync_run_id="run-123",
            code_manifest_hash="hash-abc",
            reclassify_summary={"payable_rows_written": 1},
            results={
                "payable_decisions": [],
                "final_detail_decisions": [],
                "mapping_metrics": {},
                "mapping_warnings": [],
            },
            formula_plan_input=[],
            dashboard_summary={
                "project_name": "Empty Snapshot",
                "highlights": [
                    {"label": "收入", "value": "-", "color": "slate"},
                    {"label": "成本", "value": "-", "color": "slate"},
                ],
                "audit_tabs": {
                    "external_recon": {"summary": "后台快照已更新，前端将直接渲染快照摘要。"},
                    "compare_109": {"metric_rows": []},
                },
            },
        )
    except RuntimeError as exc:
        assert "DASHBOARD_SUMMARY_INCOMPLETE" in str(exc)
    else:
        raise AssertionError("empty dashboard summary should be rejected")


def test_persist_reclassification_snapshot_skips_when_supabase_env_missing(monkeypatch):
    worker = load_worker_module()
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("NEXT_PUBLIC_SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    result = worker.persist_reclassification_snapshot(
        spreadsheet_id="sheet-123",
        reclassify_summary={"payable_rows_written": 1},
        results={
            "payable_decisions": [],
            "final_detail_decisions": [],
            "mapping_metrics": {},
            "mapping_warnings": [],
        },
    )

    assert result["status"] == "skipped"
    assert result["reason"] == "SUPABASE_ENV_MISSING"
