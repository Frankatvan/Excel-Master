from __future__ import annotations

import hashlib
import json
import os
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable, Mapping, Sequence


GridRange = dict[str, int]
BatchUpdate = Callable[[str, list[dict[str, Any]]], Mapping[str, Any]]
ValidateInput = Callable[[str, list[dict[str, Any]]], Mapping[str, Any]]


class CapacityExceededError(ValueError):
    def __init__(self, details: Mapping[str, Any]):
        super().__init__("Resolved import zone capacity is too small")
        self.details = dict(details)


def header_signature(headers: Sequence[Any]) -> str:
    payload = json.dumps([str(header) for header in headers], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_external_import_plan(
    resolved_zones: Mapping[str, Mapping[str, Any]],
    parsed_tables: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    requests: list[dict[str, Any]] = []
    manifest: list[dict[str, Any]] = []

    for source_table in parsed_tables:
        target_zone_key = str(source_table.get("target_zone_key") or source_table.get("source_table") or "")
        resolved_zone = resolved_zones.get(target_zone_key)
        should_import = is_uploaded_or_detected(source_table)

        if not should_import:
            manifest.append(build_manifest_item_payload(source_table, resolved_zone, status="stale"))
            continue
        if resolved_zone is None:
            raise KeyError(f"Resolved zone is required for import table: {target_zone_key}")

        assert_capacity(source_table, resolved_zone)
        requests.append(build_clear_request(resolved_zone))
        requests.append(build_write_request(source_table, resolved_zone))
        manifest.append(build_manifest_item_payload(source_table, resolved_zone, status="imported"))

    return {"requests": requests, "manifest": manifest}


def run_external_import_job(
    payload: Mapping[str, Any],
    *,
    batch_update: BatchUpdate,
    validate_input: ValidateInput,
) -> dict[str, Any]:
    spreadsheet_id = str(payload.get("spreadsheet_id") or "")
    if not spreadsheet_id:
        raise ValueError("spreadsheet_id is required")

    plan = build_external_import_plan(
        payload.get("resolved_zones") or {},
        payload.get("parsed_tables") or [],
    )
    write_result = batch_update(spreadsheet_id, plan["requests"])
    validation = validate_input(spreadsheet_id, plan["manifest"])
    validation_ok = bool(validation.get("ok"))

    return {
        "ok": validation_ok,
        "job_status": "succeeded" if validation_ok else "failed",
        "manifest_status": "validated" if validation_ok else "failed",
        "spreadsheet_id": spreadsheet_id,
        "import_requests": plan["requests"],
        "manifest": plan["manifest"],
        "write_result": dict(write_result),
        "validation": dict(validation),
    }


def build_manifest_item_payload(
    source_table: Mapping[str, Any],
    resolved_zone: Mapping[str, Any] | None,
    *,
    status: str,
) -> dict[str, Any]:
    headers = list(source_table.get("headers") or [])
    rows = list(source_table.get("rows") or [])

    return {
        "source_table": source_table.get("source_table"),
        "source_file_name": source_table.get("source_file_name"),
        "source_sheet_name": source_table.get("source_sheet_name"),
        "file_hash": source_table.get("file_hash"),
        "header_signature": header_signature(headers),
        "row_count": len(rows),
        "column_count": len(headers),
        "amount_total": amount_total(headers, rows),
        "target_zone_key": source_table.get("target_zone_key") or source_table.get("source_table"),
        "resolved_zone_fingerprint": zone_fingerprint(resolved_zone),
        "status": status,
        "schema_drift": schema_drift(source_table),
    }


def is_uploaded_or_detected(source_table: Mapping[str, Any]) -> bool:
    role = str(source_table.get("source_role") or "").lower()
    return bool(source_table.get("detected")) or role in {"uploaded", "detected"}


def assert_capacity(source_table: Mapping[str, Any], resolved_zone: Mapping[str, Any]) -> None:
    headers = list(source_table.get("headers") or [])
    rows = list(source_table.get("rows") or [])
    required_rows = len(rows) + 1
    required_columns = len(headers)
    zone_range = grid_range(resolved_zone)
    available_rows = int(zone_range["endRowIndex"]) - int(zone_range["startRowIndex"])
    available_columns = int(zone_range["endColumnIndex"]) - int(zone_range["startColumnIndex"])

    if required_rows > available_rows or required_columns > available_columns:
        raise CapacityExceededError(
            {
                "target_zone_key": source_table.get("target_zone_key") or source_table.get("source_table"),
                "required_rows": required_rows,
                "available_rows": available_rows,
                "required_columns": required_columns,
                "available_columns": available_columns,
            }
        )


def build_clear_request(resolved_zone: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "repeatCell": {
            "range": grid_range(resolved_zone),
            "cell": {},
            "fields": "userEnteredValue",
        }
    }


def build_write_request(source_table: Mapping[str, Any], resolved_zone: Mapping[str, Any]) -> dict[str, Any]:
    headers = list(source_table.get("headers") or [])
    data_rows = list(source_table.get("rows") or [])
    values = [headers, *data_rows]
    write_range = grid_range(resolved_zone)
    write_range["endRowIndex"] = write_range["startRowIndex"] + len(values)
    write_range["endColumnIndex"] = write_range["startColumnIndex"] + len(headers)

    return {
        "updateCells": {
            "range": write_range,
            "rows": [{"values": [cell_data(value) for value in row]} for row in values],
            "fields": "userEnteredValue",
        }
    }


def grid_range(resolved_zone: Mapping[str, Any]) -> GridRange:
    if "gridRange" in resolved_zone:
        resolved_zone = resolved_zone["gridRange"]
    return {
        "sheetId": int(resolved_zone["sheetId"]),
        "startRowIndex": int(resolved_zone["startRowIndex"]),
        "endRowIndex": int(resolved_zone["endRowIndex"]),
        "startColumnIndex": int(resolved_zone["startColumnIndex"]),
        "endColumnIndex": int(resolved_zone["endColumnIndex"]),
    }


def cell_data(value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        user_entered_value = {"boolValue": value}
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        user_entered_value = {"numberValue": value}
    elif value is None:
        user_entered_value = {"stringValue": ""}
    else:
        user_entered_value = {"stringValue": str(value)}
    return {"userEnteredValue": user_entered_value}


def amount_total(headers: Sequence[Any], rows: Sequence[Sequence[Any]]) -> float:
    amount_index = first_amount_index(headers)
    if amount_index is None:
        return 0.0
    total = 0.0
    for row in rows:
        if amount_index >= len(row):
            continue
        total += number_value(row[amount_index])
    return total


def first_amount_index(headers: Sequence[Any]) -> int | None:
    for index, header in enumerate(headers):
        if str(header).strip().lower() == "amount":
            return index
    return None


def number_value(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    try:
        return float(str(value).replace(",", ""))
    except ValueError:
        return 0.0


def schema_drift(source_table: Mapping[str, Any]) -> dict[str, list[str]]:
    headers = [str(header) for header in source_table.get("headers") or []]
    expected_headers = [str(header) for header in source_table.get("expected_headers") or ["Name", "Amount"]]
    return {
        "extra_columns": [header for header in headers if header not in expected_headers],
        "missing_columns": [header for header in expected_headers if header not in headers],
    }


def zone_fingerprint(resolved_zone: Mapping[str, Any] | None) -> str | None:
    if not resolved_zone:
        return None
    fingerprint = resolved_zone.get("fingerprint") or resolved_zone.get("resolved_zone_fingerprint")
    if fingerprint is not None:
        return str(fingerprint)
    canonical = json.dumps(grid_range(resolved_zone), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def default_batch_update(spreadsheet_id: str, requests: list[dict[str, Any]]) -> Mapping[str, Any]:
    raise NotImplementedError("Inject a Sheets batch update callable before enabling the worker endpoint")


def default_validate_input(spreadsheet_id: str, manifest: list[dict[str, Any]]) -> Mapping[str, Any]:
    raise NotImplementedError("Inject a validation callable before enabling the worker endpoint")


class handler(BaseHTTPRequestHandler):
    batch_update = staticmethod(default_batch_update)
    validate_input = staticmethod(default_validate_input)

    def do_POST(self) -> None:
        if not self._is_authorized():
            self._send_json(403, {"ok": False, "message": "forbidden"})
            return

        try:
            payload = self._read_json_body()
            result = run_external_import_job(
                payload,
                batch_update=self.batch_update,
                validate_input=self.validate_input,
            )
            self._send_json(200 if result["ok"] else 422, result)
        except CapacityExceededError as error:
            self._send_json(409, {"ok": False, "message": str(error), "details": error.details})
        except ValueError as error:
            self._send_json(400, {"ok": False, "message": str(error)})
        except Exception as error:
            self._send_json(500, {"ok": False, "message": str(error)})

    def _is_authorized(self) -> bool:
        expected_secret = os.environ.get("EXTERNAL_IMPORT_WORKER_SECRET")
        if not expected_secret:
            return False
        return self.headers.get("X-AiWB-Worker-Secret") == expected_secret

    def _read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)
        return json.loads(body.decode("utf-8") or "{}")

    def _send_json(self, status_code: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
