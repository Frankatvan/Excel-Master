from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Sequence, Tuple
from urllib.parse import urlencode
from urllib.request import Request, urlopen


REQUIRED_SHEETS = ("Payable", "Scoping", "Final Detail", "Unit Budget", "Unit Master")
OPTIONAL_SHEETS = ("Draw request report",)
UPDATE_CHUNK_SIZE = 400
SNAPSHOT_PAYLOAD_WARN_BYTES = 10 * 1024 * 1024


def _load_worker_dependencies():
    logic_path = Path(__file__).resolve().parents[1] / "logic"
    logic_path_text = str(logic_path)
    if logic_path_text not in sys.path:
        sys.path.insert(0, logic_path_text)

    from aiwb_finance.finance_engine import (
        MappingService,
        _build_scoping_final_gmp_insert_requests,
        _ensure_scoping_final_gmp_rows,
        _get_sheet_metadata,
        build_dashboard_summary_payload,
    )
    from aiwb_finance.finance_classification import compute_final_detail_classifications, compute_payable_classifications
    from aiwb_finance.finance_mapping import resolve_sheet_field_columns_with_fallback
    from aiwb_finance.finance_utils import (
        _find_col_in_headers,
        _find_col_in_row,
        _column_number_to_a1,
        _get_cell,
        _normalize_amount_key,
        _normalize_text_key,
        _safe_string,
        _sheet_key,
        _values_to_dataframe,
        get_sheets_service,
    )

    return {
        "build_dashboard_summary_payload": build_dashboard_summary_payload,
        "MappingService": MappingService,
        "compute_final_detail_classifications": compute_final_detail_classifications,
        "compute_payable_classifications": compute_payable_classifications,
        "_build_scoping_final_gmp_insert_requests": _build_scoping_final_gmp_insert_requests,
        "_ensure_scoping_final_gmp_rows": _ensure_scoping_final_gmp_rows,
        "_get_sheet_metadata": _get_sheet_metadata,
        "_find_col_in_headers": _find_col_in_headers,
        "_find_col_in_row": _find_col_in_row,
        "_column_number_to_a1": _column_number_to_a1,
        "_get_cell": _get_cell,
        "_normalize_amount_key": _normalize_amount_key,
        "_normalize_text_key": _normalize_text_key,
        "resolve_sheet_field_columns_with_fallback": resolve_sheet_field_columns_with_fallback,
        "_safe_string": _safe_string,
        "_sheet_key": _sheet_key,
        "_values_to_dataframe": _values_to_dataframe,
        "get_sheets_service": get_sheets_service,
    }


def _quote_sheet_name(sheet_name: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_]+", sheet_name):
        return sheet_name
    return "'" + sheet_name.replace("'", "''") + "'"


def _sheet_range(sheet_name: str) -> str:
    return f"{_quote_sheet_name(sheet_name)}!A:AZ"


def coerce_sheet_values_to_dataframe(values: Sequence[Sequence[Any]]):
    deps = _load_worker_dependencies()
    values_to_dataframe = deps["_values_to_dataframe"]
    if not values:
        return values_to_dataframe([])

    max_width = max((len(row) for row in values), default=0)
    normalized_values = [list(row) + [""] * max(0, max_width - len(row)) for row in values]
    return values_to_dataframe(normalized_values)


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


def normalize_assignment_rows(rows: Sequence[Sequence[Any]] | None, expected_count: int) -> List[Tuple[str, str]]:
    normalized: List[Tuple[str, str]] = []
    for index in range(expected_count):
        row = rows[index] if rows and index < len(rows) else []
        category = str(row[0]).strip() if len(row) > 0 and row[0] is not None else ""
        rule_id = str(row[1]).strip() if len(row) > 1 and row[1] is not None else ""
        normalized.append((category, rule_id))
    return normalized


def compare_assignments(
    sheet_name: str,
    expected_decisions: Sequence[Any],
    actual_rows: Sequence[Tuple[str, str]],
    max_mismatches: int = 20,
) -> Dict[str, Any]:
    mismatches: List[Dict[str, Any]] = []
    mismatch_count = 0

    for index, decision in enumerate(expected_decisions):
        expected_category = str(getattr(decision, "category", "") or "").strip()
        expected_rule_id = str(getattr(decision, "rule_id", "") or "").strip()
        actual_category, actual_rule_id = actual_rows[index] if index < len(actual_rows) else ("", "")

        if expected_category == actual_category and expected_rule_id == actual_rule_id:
            continue

        mismatch_count += 1
        if len(mismatches) < max_mismatches:
            mismatches.append(
                {
                    "sheet": sheet_name,
                    "row": index + 2,
                    "expected": {
                        "category": expected_category,
                        "rule_id": expected_rule_id,
                    },
                    "actual": {
                        "category": actual_category,
                        "rule_id": actual_rule_id,
                    },
                }
            )

    total_rows = len(expected_decisions)
    matched_count = total_rows - mismatch_count
    return {
        "sheet": sheet_name,
        "total_rows": total_rows,
        "matched_rows": matched_count,
        "mismatch_count": mismatch_count,
        "mismatches": mismatches,
    }


def fetch_live_assignment_rows(service, spreadsheet_id: str, payable_count: int, final_detail_count: int):
    response = (
        service.spreadsheets()
        .values()
        .batchGet(
            spreadsheetId=spreadsheet_id,
            ranges=[
                f"Payable!A2:B{payable_count + 1}",
                f"'Final Detail'!A2:B{final_detail_count + 1}",
            ],
            valueRenderOption="FORMATTED_VALUE",
        )
        .execute()
    )

    ranges = response.get("valueRanges", [])
    payable_rows = normalize_assignment_rows(ranges[0].get("values", []) if len(ranges) > 0 else [], payable_count)
    final_detail_rows = normalize_assignment_rows(
        ranges[1].get("values", []) if len(ranges) > 1 else [],
        final_detail_count,
    )
    return payable_rows, final_detail_rows


