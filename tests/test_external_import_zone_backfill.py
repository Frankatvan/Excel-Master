import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


ROOT_DIR = Path(__file__).resolve().parents[1]
WORKER_MODULE_PATH = ROOT_DIR / "excel-master-app" / "api" / "project_bootstrap.py"
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))


def _load_worker_module():
    module_spec = importlib.util.spec_from_file_location("aiwb_project_bootstrap_worker_app", WORKER_MODULE_PATH)
    if module_spec is None or module_spec.loader is None:
        raise RuntimeError("Failed to load project bootstrap worker module.")
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


worker = _load_worker_module()


class DummyWriter:
    def __init__(self):
        self.body = ""

    def write(self, data):
        self.body = data.decode("utf-8")


def _make_worker_handler(request_body: bytes, headers: dict[str, str] | None = None):
    test_handler = worker.handler.__new__(worker.handler)
    test_handler.headers = {"Content-Length": str(len(request_body)), **(headers or {})}
    test_handler.rfile = SimpleNamespace(read=MagicMock(return_value=request_body))
    test_handler.wfile = DummyWriter()
    test_handler.send_response = MagicMock()
    test_handler.send_header = MagicMock()
    test_handler.end_headers = MagicMock()
    test_handler.requestline = "POST /api/project_bootstrap HTTP/1.1"
    test_handler.command = "POST"
    test_handler.path = "/api/project_bootstrap"
    test_handler.request_version = "HTTP/1.1"
    test_handler.client_address = ("127.0.0.1", 0)
    test_handler.server = MagicMock()
    return test_handler


class ExternalImportZoneBackfillTests(unittest.TestCase):
    def test_backfill_external_import_zone_metadata_only_batches_metadata_requests(self):
        sheets_service = MagicMock()
        zone_requests = []
        for zone_key, source_role, sheet_id in (
            ("external_import.payable_raw", "payable", 101),
            ("external_import.final_detail_raw", "final_detail", 102),
            ("external_import.unit_budget_raw", "unit_budget", 103),
            ("external_import.draw_request_raw", "draw_request", 104),
            ("external_import.draw_invoice_list_raw", "draw_invoice_list", 105),
            ("external_import.transfer_log_raw", "transfer_log", 106),
            ("external_import.change_order_log_raw", "change_order_log", 107),
        ):
            zone_requests.append(
                {"deleteDeveloperMetadata": {"dataFilter": {"developerMetadataLookup": {"metadataLocation": {"sheetId": sheet_id}}}}}
            )
            zone_requests.append(
                {
                    "createDeveloperMetadata": {
                        "developerMetadata": {
                            "metadataKey": "aiwb.import_zone",
                            "metadataValue": json.dumps({"zone_key": zone_key, "source_role": source_role}),
                            "visibility": "DOCUMENT",
                            "location": {"sheetId": sheet_id},
                        }
                    }
                }
            )

        with patch.object(worker, "_build_external_import_zone_metadata_requests", return_value=zone_requests):
            summary = worker.backfill_external_import_zone_metadata(
                sheets_service=sheets_service,
                spreadsheet_id="sheet-777",
            )

        sheets_service.spreadsheets.return_value.batchUpdate.assert_called_once_with(
            spreadsheetId="sheet-777",
            body={"requests": zone_requests},
        )
        sheets_service.spreadsheets.return_value.values.assert_not_called()
        self.assertEqual(14, summary["external_import_zone_metadata_request_count"])
        self.assertEqual(7, summary["external_import_zone_count"])
        self.assertEqual(
            [
                "external_import.payable_raw",
                "external_import.final_detail_raw",
                "external_import.unit_budget_raw",
                "external_import.draw_request_raw",
                "external_import.draw_invoice_list_raw",
                "external_import.transfer_log_raw",
                "external_import.change_order_log_raw",
            ],
            summary["zone_keys"],
        )

    def test_handler_runs_external_import_zone_backfill_with_worker_secret(self):
        body = json.dumps(
            {
                "operation": "backfill_external_import_zones",
                "spreadsheet_id": "sheet-777",
            }
        ).encode("utf-8")
        test_handler = _make_worker_handler(body, {"X-AiWB-Worker-Secret": "test-worker-secret"})

        with (
            patch.dict(os.environ, {"PROJECT_BOOTSTRAP_WORKER_SECRET": "test-worker-secret"}, clear=True),
            patch.object(worker, "get_sheets_service", return_value=MagicMock()) as get_service,
            patch.object(
                worker,
                "backfill_external_import_zone_metadata",
                return_value={
                    "external_import_zone_metadata_request_count": 14,
                    "external_import_zone_count": 7,
                    "zone_keys": ["external_import.payable_raw"],
                    "source_roles": ["payable"],
                },
            ) as backfill,
        ):
            worker.handler.do_POST(test_handler)

        self.assertEqual(200, test_handler.send_response.call_args.args[0])
        get_service.assert_called_once()
        backfill.assert_called_once_with(sheets_service=unittest.mock.ANY, spreadsheet_id="sheet-777")
        self.assertEqual(
            {
                "status": "success",
                "spreadsheet_id": "sheet-777",
                "summary": {
                    "external_import_zone_metadata_request_count": 14,
                    "external_import_zone_count": 7,
                    "zone_keys": ["external_import.payable_raw"],
                    "source_roles": ["payable"],
                },
            },
            json.loads(test_handler.wfile.body),
        )

    def test_handler_requires_spreadsheet_id_for_external_import_zone_backfill(self):
        body = json.dumps({"operation": "backfill_external_import_zones"}).encode("utf-8")
        test_handler = _make_worker_handler(body, {"X-AiWB-Worker-Secret": "test-worker-secret"})

        with patch.dict(os.environ, {"PROJECT_BOOTSTRAP_WORKER_SECRET": "test-worker-secret"}, clear=True):
            worker.handler.do_POST(test_handler)

        self.assertEqual(400, test_handler.send_response.call_args.args[0])
        self.assertEqual(
            {"status": "error", "message": "Missing required fields: spreadsheet_id"},
            json.loads(test_handler.wfile.body),
        )


if __name__ == "__main__":
    unittest.main()
