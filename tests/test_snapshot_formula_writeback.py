from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import finance_engine as fe


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    def execute(self):
        return self._payload


class _FakeValuesApi:
    def __init__(self, batch_get_payload=None):
        self._batch_get_payload = batch_get_payload or {"valueRanges": []}

    def batchGet(self, **_kwargs):
        return _FakeRequest(self._batch_get_payload)


class _FakeSpreadsheetsApi:
    def __init__(self, metadata_payload, batch_get_payload=None):
        self._metadata_payload = metadata_payload
        self._values = _FakeValuesApi(batch_get_payload)

    def get(self, **_kwargs):
        return _FakeRequest(self._metadata_payload)

    def values(self):
        return self._values


class _FakeSheetsService:
    def __init__(self, metadata_payload, batch_get_payload=None):
        self._spreadsheets = _FakeSpreadsheetsApi(metadata_payload, batch_get_payload)

    def spreadsheets(self):
        return self._spreadsheets


def test_load_current_snapshot_formula_plan_uses_project_sequence_when_sheet_title_missing(monkeypatch):
    snapshot_row = {
        "id": "snapshot-1",
        "sync_run_id": "run-1",
        "sync_run_status": "succeeded",
        "data_json": {
            "formula_mapping_manifest": {
                "version": 1,
                "source": "snapshot_frozen",
                "mappings": {"Payable": {"amount": 21, "cost_code": 1, "year": 11}},
            },
            "formula_plan_templates": [
                {
                    "sheet": "",
                    "cell": "N40",
                    "logic": "Actual Warranty Expenses (Reversed)",
                    "formula_template": '=SUMIFS(Payable!${Payable.amount}, Payable!${Payable.cost_code}, "RACC2", Payable!${Payable.year}, ${SELF_COL}10)',
                }
            ]
        },
    }

    monkeypatch.setattr(fe, "_fetch_current_formula_snapshot_row", lambda *_args, **_kwargs: snapshot_row)
    monkeypatch.setattr(fe, "_fetch_project_main_sheet_title", lambda **_kwargs: "110")
    monkeypatch.setattr(
        fe.MappingService,
        "get_project_mappings",
        staticmethod(lambda _project_id: {"Payable": {"amount": 99, "cost_code": 98, "year": 97}}),
    )

    plan, meta = fe.load_current_snapshot_formula_plan(
        project_id="project-1",
        spreadsheet_id="sheet-1",
    )

    assert plan == [
        {
            "sheet": "110",
            "cell": "N40",
            "range": "'110'!N40",
            "formula": '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "RACC2", Payable!$K:$K, $N10)',
            "logic": "Actual Warranty Expenses (Reversed)",
            "formula_template": '=SUMIFS(Payable!${Payable.amount}, Payable!${Payable.cost_code}, "RACC2", Payable!${Payable.year}, ${SELF_COL}10)',
        }
    ]
    assert meta["source"] == "current_snapshot"
    assert meta["snapshot_id"] == "snapshot-1"
    assert meta["formula_mapping_project_id"] == "project-1"
    assert meta["sheet"] == "110"
    assert meta["required_mapping_fields"] == {"Payable": ["amount", "cost_code", "year"]}
    assert meta["formula_mapping_source"] == "snapshot_frozen"


def test_load_current_snapshot_formula_plan_rejects_placeholder_templates_without_frozen_mapping(monkeypatch):
    snapshot_row = {
        "id": "snapshot-1",
        "sync_run_id": "run-1",
        "sync_run_status": "succeeded",
        "data_json": {
            "formula_plan_templates": [
                {
                    "sheet": "109",
                    "cell": "N40",
                    "logic": "Actual Warranty Expenses (Reversed)",
                    "formula_template": '=SUMIFS(Payable!${Payable.amount}, Payable!${Payable.cost_code}, "RACC2")',
                }
            ]
        },
    }
    monkeypatch.setattr(fe, "_fetch_current_formula_snapshot_row", lambda *_args, **_kwargs: snapshot_row)

    with pytest.raises(RuntimeError, match="CURRENT_SNAPSHOT_MAPPING_MANIFEST_MISSING"):
        fe.load_current_snapshot_formula_plan(
            project_id="project-1",
            spreadsheet_id="sheet-1",
            sheet_109_title="109",
        )


def test_load_current_snapshot_formula_plan_requires_succeeded_snapshot(monkeypatch):
    snapshot_row = {
        "id": "snapshot-2",
        "sync_run_status": "running",
        "data_json": {"formula_plan_templates": []},
    }
    monkeypatch.setattr(fe, "_fetch_current_formula_snapshot_row", lambda *_args, **_kwargs: snapshot_row)

    with pytest.raises(RuntimeError, match="CURRENT_SNAPSHOT_NOT_SUCCEEDED"):
        fe.load_current_snapshot_formula_plan(
            project_id="project-1",
            spreadsheet_id="sheet-1",
            sheet_109_title="109",
        )


def test_validate_snapshot_writeback_consistency_blocks_missing_required_sheet(monkeypatch):
    service = _FakeSheetsService(
        {
            "sheets": [
                {"properties": {"title": "109", "gridProperties": {"rowCount": 300, "columnCount": 40}}},
            ]
        }
    )
    monkeypatch.setattr(fe, "_supabase_rest_request_json", lambda **_kwargs: [])
    monkeypatch.setattr(
        fe,
        "_resolve_writeback_formula_mappings",
        lambda **_kwargs: {"Payable": {"amount": 21, "cost_code": 1, "year": 11}},
    )

    with pytest.raises(fe.SnapshotStaleError, match="SNAPSHOT_STALE_ERROR: MISSING_SHEETS Payable"):
        fe.validate_snapshot_writeback_consistency(
            service=service,
            spreadsheet_id="sheet-1",
            project_id="project-1",
            snapshot_meta={
                "sync_run_id": "run-1",
                "required_mapping_fields": {"Payable": ["amount", "cost_code", "year"]},
            },
            plan=[{"sheet": "109", "cell": "N40"}],
        )