def build_validation_payload(
    service,
    spreadsheet_id: str,
    results: Mapping[str, Any],
    max_mismatches: int = 20,
) -> Dict[str, Any]:
    payable_decisions = list(results.get("payable_decisions", []))
    final_detail_decisions = list(results.get("final_detail_decisions", []))

    payable_rows, final_detail_rows = fetch_live_assignment_rows(
        service,
        spreadsheet_id,
        len(payable_decisions),
        len(final_detail_decisions),
    )

    payable_summary = compare_assignments(
        "Payable",
        payable_decisions,
        payable_rows,
        max_mismatches=max_mismatches,
    )
    final_detail_summary = compare_assignments(
        "Final Detail",
        final_detail_decisions,
        final_detail_rows,
        max_mismatches=max_mismatches,
    )

    mismatch_count = payable_summary["mismatch_count"] + final_detail_summary["mismatch_count"]
    matched_rows = payable_summary["matched_rows"] + final_detail_summary["matched_rows"]
    total_rows = payable_summary["total_rows"] + final_detail_summary["total_rows"]
    status = "ok" if mismatch_count == 0 else "mismatch"
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    sample_mismatches = (payable_summary["mismatches"] + final_detail_summary["mismatches"])[:max_mismatches]
    message = "重分类校验通过" if status == "ok" else f"重分类校验发现 {mismatch_count} 条不一致"

    return {
        "status": status,
        "checked_at": checked_at,
        "totals": {
            "total_rows": total_rows,
            "matched_rows": matched_rows,
            "mismatch_count": mismatch_count,
        },
        "sheets": {
            "payable": payable_summary,
            "final_detail": final_detail_summary,
        },
        "sample_mismatches": sample_mismatches,
        "message": message,
    }


def load_reclassify_sheet_map(service, spreadsheet_id: str) -> Dict[str, Any]:
    sheets_to_fetch = [*REQUIRED_SHEETS, *OPTIONAL_SHEETS]
    response = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id,
        ranges=[_sheet_range(sheet_name) for sheet_name in sheets_to_fetch],
        valueRenderOption="UNFORMATTED_VALUE",
    ).execute()

    sheet_map: Dict[str, Any] = {}
    for value_range in response.get("valueRanges", []):
        range_name = str(value_range.get("range", ""))
        sheet_name = range_name.split("!", 1)[0].strip().strip("'")
        values = value_range.get("values", [])
        if values:
            sheet_map[sheet_name] = coerce_sheet_values_to_dataframe(values)

    missing = [sheet_name for sheet_name in REQUIRED_SHEETS if sheet_name not in sheet_map]
    if missing:
        raise RuntimeError(f"Missing required sheets: {', '.join(missing)}")

    return sheet_map


def _sheet_data_to_values(sheet_data: Any, deps: Mapping[str, Any]) -> List[List[Any]]:
    if hasattr(sheet_data, "columns") and hasattr(sheet_data, "to_numpy"):
        headers = [str(col) for col in sheet_data.columns.tolist()]
        body = [
            [_serialize_sheet_cell(value) for value in row]
            for row in sheet_data.to_numpy(dtype=object).tolist()
        ]
        return [headers] + body
    if isinstance(sheet_data, Sequence) and not isinstance(sheet_data, (str, bytes)):
        return [list(row) for row in sheet_data]
    return []


def _serialize_sheet_cell(value: Any) -> Any:
    if value is None:
        return ""
    try:
        if value != value:
            return ""
    except Exception:
        if str(value) in {"<NA>", "NaT"}:
            return ""
    return value


def ensure_scoping_final_gmp_before_reclassification(
    service,
    spreadsheet_id: str,
    sheet_map: Mapping[str, Any],
    deps: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    deps = deps or _load_worker_dependencies()
    try:
        scoping_key = deps["_sheet_key"](sheet_map, "Scoping")
    except KeyError:
        return {"inserted": False, "final_gmp_col_1based": 0}

    scoping_rows = _sheet_data_to_values(sheet_map[scoping_key], deps)
    migrated_rows, final_gmp_meta = deps["_ensure_scoping_final_gmp_rows"](scoping_rows)
    if not final_gmp_meta.get("inserted"):
        return final_gmp_meta

    header_row_idx = None
    gmp_col_idx = None
    for row_idx, row in enumerate(scoping_rows):
        for col_idx, value in enumerate(row):
            if str(value).strip().casefold() == "gmp":
                header_row_idx = row_idx
                gmp_col_idx = col_idx
                break
        if header_row_idx is not None:
            break
    if header_row_idx is None or gmp_col_idx is None:
        return final_gmp_meta

    metadata = deps["_get_sheet_metadata"](service, spreadsheet_id, "Scoping")
    requests = deps["_build_scoping_final_gmp_insert_requests"](
        sheet_id=int(metadata.get("sheet_id", 0)),
        row_count=int(metadata.get("row_count", 0)),
        header_row_idx=header_row_idx,
        gmp_col_idx=gmp_col_idx,
    )
    service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={"requests": requests},
    ).execute()
    return final_gmp_meta


