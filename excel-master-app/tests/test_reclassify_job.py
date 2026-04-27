import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[1]
LOGIC_DIR = ROOT / "api" / "logic"
if str(LOGIC_DIR) not in sys.path:
    sys.path.append(str(LOGIC_DIR))

from finance_utils import _values_to_dataframe


def _load_reclassify_job_module():
    module_path = ROOT / "api" / "internal" / "reclassify_job.py"
    spec = importlib.util.spec_from_file_location("reclassify_job", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


reclassify_job = _load_reclassify_job_module()


def test_worker_exports_scoping_final_gmp_migration_dependency():
    deps = reclassify_job._load_worker_dependencies()

    assert callable(deps["_ensure_scoping_final_gmp_rows"])
    assert callable(deps["_get_sheet_metadata"])
    assert callable(deps["_build_scoping_final_gmp_insert_requests"])


def test_handler_migrates_scoping_final_gmp_before_computing_reclassification(monkeypatch):
    sent = {}
    old_sheet_map = {
        "Scoping": _values_to_dataframe(
            [
                ["Group Number", "Group Name", "GMP", "Fee"],
                ["101", "Group 101", "1", ""],
            ]
        ),
        "Payable": object(),
        "Final Detail": object(),
        "Unit Budget": object(),
        "Unit Master": object(),
    }
    migrated_sheet_map = {
        "Scoping": _values_to_dataframe(
            [
                ["Group Number", "Group Name", "GMP", "Final GMP", "Fee"],
                ["101", "Group 101", "1", "1", ""],
            ]
        ),
        "Payable": object(),
        "Final Detail": object(),
        "Unit Budget": object(),
        "Unit Master": object(),
    }

    class DummyWriter:
        def write(self, data):
            sent["body"] = data.decode("utf-8")

    service = Mock()
    service.spreadsheets.return_value.get.return_value.execute.return_value = {
        "sheets": [
            {
                "properties": {
                    "title": "Scoping",
                    "sheetId": 241616920,
                    "gridProperties": {"rowCount": 1000, "columnCount": 26},
                }
            }
        ]
    }
    service.spreadsheets.return_value.batchUpdate.return_value.execute.return_value = {}

    request_body = b'{"spreadsheet_id":"sheet-123"}'
    handler = reclassify_job.handler.__new__(reclassify_job.handler)
    handler.headers = {"Content-Length": str(len(request_body))}
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

    monkeypatch.setattr(
        reclassify_job,
        "_load_worker_dependencies",
        Mock(
            return_value={
                **reclassify_job._load_worker_dependencies(),
                "get_sheets_service": Mock(return_value=service),
            }
        ),
    )
    monkeypatch.setattr(
        reclassify_job,
        "load_reclassify_sheet_map",
        Mock(side_effect=[old_sheet_map, migrated_sheet_map]),
    )
    monkeypatch.setattr(
        reclassify_job,
        "compute_reclassification_results",
        Mock(
            return_value={
                "payable_decisions": [],
                "final_detail_decisions": [],
            }
        ),
    )
    monkeypatch.setattr(
        reclassify_job,
        "persist_reclassification_snapshot",
        Mock(return_value={"status": "skipped", "reason": "TEST"}),
    )

    reclassify_job.handler.do_POST(handler)

    service.spreadsheets.return_value.values.return_value.update.assert_not_called()
    batch_body = service.spreadsheets.return_value.batchUpdate.call_args.kwargs["body"]
    assert any("insertDimension" in request for request in batch_body["requests"])
    reclassify_job.compute_reclassification_results.assert_called_once_with(migrated_sheet_map)
    assert handler.send_response.call_args.args[0] == 200
    assert json.loads(sent["body"])["ok"] is True


def _make_row(length: int):
    return [""] * length


def test_build_draw_request_cost_state_updates_uses_strict_invoice_and_cost_code_match():
    payable = _values_to_dataframe(
        [
            ["Vendor", "Invoice No", "Cost Code", "Cost State", "Amount"],
            ["WB Home LLC", "INV-001", "1SF116", "ROE", "150.25"],
        ]
    )
    preamble = _make_row(20)
    preamble[7] = "Project Name："
    preamble[10] = "Download Date：2026-04-12 18:28"
    header = _make_row(20)
    header[7] = "Sql"
    header[8] = "Draw Date"
    header[9] = "Draw Invoice"
    header[10] = "Unit Code"
    header[11] = "Complete Stage"
    header[12] = "Incurred Date"
    header[13] = "Invoiced Date"
    header[14] = "Invoiced No"
    header[15] = "Activity"
    header[16] = "Cost Code"
    header[17] = "Type"
    header[18] = "Vendor"
    header[19] = "Amount"
    data = _make_row(20)
    data[7] = "2"
    data[8] = "2024-05-31"
    data[9] = "WPRED-SandyCove-00"
    data[10] = "WBWT Sandy Cove Common"
    data[12] = "2024-05-01"
    data[13] = "2024-05-01"
    data[14] = "INV-001"
    data[15] = "Permit"
    data[16] = "1SF116"
    data[17] = "AUTOR"
    data[18] = "WB Home LLC"
    data[19] = "150.25"
    draw_request = _values_to_dataframe([preamble, header, data])

    updates, summary = reclassify_job.build_draw_request_cost_state_updates(
        {
            "Payable": payable,
            "Draw request report": draw_request,
        }
    )

    assert updates == [
        {
            "range": "'Draw request report'!C3:C3",
            "values": [["ROE"]],
        }
    ]
    assert summary["draw_request_rows_written"] == 1
    assert summary["draw_request_matched_rows"] == 1
    assert summary["draw_request_unmatched_rows"] == 0
    assert summary["draw_request_ambiguous_rows"] == 0


def test_build_draw_request_cost_state_updates_does_not_fallback_to_draw_invoice_or_invoice_only():
    payable = _values_to_dataframe(
        [
            ["Vendor", "Invoice No", "Cost Code", "Cost State", "Amount"],
            ["Wan Pacific Real Estate Development LLC", "WPRED-SandyCove-11", "3GN896", "Income", "45473.05"],
        ]
    )
    preamble = _make_row(20)
    preamble[7] = "Project Name："
    preamble[10] = "Download Date：2026-04-12 18:28"
    header = _make_row(20)
    header[7] = "Sql"
    header[8] = "Draw Date"
    header[9] = "Draw Invoice"
    header[10] = "Unit Code"
    header[11] = "Complete Stage"
    header[12] = "Incurred Date"
    header[13] = "Invoiced Date"
    header[14] = "Invoiced No"
    header[15] = "Activity"
    header[16] = "Cost Code"
    header[17] = "Type"
    header[18] = "Vendor"
    header[19] = "Amount"
    data = _make_row(20)
    data[7] = "910"
    data[8] = "2025-04-30"
    data[9] = "WPRED-SandyCove-11"
    data[10] = "WBWT Sandy Cove Common"
    data[12] = "2025-04-01"
    data[13] = "2025-04-01"
    data[15] = "AUTOR"
    data[16] = "2HD540"
    data[17] = "AUTOR"
    data[18] = "The Home Depot"
    data[19] = "84.61"
    draw_request = _values_to_dataframe([preamble, header, data])

    updates, summary = reclassify_job.build_draw_request_cost_state_updates(
        {
            "Payable": payable,
            "Draw request report": draw_request,
        }
    )

    assert updates == [
        {
            "range": "'Draw request report'!C3:C3",
            "values": [[""]],
        }
    ]
    assert summary["draw_request_rows_written"] == 1
    assert summary["draw_request_matched_rows"] == 0
    assert summary["draw_request_unmatched_rows"] == 1
    assert summary["draw_request_ambiguous_rows"] == 0


def test_build_reclassify_updates_includes_draw_request_c_updates():
    class Decision:
        def __init__(self, category, rule_id):
            self.category = category
            self.rule_id = rule_id

    updates, summary = reclassify_job.build_reclassify_updates(
        {
            "payable_decisions": [Decision("Direct", "R101")],
            "final_detail_decisions": [Decision("Consulting", "R202")],
            "draw_request_updates": [
                {"range": "'Draw request report'!C3:C3", "values": [["ROE"]]},
                {"range": "'Draw request report'!C4:C4", "values": [[""]]},
            ],
            "draw_request_summary": {
                "draw_request_rows_written": 2,
                "draw_request_matched_rows": 1,
                "draw_request_unmatched_rows": 1,
                "draw_request_ambiguous_rows": 0,
            },
        }
    )

    assert updates[-2:] == [
        {"range": "'Draw request report'!C3:C3", "values": [["ROE"]]},
        {"range": "'Draw request report'!C4:C4", "values": [[""]]},
    ]
    assert summary == {
        "payable_rows_written": 1,
        "final_detail_rows_written": 1,
        "draw_request_rows_written": 2,
        "draw_request_matched_rows": 1,
        "draw_request_unmatched_rows": 1,
        "draw_request_ambiguous_rows": 0,
        "mapping_warning_count": 0,
        "fallback_count": 0,
        "fallback_fields": [],
    }


def test_coerce_sheet_values_to_dataframe_preserves_wider_rows_after_a_short_preamble():
    values = [
        ["", "", "", "", "", "", "", "Project Name：", "", "", "Download Date：2026-04-12 18:28"],
        ["", "", "", "", "", "", "", "Sql", "Draw Date", "Draw Invoice", "Unit Code", "Complete Stage", "Incurred Date", "Invoiced Date", "Invoiced No", "Activity", "Cost Code", "Type", "Vendor", "Amount"],
        ["", "", "", "", "", "", "", "910", "2025-04-30", "WPRED-SandyCove-11", "WBWT Sandy Cove Common", "", "2025-04-01", "2025-04-01", "", "AUTOR", "2HD540", "AUTOR", "The Home Depot", "84.61"],
    ]

    df = reclassify_job.coerce_sheet_values_to_dataframe(values)

    assert len(df.columns) == 20
    assert df.iloc[0, 14] == "Invoiced No"
    assert df.iloc[0, 16] == "Cost Code"
    assert df.iloc[1, 18] == "The Home Depot"
