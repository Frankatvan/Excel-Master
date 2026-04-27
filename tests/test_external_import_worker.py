from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest


WORKER_PATH = (
    Path(__file__).resolve().parents[1]
    / "excel-master-app"
    / "api"
    / "logic"
    / "aiwb_finance"
    / "external_import_worker.py"
)


def load_worker_module():
    spec = importlib.util.spec_from_file_location("external_import_worker", WORKER_PATH)
    assert spec and spec.loader, "worker module spec should be loadable"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def grid(sheet_id=101, rows=4, columns=3, start_row=10, start_column=2, fingerprint="fp-101"):
    return {
        "sheetId": sheet_id,
        "startRowIndex": start_row,
        "endRowIndex": start_row + rows,
        "startColumnIndex": start_column,
        "endColumnIndex": start_column + columns,
        "fingerprint": fingerprint,
    }


def table(
    key,
    headers=None,
    rows=None,
    source_role="uploaded",
    detected=False,
    file_name="budget.xlsx",
    sheet_name="Sheet1",
):
    return {
        "source_table": key,
        "target_zone_key": key,
        "source_role": source_role,
        "detected": detected,
        "source_file_name": file_name,
        "source_sheet_name": sheet_name,
        "file_hash": "hash-123",
        "headers": headers or ["Name", "Amount"],
        "rows": rows or [["A", 10], ["B", 20]],
    }


def test_only_uploaded_or_detected_tables_are_cleared_and_written():
    worker = load_worker_module()
    resolved_zones = {
        "uploaded_table": grid(sheet_id=1),
        "detected_table": grid(sheet_id=2),
        "reference_table": grid(sheet_id=3),
    }
    parsed_tables = [
        table("uploaded_table", source_role="uploaded"),
        table("detected_table", source_role="system", detected=True),
        table("reference_table", source_role="system", detected=False),
    ]

    plan = worker.build_external_import_plan(resolved_zones, parsed_tables)

    request_sheet_ids = [
        request.get("repeatCell", request.get("updateCells"))["range"]["sheetId"]
        for request in plan["requests"]
    ]
    assert request_sheet_ids == [1, 1, 2, 2]
    assert [item["status"] for item in plan["manifest"]] == ["imported", "imported", "stale"]


def test_writes_use_structured_grid_ranges():
    worker = load_worker_module()

    plan = worker.build_external_import_plan({"costs": grid(sheet_id=91)}, [table("costs")])

    write_request = plan["requests"][1]["updateCells"]
    assert "range" in write_request
    assert write_request["range"] == {
        "sheetId": 91,
        "startRowIndex": 10,
        "endRowIndex": 13,
        "startColumnIndex": 2,
        "endColumnIndex": 4,
    }
    assert "range" not in write_request.get("rows", [{}])[0]
    assert not any("values" in request for request in plan["requests"])


def test_extra_columns_are_written_when_capacity_allows():
    worker = load_worker_module()
    source = table(
        "costs",
        headers=["Name", "Amount", "Memo"],
        rows=[["A", 10, "one"], ["B", 20, "two"]],
    )

    plan = worker.build_external_import_plan({"costs": grid(columns=3)}, [source])

    row_values = plan["requests"][1]["updateCells"]["rows"]
    assert [
        cell["userEnteredValue"]["stringValue"] for cell in row_values[0]["values"]
    ] == ["Name", "Amount", "Memo"]
    assert row_values[1]["values"][2]["userEnteredValue"]["stringValue"] == "one"
    assert plan["manifest"][0]["column_count"] == 3
    assert plan["manifest"][0]["schema_drift"]["extra_columns"] == ["Memo"]


def test_capacity_exceeded_blocks_import_plan():
    worker = load_worker_module()
    source = table(
        "costs",
        headers=["Name", "Amount", "Memo"],
        rows=[["A", 10, "one"], ["B", 20, "two"]],
    )

    with pytest.raises(worker.CapacityExceededError) as error:
        worker.build_external_import_plan({"costs": grid(rows=2, columns=2)}, [source])

    assert error.value.details == {
        "target_zone_key": "costs",
        "required_rows": 3,
        "available_rows": 2,
        "required_columns": 3,
        "available_columns": 2,
    }