def _collect_mapping_metrics(mapping_warnings: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    fallback_fields = sorted(
        {
            f"{str(item.get('sheet_name', '')).strip()}.{str(item.get('logical_field', '')).strip()}"
            for item in mapping_warnings
            if str(item.get("event_code", "")).strip() == "FALLBACK_TO_PHYSICAL_INDEX"
            and str(item.get("sheet_name", "")).strip()
            and str(item.get("logical_field", "")).strip()
        }
    )
    return {
        "mapping_warning_count": len(mapping_warnings),
        "fallback_count": len(fallback_fields),
        "fallback_fields": fallback_fields,
    }


def _find_draw_request_header_row(draw_request_sheet) -> tuple[int | None, Dict[str, int], List[Dict[str, Any]]]:
    deps = _load_worker_dependencies()
    safe_string = deps["_safe_string"]
    resolver = deps["resolve_sheet_field_columns_with_fallback"]
    best_row: int | None = None
    best_layout: Dict[str, int] = {}
    best_score = -1
    for row_idx in range(len(draw_request_sheet)):
        header_row = [safe_string(value) for value in draw_request_sheet.iloc[row_idx].tolist()]
        if not any(header_row):
            continue

        layout, _warnings = resolver(
            headers=header_row,
            sheet_name="Draw request report",
            fallback_columns={},
            fields=("draw_invoice", "invoice_no", "cost_code", "vendor", "amount"),
        )
        score = sum(1 for field in ("invoice_no", "cost_code", "vendor", "amount") if field in layout)
        if score > best_score:
            best_row = row_idx
            best_layout = dict(layout)
            best_score = score

        if "invoice_no" in layout and "cost_code" in layout and score >= 3:
            return row_idx, dict(layout), []

    if best_row is not None and "invoice_no" in best_layout and "cost_code" in best_layout:
        return best_row, best_layout, []
    return None, {}, []


def _build_payable_cost_state_lookup(payable_sheet) -> Tuple[Dict[tuple[str, str], List[Dict[str, Any]]], List[Dict[str, Any]]]:
    deps = _load_worker_dependencies()
    get_cell = deps["_get_cell"]
    normalize_amount_key = deps["_normalize_amount_key"]
    normalize_text_key = deps["_normalize_text_key"]
    resolver = deps["resolve_sheet_field_columns_with_fallback"]
    safe_string = deps["_safe_string"]

    payable_layout, mapping_warnings = resolver(
        headers=list(payable_sheet.columns),
        sheet_name="Payable",
        fallback_columns={},
        fields=("invoice_no", "cost_code", "raw_cost_state", "vendor", "amount"),
    )
    invoice_no_col = int(payable_layout.get("invoice_no") or 0)
    cost_code_col = int(payable_layout.get("cost_code") or 0)
    cost_state_col = int(payable_layout.get("raw_cost_state") or 0)
    vendor_col = int(payable_layout.get("vendor") or 0)
    amount_col = int(payable_layout.get("amount") or 0)
    if not invoice_no_col or not cost_code_col or not cost_state_col:
        return {}, mapping_warnings

    lookup: Dict[tuple[str, str], List[Dict[str, Any]]] = {}
    for row_idx in range(len(payable_sheet)):
        invoice_key = normalize_text_key(get_cell(payable_sheet, row_idx, invoice_no_col))
        cost_code_key = normalize_text_key(get_cell(payable_sheet, row_idx, cost_code_col))
        if not invoice_key or not cost_code_key:
            continue

        cost_state = safe_string(get_cell(payable_sheet, row_idx, cost_state_col))
        vendor_key = normalize_text_key(get_cell(payable_sheet, row_idx, vendor_col)) if vendor_col else ""
        amount_key = normalize_amount_key(get_cell(payable_sheet, row_idx, amount_col)) if amount_col else ""
        lookup.setdefault((invoice_key, cost_code_key), []).append(
            {
                "state": cost_state,
                "vendor_key": vendor_key,
                "amount_key": amount_key,
                "row_index": row_idx + 2,
            }
        )

    return lookup, mapping_warnings


def build_draw_request_cost_state_updates(sheet_map: Mapping[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    deps = _load_worker_dependencies()
    sheet_key = deps["_sheet_key"]
    get_cell = deps["_get_cell"]
    normalize_amount_key = deps["_normalize_amount_key"]
    normalize_text_key = deps["_normalize_text_key"]
    safe_string = deps["_safe_string"]
    mapping_warnings: List[Dict[str, Any]] = []

    try:
        payable_sheet = sheet_map[sheet_key(sheet_map, "Payable")]
        draw_request_sheet = sheet_map[sheet_key(sheet_map, "Draw request report")]
    except KeyError:
        return [], {
            "draw_request_rows_written": 0,
            "draw_request_matched_rows": 0,
            "draw_request_unmatched_rows": 0,
            "draw_request_ambiguous_rows": 0,
            "mapping_warning_count": 0,
            "fallback_count": 0,
            "fallback_fields": [],
            "mapping_warnings": [],
        }

    payable_lookup, payable_mapping_warnings = _build_payable_cost_state_lookup(payable_sheet)
    mapping_warnings.extend(payable_mapping_warnings)
    header_row_idx, draw_cols, draw_mapping_warnings = _find_draw_request_header_row(draw_request_sheet)
    mapping_warnings.extend(draw_mapping_warnings)
    if header_row_idx is None:
        metrics = _collect_mapping_metrics(mapping_warnings)
        return [], {
            "draw_request_rows_written": 0,
            "draw_request_matched_rows": 0,
            "draw_request_unmatched_rows": 0,
            "draw_request_ambiguous_rows": 0,
            **metrics,
            "mapping_warnings": mapping_warnings,
        }

    updates: List[Dict[str, Any]] = []
    matched_rows = 0
    unmatched_rows = 0
    ambiguous_rows = 0

    for row_idx in range(header_row_idx + 1, len(draw_request_sheet)):
        row_values = [safe_string(value) for value in draw_request_sheet.iloc[row_idx].tolist()]
        if not any(row_values):
            continue

        invoice_key = normalize_text_key(get_cell(draw_request_sheet, row_idx, draw_cols["invoice_no"]))
        cost_code_key = normalize_text_key(get_cell(draw_request_sheet, row_idx, draw_cols["cost_code"]))
        vendor_key = normalize_text_key(get_cell(draw_request_sheet, row_idx, draw_cols["vendor"])) if draw_cols.get("vendor") else ""
        amount_key = normalize_amount_key(get_cell(draw_request_sheet, row_idx, draw_cols["amount"])) if draw_cols.get("amount") else ""

        cost_state = ""
        if invoice_key and cost_code_key:
            candidates = list(payable_lookup.get((invoice_key, cost_code_key), []))
            if candidates:
                narrowed = candidates
                if vendor_key:
                    vendor_matched = [item for item in narrowed if item.get("vendor_key") == vendor_key]
                    if vendor_matched:
                        narrowed = vendor_matched
                if amount_key:
                    amount_matched = [item for item in narrowed if item.get("amount_key") == amount_key]
                    if amount_matched:
                        narrowed = amount_matched
                states = sorted({safe_string(item.get("state")) for item in narrowed if safe_string(item.get("state"))})
                if len(states) == 1:
                    cost_state = states[0]
                    matched_rows += 1
                elif len(states) > 1:
                    ambiguous_rows += 1
                else:
                    matched_rows += 1
            else:
                unmatched_rows += 1
        else:
            unmatched_rows += 1

        sheet_row = row_idx + 2
        updates.append(
            {
                "range": f"{_quote_sheet_name('Draw request report')}!C{sheet_row}:C{sheet_row}",
                "values": [[cost_state]],
            }
        )

    metrics = _collect_mapping_metrics(mapping_warnings)
    return updates, {
        "draw_request_rows_written": len(updates),
        "draw_request_matched_rows": matched_rows,
        "draw_request_unmatched_rows": unmatched_rows,
        "draw_request_ambiguous_rows": ambiguous_rows,
        **metrics,
        "mapping_warnings": mapping_warnings,
    }


def compute_reclassification_results(sheet_map: Mapping[str, Any]) -> Dict[str, Any]:
    deps = _load_worker_dependencies()
    payable_categories, payable_extra = deps["compute_payable_classifications"](sheet_map)
    final_detail_categories, final_detail_extra = deps["compute_final_detail_classifications"](sheet_map)
    draw_request_updates, draw_request_summary = build_draw_request_cost_state_updates(sheet_map)

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

    mapping_warnings: List[Dict[str, Any]] = [
        *list(payable_extra.get("mapping_warnings", [])),
        *list(final_detail_extra.get("mapping_warnings", [])),
        *list(draw_request_summary.get("mapping_warnings", [])),
    ]
    mapping_metrics = _collect_mapping_metrics(mapping_warnings)

    return {
        "payable_decisions": payable_decisions,
        "final_detail_decisions": final_detail_decisions,
        "payable_categories": list(payable_categories),
        "final_detail_categories": list(final_detail_categories),
        "draw_request_updates": draw_request_updates,
        "draw_request_summary": draw_request_summary,
        "mapping_warnings": mapping_warnings,
        "mapping_metrics": mapping_metrics,
    }


def build_reclassify_updates(results: Mapping[str, Any]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    updates: List[Dict[str, Any]] = []

    payable_decisions = list(results.get("payable_decisions", []))
    final_detail_decisions = list(results.get("final_detail_decisions", []))
    draw_request_updates = list(results.get("draw_request_updates", []))
    draw_request_summary = results.get("draw_request_summary", {})

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

    updates.extend(draw_request_updates)

    mapping_metrics = dict(results.get("mapping_metrics", {}))
    summary = {
        "payable_rows_written": len(payable_decisions),
        "final_detail_rows_written": len(final_detail_decisions),
        "draw_request_rows_written": int(draw_request_summary.get("draw_request_rows_written", len(draw_request_updates))),
        "draw_request_matched_rows": int(draw_request_summary.get("draw_request_matched_rows", 0)),
        "draw_request_unmatched_rows": int(draw_request_summary.get("draw_request_unmatched_rows", 0)),
        "draw_request_ambiguous_rows": int(draw_request_summary.get("draw_request_ambiguous_rows", 0)),
        "mapping_warning_count": int(mapping_metrics.get("mapping_warning_count", 0)),
        "fallback_count": int(mapping_metrics.get("fallback_count", 0)),
        "fallback_fields": list(mapping_metrics.get("fallback_fields", [])),
    }
    return updates, summary


def push_reclassify_updates(service, spreadsheet_id: str, updates: Sequence[Mapping[str, Any]]) -> Dict[str, Any]:
    if not updates:
        return {"api_calls": 0, "updated_ranges": 0}

    responses: List[Mapping[str, Any]] = []
    for offset in range(0, len(updates), UPDATE_CHUNK_SIZE):
        chunk = list(updates[offset : offset + UPDATE_CHUNK_SIZE])
        response = service.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "valueInputOption": "USER_ENTERED",
                "data": chunk,
            },
        ).execute()
        responses.append(response)

    return {
        "api_calls": len(responses),
        "updated_ranges": len(updates),
        "responses": responses,
    }


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _iso_now_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_json_default(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(k): _safe_json_default(v) for k, v in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_safe_json_default(item) for item in value]
    return _safe_text(value)


def _serialize_decisions(decisions: Sequence[Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for index, decision in enumerate(decisions, start=1):
        payload: Dict[str, Any] = {
            "row_index_1based": index,
            "category": _safe_text(getattr(decision, "category", "")),
            "rule_id": _safe_text(getattr(decision, "rule_id", "")),
        }
        for field in ("reason_en", "reason_cn", "reason_zh", "invoice_no", "cost_code", "vendor", "unit_code"):
            if hasattr(decision, field):
                payload[field] = _safe_text(getattr(decision, field))
        out.append(payload)
    return out


def _normalize_formula_plan_templates(raw_formula_plan: Any) -> Tuple[List[Dict[str, Any]], List[str]]:
    if not isinstance(raw_formula_plan, Sequence) or isinstance(raw_formula_plan, (str, bytes, bytearray)):
        return [], []

    normalized: List[Dict[str, Any]] = []
    warnings: List[str] = []
    for item in raw_formula_plan:
        if not isinstance(item, Mapping):
            continue
        row: Dict[str, Any] = {
            "sheet": _safe_text(item.get("sheet", "")),
            "cell": _safe_text(item.get("cell", "")),
            "logic": _safe_text(item.get("logic", "")),
        }
        row_fingerprint = item.get("row_fingerprint")
        if isinstance(row_fingerprint, Mapping):
            row["row_fingerprint"] = _safe_json_default(dict(row_fingerprint))
        template = _safe_text(item.get("formula_template") or item.get("template"))
        rendered = _safe_text(item.get("formula") or item.get("formula_rendered"))
        if template:
            row["formula_template"] = template
        elif rendered and "${" in rendered:
            row["formula_template"] = rendered
        elif rendered:
            row["formula_rendered"] = rendered
            warnings.append("FORMULA_TEMPLATE_MISSING_FOR_RENDERED_FORMULA")
        normalized.append(row)
    return normalized, sorted(set(warnings))


def _formula_templates_require_mapping_manifest(formula_plan_templates: Sequence[Mapping[str, Any]]) -> bool:
    for item in formula_plan_templates:
        if not isinstance(item, Mapping):
            continue
        source = _safe_text(item.get("formula_template") or item.get("formula_rendered"))
        if "${" in source:
            return True
    return False


def _normalize_formula_mapping_manifest(raw_mappings: Any) -> Dict[str, Any]:
    mappings: Dict[str, Dict[str, int]] = {}
    if isinstance(raw_mappings, Mapping):
        source = raw_mappings.get("mappings") if "mappings" in raw_mappings else raw_mappings
        if isinstance(source, Mapping):
            for sheet_name, fields in source.items():
                normalized_sheet = _safe_text(sheet_name)
                if not normalized_sheet or not isinstance(fields, Mapping):
                    continue
                normalized_fields: Dict[str, int] = {}
                for field_name, column_index in fields.items():
                    normalized_field = _safe_text(field_name)
                    try:
                        normalized_index = int(column_index)
                    except (TypeError, ValueError):
                        continue
                    if normalized_field and normalized_index >= 1:
                        normalized_fields[normalized_field] = normalized_index
                if normalized_fields:
                    mappings[normalized_sheet] = dict(sorted(normalized_fields.items()))

    encoded = json.dumps(mappings, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "version": 1,
        "source": "snapshot_frozen",
        "mappings": mappings,
        "mapping_hash": hashlib.sha256(encoded).hexdigest(),
    }


def _dashboard_summary_has_real_metrics(summary: Mapping[str, Any]) -> bool:
    if not isinstance(summary.get("audit_tabs"), Mapping):
        return False

    highlights = summary.get("highlights")
    if isinstance(highlights, Sequence) and not isinstance(highlights, (str, bytes, bytearray)):
        for item in highlights:
            if not isinstance(item, Mapping):
                continue
            value = _safe_text(item.get("value"))
            if value and value not in {"-", "0", "0.0", "$0", "$0.00"}:
                return True

    audit_tabs = summary.get("audit_tabs")
    if not isinstance(audit_tabs, Mapping):
        return False

    external_recon = audit_tabs.get("external_recon")
    if isinstance(external_recon, Mapping):
        for key in ("discrepancies", "cost_state_matrix", "detail_rows", "comparison_rows", "unit_budget_variances"):
            value = external_recon.get(key)
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)) and len(value) > 0:
                return True

    compare_109 = audit_tabs.get("compare_109")
    if isinstance(compare_109, Mapping):
        metric_rows = compare_109.get("metric_rows")
        if isinstance(metric_rows, Sequence) and not isinstance(metric_rows, (str, bytes, bytearray)) and len(metric_rows) > 0:
            return True

    manual_input = audit_tabs.get("manual_input")
    if isinstance(manual_input, Mapping):
        for key in ("profit_statement_entries", "validation_errors", "scoping_groups", "unit_master_dates"):
            value = manual_input.get(key)
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)) and len(value) > 0:
                return True

    return False


