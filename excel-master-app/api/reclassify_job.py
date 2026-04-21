from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Mapping, Sequence, Tuple

import pandas as pd

sys.path.append(str(Path(__file__).parent / "logic"))

from finance_classification import compute_final_detail_classifications, compute_payable_classifications
from finance_utils import _values_to_dataframe, get_sheets_service


REQUIRED_SHEETS = ("Payable", "Scoping", "Final Detail", "Unit Budget", "Unit Master")


def _quote_sheet_name(sheet_name: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_]+", sheet_name):
        return sheet_name
    return "'" + sheet_name.replace("'", "''") + "'"


def _sheet_range(sheet_name: str) -> str:
    return f"{_quote_sheet_name(sheet_name)}!A:AZ"


def _coerce_decision_list(
    decisions: Sequence[Any],
    categories: Sequence[Any],
    rule_ids: Sequence[Any],
) -> List[Any]:
    if decisions:
        return list(decisions)

    fallback: List[Any] = []
    for idx, category in enumerate(categories):
        fallback.append(
            SimpleNamespace(
                category="" if category is None else str(category),
                rule_id="" if idx >= len(rule_ids) or rule_ids[idx] is None else str(rule_ids[idx]),
            )
        )
    return fallback


def load_reclassify_sheet_map(service, spreadsheet_id: str) -> Dict[str, pd.DataFrame]:
    response = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id,
        ranges=[_sheet_range(sheet_name) for sheet_name in REQUIRED_SHEETS],
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()

    sheet_map: Dict[str, pd.DataFrame] = {}
    for value_range in response.get("valueRanges", []):
        range_name = str(value_range.get("range", ""))
        sheet_name = range_name.split("!", 1)[0].strip().strip("'")
        values = value_range.get("values", [])
        if values:
            sheet_map[sheet_name] = _values_to_dataframe(values)

    missing = [sheet_name for sheet_name in REQUIRED_SHEETS if sheet_name not in sheet_map]
    if missing:
        raise RuntimeError(f"Missing required sheets: {', '.join(missing)}")

    return sheet_map


def compute_reclassification_results(sheet_map: Mapping[str, pd.DataFrame]) -> Dict[str, Any]:
    payable_categories, payable_extra = compute_payable_classifications(sheet_map)
    final_detail_categories, final_detail_extra = compute_final_detail_classifications(sheet_map)

    payable_decisions = _coerce_decision_list(
        payable_extra.get("decisions", []),
        payable_categories,
        payable_extra.get("rule_ids", []),
    )
    final_detail_decisions = _coerce_decision_list(
        final_detail_extra.get("decisions", []),
        final_detail_categories,
        final_detail_extra.get("rule_ids", []),
    )

    return {
        "payable_decisions": payable_decisions,
        "final_detail_decisions": final_detail_decisions,
        "payable_categories": list(payable_categories),
        "final_detail_categories": list(final_detail_categories),
    }


def build_reclassify_updates(results: Mapping[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    updates: List[Dict[str, Any]] = []

    payable_decisions = list(results.get("payable_decisions", []))
    final_detail_decisions = list(results.get("final_detail_decisions", []))

    for row_index, decision in enumerate(payable_decisions, start=2):
        updates.append(
            {
                "range": f"Payable!A{row_index}:B{row_index}",
                "values": [[_safe_text(getattr(decision, "category", "")), _safe_text(getattr(decision, "rule_id", ""))]],
            }
        )

    for row_index, decision in enumerate(final_detail_decisions, start=2):
        updates.append(
            {
                "range": f"'Final Detail'!A{row_index}:B{row_index}",
                "values": [[_safe_text(getattr(decision, "category", "")), _safe_text(getattr(decision, "rule_id", ""))]],
            }
        )

    summary = {
        "payable_rows_written": len(payable_decisions),
        "final_detail_rows_written": len(final_detail_decisions),
    }
    return updates, summary


def push_reclassify_updates(service, spreadsheet_id: str, updates: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    if not updates:
        return {"api_calls": 0, "updated_ranges": 0}

    response = service.spreadsheets().values().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "valueInputOption": "USER_ENTERED",
            "data": list(updates),
        },
    ).execute()

    return {
        "api_calls": 1,
        "updated_ranges": len(updates),
        "response": response,
    }


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _read_json_body(handler: BaseHTTPRequestHandler) -> Dict[str, Any]:
    content_length = int(handler.headers.get("Content-Length", "0") or 0)
    raw = handler.rfile.read(content_length) if content_length > 0 else b"{}"
    try:
        parsed = json.loads(raw)
    except Exception as exc:  # pragma: no cover - guarded by tests and explicit handler response
        raise ValueError(f"Invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Request body must be a JSON object")
    return parsed


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        spreadsheet_id = ""
        try:
            data = _read_json_body(self)
            spreadsheet_id = _safe_text(data.get("spreadsheet_id"))
            if not spreadsheet_id:
                return self._send_error(400, "spreadsheet_id is required")

            service = get_sheets_service()
            sheet_map = load_reclassify_sheet_map(service, spreadsheet_id)
            results = compute_reclassification_results(sheet_map)
            updates, summary = build_reclassify_updates(results)
            commit_result = push_reclassify_updates(service, spreadsheet_id, updates)

            return self._send_json(
                200,
                {
                    "ok": True,
                    "message": "Reclassification worker completed.",
                    "spreadsheet_id": spreadsheet_id,
                    "summary": summary,
                    "commit": commit_result,
                },
            )
        except ValueError as exc:
            return self._send_error(400, str(exc), spreadsheet_id=spreadsheet_id or None)
        except Exception as exc:
            return self._send_error(500, f"Reclassification worker failed: {exc}", spreadsheet_id=spreadsheet_id or None)

    def _send_json(self, status_code: int, data: Mapping[str, Any]):
        self.send_response(status_code)
        self.send_header("Content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _send_error(self, status_code: int, message: str, spreadsheet_id: str | None = None):
        payload: Dict[str, Any] = {
            "ok": False,
            "message": message,
        }
        if spreadsheet_id:
            payload["spreadsheet_id"] = spreadsheet_id
        self._send_json(status_code, payload)