def test_capacity_check_accepts_nested_grid_range_resolver_shape():
    worker = load_worker_module()
    source = table("costs", headers=["Name", "Amount"], rows=[["A", 10]])

    plan = worker.build_external_import_plan(
        {"costs": {"gridRange": grid(rows=3, columns=2), "fingerprint": "zone-fp"}},
        [source],
    )

    assert plan["requests"][1]["updateCells"]["range"]["sheetId"] == 101
    assert plan["manifest"][0]["resolved_zone_fingerprint"] == "zone-fp"


def test_validate_input_runs_after_successful_write():
    worker = load_worker_module()
    events = []

    def batch_update(spreadsheet_id, requests):
        events.append(("write", spreadsheet_id, len(requests)))
        return {"replies": [{}, {}]}

    def validate_input(spreadsheet_id, manifest):
        events.append(("validate", spreadsheet_id, len(manifest)))
        return {"ok": True, "details": {"checked": True}}

    result = worker.run_external_import_job(
        {
            "spreadsheet_id": "sheet-1",
            "resolved_zones": {"costs": grid()},
            "parsed_tables": [table("costs")],
        },
        batch_update=batch_update,
        validate_input=validate_input,
    )

    assert events == [("write", "sheet-1", 2), ("validate", "sheet-1", 1)]
    assert result["job_status"] == "succeeded"
    assert result["manifest_status"] == "validated"


def test_validation_failure_preserves_import_requests_but_marks_failed_outcome():
    worker = load_worker_module()

    def batch_update(spreadsheet_id, requests):
        return {"replies": [{}, {}], "request_count": len(requests)}

    def validate_input(spreadsheet_id, manifest):
        return {"ok": False, "errors": [{"code": "MISSING_REQUIRED_FIELD"}]}

    result = worker.run_external_import_job(
        {
            "spreadsheet_id": "sheet-1",
            "resolved_zones": {"costs": grid()},
            "parsed_tables": [table("costs")],
        },
        batch_update=batch_update,
        validate_input=validate_input,
    )

    assert result["job_status"] == "failed"
    assert result["manifest_status"] == "failed"
    assert result["validation"] == {"ok": False, "errors": [{"code": "MISSING_REQUIRED_FIELD"}]}
    assert result["import_requests"]
    assert result["write_result"] == {"replies": [{}, {}], "request_count": 2}


def test_manifest_item_payload_contains_source_and_target_audit_fields():
    worker = load_worker_module()

    item = worker.build_manifest_item_payload(
        table(
            "costs",
            headers=["Name", "Amount", "Memo"],
            rows=[["A", 10, "x"], ["B", 20.5, "y"]],
            file_name="costs.xlsx",
            sheet_name="Export",
        ),
        grid(fingerprint="zone-fp"),
        status="imported",
    )

    assert item == {
        "source_table": "costs",
        "source_file_name": "costs.xlsx",
        "source_sheet_name": "Export",
        "file_hash": "hash-123",
        "header_signature": worker.header_signature(["Name", "Amount", "Memo"]),
        "row_count": 2,
        "column_count": 3,
        "amount_total": 30.5,
        "target_zone_key": "costs",
        "resolved_zone_fingerprint": "zone-fp",
        "status": "imported",
        "schema_drift": {"extra_columns": ["Memo"], "missing_columns": []},
    }


def test_production_worker_file_has_no_hardcoded_target_coordinates():
    source = WORKER_PATH.read_text(encoding="utf-8")
    coordinate_pattern = re.compile(r"\b[A-Z]{1,3}\$?[0-9]+\b|![A-Z]{1,3}:|![A-Z]{1,3}\$?\d")

    assert coordinate_pattern.findall(source) == []