def _compute_code_manifest_hash(extra_paths: Sequence[Path] | None = None) -> str:
    base = Path(__file__).resolve()
    canonical_dir = base.parents[1] / "logic" / "aiwb_finance"
    candidates: List[Path] = [
        base,
        canonical_dir / "__init__.py",
        canonical_dir / "finance_classification.py",
        canonical_dir / "finance_mapping.py",
        canonical_dir / "finance_formulas.py",
        canonical_dir / "finance_engine.py",
        canonical_dir / "finance_services.py",
        canonical_dir / "finance_utils.py",
        base.parents[2] / "docs" / "finance_semantic_config.yaml",
    ]
    if extra_paths:
        candidates.extend(extra_paths)

    hasher = hashlib.sha256()
    for path in sorted({candidate.resolve() for candidate in candidates if candidate.exists()}):
        rel = str(path)
        try:
            rel = str(path.relative_to(base.parents[2]))
        except Exception:
            rel = str(path)
        hasher.update(rel.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(path.read_bytes())
        hasher.update(b"\0")
    return hasher.hexdigest()


def _supabase_request(
    *,
    method: str,
    base_url: str,
    service_role_key: str,
    resource: str,
    query: Mapping[str, str] | None = None,
    body: Mapping[str, Any] | None = None,
) -> Any:
    query_string = urlencode(list(query.items())) if query else ""
    endpoint = f"{base_url.rstrip('/')}/rest/v1/{resource}"
    if query_string:
        endpoint = f"{endpoint}?{query_string}"

    payload_bytes = None
    if body is not None:
        payload_bytes = json.dumps(body, ensure_ascii=False).encode("utf-8")

    request = Request(
        endpoint,
        data=payload_bytes,
        method=method.upper(),
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    ssl_context = None
    try:
        import certifi  # type: ignore

        ssl_context = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ssl_context = None

    with urlopen(request, timeout=20, context=ssl_context) as response:
        raw = response.read().decode("utf-8").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return raw


def _supabase_rpc_request(
    *,
    base_url: str,
    service_role_key: str,
    function_name: str,
    body: Mapping[str, Any],
) -> Any:
    return _supabase_request(
        method="POST",
        base_url=base_url,
        service_role_key=service_role_key,
        resource=f"rpc/{function_name}",
        body=body,
    )


def _try_acquire_project_run_lock(
    *,
    base_url: str,
    service_role_key: str,
    project_id: str,
    operation: str,
    owner: str,
    ttl_seconds: int = 900,
) -> str:
    rows = _supabase_rpc_request(
        base_url=base_url,
        service_role_key=service_role_key,
        function_name="try_acquire_audit_project_lock",
        body={
            "p_project_id": project_id,
            "p_operation": operation,
            "p_owner": owner,
            "p_ttl_seconds": ttl_seconds,
        },
    )
    row = rows[0] if isinstance(rows, Sequence) and rows and isinstance(rows[0], Mapping) else {}
    if not isinstance(row, Mapping):
        row = {}
    if row.get("acquired") is True and _safe_text(row.get("lock_token")):
        return _safe_text(row.get("lock_token"))
    active_operation = _safe_text(row.get("active_operation")) or "other_write_run"
    raise RuntimeError(f"PROJECT_RUN_LOCKED:{active_operation}")


def _release_project_run_lock(
    *,
    base_url: str,
    service_role_key: str,
    project_id: str,
    lock_token: str,
) -> None:
    if not project_id or not lock_token:
        return
    try:
        _supabase_rpc_request(
            base_url=base_url,
            service_role_key=service_role_key,
            function_name="release_audit_project_lock",
            body={
                "p_project_id": project_id,
                "p_lock_token": lock_token,
            },
        )
    except Exception:
        return


def _resolve_snapshot_project_id(
    *,
    base_url: str,
    service_role_key: str,
    spreadsheet_id: str,
    project_id_hint: str | None = None,
) -> str | None:
    if project_id_hint:
        return project_id_hint

    rows = _supabase_request(
        method="GET",
        base_url=base_url,
        service_role_key=service_role_key,
        resource="projects",
        query={
            "select": "id",
            "spreadsheet_id": f"eq.{spreadsheet_id}",
            "limit": "1",
        },
    )
    if isinstance(rows, Sequence) and rows:
        first = rows[0]
        if isinstance(first, Mapping) and first.get("id") is not None:
            return _safe_text(first.get("id"))
    return None


def _ensure_sync_run(
    *,
    base_url: str,
    service_role_key: str,
    project_id: str,
    spreadsheet_id: str,
    requested_by_email: str,
    sync_run_id_hint: str | None = None,
) -> str:
    if sync_run_id_hint:
        return sync_run_id_hint

    inserted = _supabase_request(
        method="POST",
        base_url=base_url,
        service_role_key=service_role_key,
        resource="audit_sync_runs",
        body={
            "project_id": project_id,
            "spreadsheet_id": spreadsheet_id,
            "trigger_source": "reclassify",
            "status": "running",
            "requested_by_email": requested_by_email or None,
            "started_at": _iso_now_utc(),
            "metrics_json": {},
            "mapping_manifest_json": {},
        },
    )
    if not isinstance(inserted, Sequence) or not inserted or not isinstance(inserted[0], Mapping):
        raise RuntimeError("Failed to create audit_sync_run row.")
    sync_run_id = _safe_text(inserted[0].get("id"))
    if not sync_run_id:
        raise RuntimeError("Created audit_sync_run row missing id.")
    return sync_run_id


def build_snapshot_payload(
    *,
    spreadsheet_id: str,
    sync_run_id: str,
    code_manifest_hash: str,
    reclassify_summary: Mapping[str, Any],
    results: Mapping[str, Any],
    formula_plan_input: Any,
    dashboard_summary: Mapping[str, Any] | None = None,
    formula_mapping_manifest: Mapping[str, Any] | None = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    formula_plan_templates, formula_warnings = _normalize_formula_plan_templates(formula_plan_input)
    dashboard_summary_payload = _safe_json_default(dict(dashboard_summary or {}))
    if not _dashboard_summary_has_real_metrics(dashboard_summary_payload):
        raise RuntimeError("DASHBOARD_SUMMARY_INCOMPLETE")
    normalized_mapping_manifest = _normalize_formula_mapping_manifest(formula_mapping_manifest or {})
    if _formula_templates_require_mapping_manifest(formula_plan_templates) and not normalized_mapping_manifest["mappings"]:
        raise RuntimeError("FORMULA_MAPPING_MANIFEST_MISSING")
    payload: Dict[str, Any] = {
        "schema_version": 1,
        "captured_at": _iso_now_utc(),
        "spreadsheet_id": spreadsheet_id,
        "sync_run_id": sync_run_id,
        "dashboard_summary": dashboard_summary_payload,
        "audit_dashboard_snapshot": dashboard_summary_payload,
        "formula_mapping_manifest": normalized_mapping_manifest,
        "classification_decisions": {
            "payable": _serialize_decisions(list(results.get("payable_decisions", []))),
            "final_detail": _serialize_decisions(list(results.get("final_detail_decisions", []))),
        },
        "formula_plan_templates": formula_plan_templates,
        "formula_plan_template_count": len(formula_plan_templates),
        "reclassify_summary": _safe_json_default(dict(reclassify_summary)),
        "mapping_status": {
            "mapping_metrics": _safe_json_default(dict(results.get("mapping_metrics", {}))),
            "mapping_warnings": _safe_json_default(list(results.get("mapping_warnings", []))),
            "formula_template_warnings": formula_warnings,
        },
    }
    payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    size_bytes = len(payload_json)

    manifest_json: Dict[str, Any] = {
        "version": 1,
        "source_mode": "semantic_runtime",
        "normalization": "template_preserving",
        "code_manifest_hash": code_manifest_hash,
        "formula_mapping_hash": normalized_mapping_manifest["mapping_hash"],
        "payload_size_bytes": size_bytes,
        "payload_size_warn_threshold_bytes": SNAPSHOT_PAYLOAD_WARN_BYTES,
    }
    if size_bytes > SNAPSHOT_PAYLOAD_WARN_BYTES:
        manifest_json["payload_warnings"] = ["SNAPSHOT_PAYLOAD_OVER_10MB"]

    return payload, manifest_json


def persist_reclassification_snapshot(
    *,
    spreadsheet_id: str,
    reclassify_summary: Mapping[str, Any],
    results: Mapping[str, Any],
    formula_plan_input: Any = None,
    requested_by_email: str = "",
    sync_run_id_hint: str | None = None,
    project_id_hint: str | None = None,
) -> Dict[str, Any]:
    base_url = _safe_text(os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL"))
    service_role_key = _safe_text(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    if not base_url or not service_role_key:
        return {
            "status": "skipped",
            "reason": "SUPABASE_ENV_MISSING",
        }

    code_manifest_hash = _compute_code_manifest_hash()
    project_id = _resolve_snapshot_project_id(
        base_url=base_url,
        service_role_key=service_role_key,
        spreadsheet_id=spreadsheet_id,
        project_id_hint=project_id_hint,
    )
    if not project_id:
        return {
            "status": "skipped",
            "reason": "PROJECT_NOT_FOUND",
            "code_manifest_hash": code_manifest_hash,
        }

    lock_token = ""
    try:
        lock_token = _try_acquire_project_run_lock(
            base_url=base_url,
            service_role_key=service_role_key,
            project_id=project_id,
            operation="reclassify_snapshot",
            owner=requested_by_email or "reclassify_worker",
        )

        sync_run_id = _ensure_sync_run(
            base_url=base_url,
            service_role_key=service_role_key,
            project_id=project_id,
            spreadsheet_id=spreadsheet_id,
            requested_by_email=requested_by_email,
            sync_run_id_hint=sync_run_id_hint,
        )
        formula_mapping_manifest: Dict[str, Any] = _normalize_formula_mapping_manifest({})
        dashboard_summary: Dict[str, Any] = {}
        try:
            deps = _load_worker_dependencies()
            mapping_service = deps.get("MappingService")
            get_project_mappings = getattr(mapping_service, "get_project_mappings", None)
            if callable(get_project_mappings):
                cache_clear = getattr(get_project_mappings, "cache_clear", None)
                if callable(cache_clear):
                    cache_clear()
                formula_mapping_manifest = _normalize_formula_mapping_manifest(get_project_mappings(project_id))
            dashboard_builder = deps.get("build_dashboard_summary_payload")
            if callable(dashboard_builder):
                dashboard_summary = dashboard_builder(
                    spreadsheet_id=spreadsheet_id,
                    project_id=project_id,
                    reclassify_summary=reclassify_summary,
                    mapping_metrics=results.get("mapping_metrics", {}),
                ) or {}
        except Exception:
            dashboard_summary = {}

        if not dashboard_summary:
            mapping_metrics = dict(results.get("mapping_metrics", {}))
            dashboard_summary = {
                "project_name": f"Project {(spreadsheet_id or '')[:8]}",
                "workflow_stage": "manual_input_ready",
                "highlights": [
                    {"label": "收入", "value": "-", "color": "slate"},
                    {"label": "成本", "value": "-", "color": "slate"},
                    {"label": "毛利", "value": "-", "color": "slate"},
                    {"label": "完工进度", "value": "-", "color": "slate"},
                ],
                "mapping_health": {
                    "fallback_count": int(mapping_metrics.get("fallback_count", 0) or 0),
                    "fallback_fields": list(mapping_metrics.get("fallback_fields", []) or []),
                    "mapping_score": float(mapping_metrics.get("mapping_score", 1.0) or 0.0),
                    "mapping_field_count": int(mapping_metrics.get("mapping_field_count", 0) or 0),
                },
                "audit_tabs": {
                    "external_recon": {
                        "summary": "后台快照已更新，前端将直接渲染快照摘要。",
                    },
                    "manual_input": {},
                    "reclass_audit": {
                        "overview": {
                            "payable_count": int(reclassify_summary.get("payable_rows_written", 0) or 0),
                            "final_detail_count": int(reclassify_summary.get("final_detail_rows_written", 0) or 0),
                            "diff_count": int(reclassify_summary.get("draw_request_unmatched_rows", 0) or 0),
                        }
                    },
                    "compare_109": {
                        "warnings": [],
                        "metric_rows": [],
                        "mapping_health": {
                            "fallback_count": int(mapping_metrics.get("fallback_count", 0) or 0),
                            "fallback_fields": list(mapping_metrics.get("fallback_fields", []) or []),
                            "mapping_score": float(mapping_metrics.get("mapping_score", 1.0) or 0.0),
                            "mapping_field_count": int(mapping_metrics.get("mapping_field_count", 0) or 0),
                        },
                    },
                },
            }

        payload, manifest_json = build_snapshot_payload(
            spreadsheet_id=spreadsheet_id,
            sync_run_id=sync_run_id,
            code_manifest_hash=code_manifest_hash,
            reclassify_summary=reclassify_summary,
            results=results,
            formula_plan_input=formula_plan_input,
            dashboard_summary=dashboard_summary,
            formula_mapping_manifest=formula_mapping_manifest,
        )

        inserted = _supabase_request(
            method="POST",
            base_url=base_url,
            service_role_key=service_role_key,
            resource="audit_snapshots",
            body={
                "project_id": project_id,
                "sync_run_id": sync_run_id,
                "spreadsheet_id": spreadsheet_id,
                "snapshot_version": 1,
                "data_json": payload,
                "mapping_manifest_json": manifest_json,
                "is_current": False,
            },
        )
        if not isinstance(inserted, Sequence) or not inserted or not isinstance(inserted[0], Mapping):
            raise RuntimeError("Failed to insert audit_snapshot row.")
        snapshot_id = _safe_text(inserted[0].get("id"))
        if not snapshot_id:
            raise RuntimeError("Inserted audit_snapshot row missing id.")

        update_metrics = {
            **_safe_json_default(dict(reclassify_summary)),
            "snapshot_payload_size_bytes": int(manifest_json.get("payload_size_bytes", 0)),
            "formula_plan_template_count": int(payload.get("formula_plan_template_count", 0)),
            "mapping_warning_count": int(
                dict(payload.get("mapping_status", {})).get("mapping_metrics", {}).get("mapping_warning_count", 0)
            ),
            "fallback_count": int(
                dict(payload.get("mapping_status", {})).get("mapping_metrics", {}).get("fallback_count", 0)
            ),
        }

        _supabase_request(
            method="PATCH",
            base_url=base_url,
            service_role_key=service_role_key,
            resource="audit_sync_runs",
            query={"id": f"eq.{sync_run_id}"},
            body={
                "snapshot_id": snapshot_id,
                "status": "succeeded",
                "finished_at": _iso_now_utc(),
                "metrics_json": update_metrics,
                "mapping_manifest_json": manifest_json,
                "code_manifest_hash": code_manifest_hash,
            },
        )

        return {
            "status": "persisted",
            "snapshot_id": snapshot_id,
            "sync_run_id": sync_run_id,
            "project_id": project_id,
            "code_manifest_hash": code_manifest_hash,
            "payload_size_bytes": int(manifest_json.get("payload_size_bytes", 0)),
            "is_current": False,
        }
    finally:
        if lock_token:
            _release_project_run_lock(
                base_url=base_url,
                service_role_key=service_role_key,
                project_id=project_id,
                lock_token=lock_token,
            )


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


def _read_validate_only(data: Mapping[str, Any]) -> bool:
    raw = data.get("validate_only")
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "validate"}
    operation = str(data.get("operation", "") or "").strip().lower()
    return operation == "validate"


def _read_operation(data: Mapping[str, Any]) -> str:
    raw = data.get("operation")
    if raw in (None, ""):
        return "reclassify"
    if not isinstance(raw, str):
        raise ValueError("operation must be a string")
    operation = raw.strip().lower()
    allowed = {"reclassify", "validate", "ensure_final_gmp_schema"}
    if operation not in allowed:
        raise ValueError(f"unsupported operation: {operation}")
    return operation


def _resolve_worker_secret() -> str:
    return (os.environ.get("RECLASSIFY_WORKER_SECRET") or os.environ.get("AIWB_WORKER_SECRET") or "").strip()


def _authorize_worker_request(request_handler: BaseHTTPRequestHandler) -> Tuple[bool, int, str]:
    expected_secret = _resolve_worker_secret()
    if not expected_secret:
        return False, 500, "Worker secret is not configured."
    actual_secret = str(request_handler.headers.get("X-AiWB-Worker-Secret", "") or "").strip()
    if actual_secret != expected_secret:
        return False, 401, "Unauthorized"
    return True, 200, ""


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        spreadsheet_id = ""
        try:
            authorized, status_code, auth_message = _authorize_worker_request(self)
            if not authorized:
                return self._send_error(status_code, auth_message)

            data = _read_json_body(self)
            spreadsheet_id = _safe_text(data.get("spreadsheet_id"))
            if not spreadsheet_id:
                return self._send_error(400, "spreadsheet_id is required")
            operation = _read_operation(data)
            validate_only = _read_validate_only(data) or operation == "validate"

            deps = _load_worker_dependencies()
            service = deps["get_sheets_service"]()
            sheet_map = load_reclassify_sheet_map(service, spreadsheet_id)

            if operation == "ensure_final_gmp_schema":
                final_gmp_meta = ensure_scoping_final_gmp_before_reclassification(
                    service,
                    spreadsheet_id,
                    sheet_map,
                    deps=deps,
                )
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "message": "Final GMP schema migration completed.",
                        "operation": "ensure_final_gmp_schema",
                        "spreadsheet_id": spreadsheet_id,
                        "final_gmp": final_gmp_meta,
                    },
                )

            if validate_only:
                results = compute_reclassification_results(sheet_map)
                validation = build_validation_payload(service, spreadsheet_id, results)
                return self._send_json(
                    200,
                    {
                        "ok": True,
                        "message": "Reclassification validation completed.",
                        "spreadsheet_id": spreadsheet_id,
                        "validation": validation,
                    },
                )

            final_gmp_meta = ensure_scoping_final_gmp_before_reclassification(
                service,
                spreadsheet_id,
                sheet_map,
                deps=deps,
            )
            if final_gmp_meta.get("inserted"):
                sheet_map = load_reclassify_sheet_map(service, spreadsheet_id)
            results = compute_reclassification_results(sheet_map)

            updates, summary = build_reclassify_updates(results)
            commit_result = push_reclassify_updates(service, spreadsheet_id, updates)
            try:
                snapshot_result = persist_reclassification_snapshot(
                    spreadsheet_id=spreadsheet_id,
                    reclassify_summary=summary,
                    results=results,
                    formula_plan_input=data.get("formula_plan"),
                    requested_by_email=_safe_text(data.get("requested_by_email")),
                    sync_run_id_hint=_safe_text(data.get("sync_run_id")) or None,
                    project_id_hint=_safe_text(data.get("project_id")) or None,
                )
            except Exception as snapshot_exc:
                snapshot_message = _safe_text(snapshot_exc)
                if any(
                    code in snapshot_message
                    for code in ("FORMULA_MAPPING_MANIFEST_MISSING", "DASHBOARD_SUMMARY_INCOMPLETE")
                ):
                    raise RuntimeError(snapshot_message) from snapshot_exc
                snapshot_result = {
                    "status": "failed",
                    "reason": "SNAPSHOT_PERSIST_FAILED",
                    "message": snapshot_message,
                }

            payload: Dict[str, Any] = {
                "ok": True,
                "message": "Reclassification worker completed.",
                "spreadsheet_id": spreadsheet_id,
                "summary": summary,
                "commit": commit_result,
            }
            if snapshot_result.get("status") in {"persisted", "failed"}:
                payload["snapshot"] = snapshot_result

            return self._send_json(200, payload)
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