def test_validate_snapshot_writeback_consistency_blocks_discovery_header_drift(monkeypatch):
    service = _FakeSheetsService(
        {
            "sheets": [
                {"properties": {"title": "109", "gridProperties": {"rowCount": 300, "columnCount": 40}}},
                {"properties": {"title": "Payable", "gridProperties": {"rowCount": 500, "columnCount": 60}}},
            ]
        },
        {
            "valueRanges": [
                {"range": "'Payable'!A1:ZZ1", "values": [["foo", "bar", "baz"]]},
            ]
        },
    )

    def _fake_rest(**kwargs):
        if kwargs.get("resource") == "sheet_discovery_snapshots":
            return [
                {
                    "sheet_name": "Payable",
                    "header_row_index": 1,
                    "header_cells_json": ["Amount", "Cost Code", "Incurred Date"],
                }
            ]
        return []

    monkeypatch.setattr(fe, "_supabase_rest_request_json", _fake_rest)
    monkeypatch.setattr(
        fe,
        "_resolve_writeback_formula_mappings",
        lambda **_kwargs: {"Payable": {"amount": 21, "cost_code": 1, "year": 10}},
    )

    with pytest.raises(fe.SnapshotStaleError, match="SNAPSHOT_STALE_ERROR: HEADER_DRIFT Payable"):
        fe.validate_snapshot_writeback_consistency(
            service=service,
            spreadsheet_id="sheet-1",
            project_id="project-1",
            snapshot_meta={
                "sync_run_id": "run-1",
                "required_mapping_fields": {"Payable": ["amount", "cost_code", "year"]},
            },
            plan=[{"sheet": "109", "cell": "N40"}],
        )


def test_validate_snapshot_writeback_consistency_blocks_formula_row_fingerprint_drift(monkeypatch):
    service = _FakeSheetsService(
        {
            "sheets": [
                {"properties": {"title": "109", "gridProperties": {"rowCount": 300, "columnCount": 40}}},
                {"properties": {"title": "Payable", "gridProperties": {"rowCount": 500, "columnCount": 60}}},
            ]
        },
        {
            "valueRanges": [
                {"range": "'109'!C40:D40", "values": [["Wrong Label", ""]]},
            ]
        },
    )

    monkeypatch.setattr(fe, "_supabase_rest_request_json", lambda **_kwargs: [])
    monkeypatch.setattr(
        fe,
        "_resolve_writeback_formula_mappings",
        lambda **_kwargs: {"Payable": {"amount": 21, "cost_code": 1, "year": 10}},
    )

    with pytest.raises(fe.SnapshotStaleError, match="SNAPSHOT_STALE_ERROR: FORMULA_ROW_DRIFT 109!N40"):
        fe.validate_snapshot_writeback_consistency(
            service=service,
            spreadsheet_id="sheet-1",
            project_id="project-1",
            snapshot_meta={
                "sync_run_id": "run-1",
                "required_mapping_fields": {"Payable": ["amount", "cost_code", "year"]},
            },
            plan=[
                {
                    "sheet": "109",
                    "cell": "N40",
                    "range": "'109'!N40",
                    "row_fingerprint": {"label_cells": ["Actual Warranty Expenses (Reversed)", ""]},
                }
            ],
        )


def test_apply_109_formula_lock_protection_replaces_existing_managed_formula_locks(monkeypatch):
    service = MagicMock()
    monkeypatch.setattr(
        fe,
        "_get_109_sheet_metadata",
        lambda *_args, **_kwargs: {
            "sheet_id": 110,
            "protected_ranges": [
                {"protectedRangeId": 5001, "description": "AiWB managed formula lock: 1"},
                {"protectedRangeId": 5002, "description": fe.MANAGED_109_PROTECTION_DESCRIPTION},
            ],
        },
    )
    monkeypatch.setattr(fe, "_get_service_account_info", lambda: {"client_email": "robot@example.com"})

    result = fe._apply_109_formula_lock_protection(
        service=service,
        spreadsheet_id="sheet-1",
        plan=[
            {"range": "'110'!N40", "formula": "=1"},
            {"range": "'110'!O40", "formula": "=2"},
            {"range": "'Payable'!A2", "formula": "=3"},
        ],
        sheet_109_title="110",
    )

    requests = service.spreadsheets.return_value.batchUpdate.call_args.kwargs["body"]["requests"]
    assert {"deleteProtectedRange": {"protectedRangeId": 5001}} in requests
    assert {"deleteProtectedRange": {"protectedRangeId": 5002}} not in requests
    add_requests = [item for item in requests if "addProtectedRange" in item]
    assert len(add_requests) == 1
    protected_range = add_requests[0]["addProtectedRange"]["protectedRange"]
    assert protected_range["description"] == "AiWB managed formula lock: 1"
    assert protected_range["range"] == {
        "sheetId": 110,
        "startRowIndex": 39,
        "endRowIndex": 40,
        "startColumnIndex": 13,
        "endColumnIndex": 15,
    }

    assert result["formula_lock_range_count"] == 1
    assert result["formula_lock_ranges"] == ["'110'!N40:O40"]
