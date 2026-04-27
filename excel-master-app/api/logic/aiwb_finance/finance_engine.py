from __future__ import annotations

import json
import os
import pickle
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd
import yaml
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from openpyxl import load_workbook

from .finance_mapping import MapperFactory
from .finance_formulas import FinanceFormulaGenerator, FormulaTemplateResolver
from .finance_formatting import SemanticFormattingEngine
from .finance_mapping import ExcelSemanticMapper

from .finance_utils import (
    INTERNAL_COL_PREFIX,
    _to_plain_dict,
    _parse_options,
    _is_internal_col,
    _cloud_view,
    _column_number_to_a1,
    _quote_sheet_name,
    _normalize_formula_range,
    _normalize_formula_text_for_compare,
    _column_a1_to_number,
    _normalize_headers,
    _parse_cell_value,
    _parse_formula_value,
    _trim_matrix,
    _trim_display_and_formula_matrices,
    _build_formula_lookup,
    _build_formula_lookup_by_headers,
    _values_to_dataframe,
    _serialize_for_api,
    _dataframe_to_values,
    _df_signature,
    _safe_string,
    _safe_number,
    _to_float,
    _extract_tail_int,
    _extract_tail_str,
    _extract_year,
    _co_date_to_actual_settlement_date,
    _format_iso_date_or_blank,
    _normalize_date_value,
    _normalize_amount_key,
    _normalize_text_key,
    _has_digits,
    _contains_general_condition,
    _normalize_header_token,
    _find_col_in_headers,
    _find_col_in_row,
    _sheet_key,
    _ensure_column_count,
    _ensure_row_count,
    _get_cell,
    _column_values_1based,
    _set_cell,
    _sheet_delta_stats,
    _values_equal,
    _chunked,
    _contiguous_segments,
    _slugify_sheet_name,
    _normalize_label,
    _grid_cell,
    _find_first_row,
    _find_rows_by_item_label,
    _get_service_account_info,
    get_sheets_service,
)

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

DEFAULT_SERVICE_ACCOUNT_FILE = "credentials.json"
SHEET_109_NAME = "109"
SHEET_109_LOG_NAME = "AiWB_109_Log"
SHEET_UNIT_MASTER_NAME = "Unit Master"
LOCAL_ROOT = Path(".aiwb_local")
DRAFT_DIR = LOCAL_ROOT / "drafts"
AUDIT_LOG_FILE = LOCAL_ROOT / "aiwb_audit.log"
CLOUD_SNAPSHOT_FILE = LOCAL_ROOT / "cloud_snapshot.pkl"
RULE_ID_HIT_RATE_BASELINE_FILE = LOCAL_ROOT / "rule_id_hit_rate_baseline.json"
FORMULA_DICTIONARY_109_FILE = Path("docs/AiWB_公式字典_109_v1.yaml")
SANDY_COVE_DATES_FILE = Path("docs/Sandy cove.xlsx")

DAILY_API_QUOTA_ESTIMATE = 5000
DEFAULT_UID_COLUMN = "AiWB_UID"
DEFAULT_AMOUNT_COLUMN = "Amount"
DEFAULT_ENTITY_COLUMN = "WBH"
DEFAULT_GUARD_SHEET = "Project Ledger"
DEFAULT_EXPECTED_FIRST_CELL = "Project Ledger"
MANAGED_109_PROTECTION_DESCRIPTION = "AiWB managed main sheet protection"
MANAGED_109_FORMULA_LOCK_PREFIX = "AiWB managed formula lock"
MANAGED_EXTERNAL_PROTECTION_PREFIX = "AiWB managed external protection"
WORKBENCH_STAGE_PROJECT_CREATED = "project_created"
MANAGED_DATA_LOCK_PREFIX = "AiWB managed data lock"
FORMULA_WRITE_CHUNK_SIZE = 200

UID_STATUS_COL = "__AIWB_UID_SYNC_STATUS"
SHADOW_CONFLICT_COL = "__AIWB_SHADOW_CONFLICT"
SHADOW_PY_PROFIT_COL = "__AIWB_PY_PROFIT"
SHADOW_PY_TAX_COL = "__AIWB_PY_TAX"

UID_PENDING_VALUE = "待同步"
UID_SYNCED_VALUE = "已同步"

COLOR_FILL_WHITE = {"red": 1.0, "green": 1.0, "blue": 1.0}
COLOR_FILL_LIGHT_GRAY = {"red": 0.93, "green": 0.93, "blue": 0.93}
COLOR_FILL_LIGHT_RED = {"red": 0.98, "green": 0.89, "blue": 0.89}
COLOR_FILL_LIGHT_YELLOW = {"red": 1.0, "green": 0.96, "blue": 0.76}
NUMBER_FORMAT_PERCENT_2 = {"type": "NUMBER", "pattern": "0.00%"}
NUMBER_FORMAT_YEAR_0 = {"type": "NUMBER", "pattern": "0"}
NUMBER_FORMAT_DATE_ISO = {"type": "DATE", "pattern": "yyyy-mm-dd"}
DEFAULT_RULE_ID_HIT_RATE_ALERT_THRESHOLD = 0.20


def _derive_unit_budget_actual_settlement_fields(
    unit_code: Any,
    settlement_year: Any,
    co_date: Any,
    latest_unit_year: int | None,
) -> Tuple[str, int | str]:
    code_text = _safe_string(unit_code)
    actual_date = _co_date_to_actual_settlement_date(co_date)
    settlement_year_value = _extract_year(settlement_year)
    settlement_year_num = int(settlement_year_value) if settlement_year_value != "" else None
    actual_date_year = _extract_year(actual_date)
    actual_date_year_num = int(actual_date_year) if actual_date_year != "" else None
    is_unit_row = any(ch.isdigit() for ch in code_text)

    if is_unit_row:
        if actual_date_year_num is None:
            return "", ""
        return actual_date, actual_date_year_num
    else:
        fallback_candidates = [x for x in [actual_date_year_num, latest_unit_year, settlement_year_num] if x is not None]
        actual_year = fallback_candidates[0] if fallback_candidates else ""

    return actual_date, actual_year


def _unit_budget_layout(df: pd.DataFrame | None = None) -> Dict[str, int]:
    layout = {
        "unit_header_start": 17,
        "budget_variance": 8,
        "group": 10,
        "gmp": 11,
        "fee": 12,
        "wip": 13,
        "raw_budget_total": 16,
    }
    if df is None or len(df) == 0:
        return layout

    co_header = _safe_string(_get_cell(df, 0, 8)).lower()
    actual_year_header = _safe_string(_get_cell(df, 0, 10))
    tbd_header = _safe_string(_get_cell(df, 0, 11))
    if co_header == "c/o date" and actual_year_header == "实际结算年份" and tbd_header == "TBD Acceptance Date":
        return {
            "unit_header_start": 21,
            "budget_variance": 12,
            "group": 14,
            "gmp": 15,
            "fee": 16,
            "wip": 17,
            "raw_budget_total": 20,
        }
    if co_header == "c/o date" or actual_year_header == "实际结算年份":
        return {
            "unit_header_start": 20,
            "budget_variance": 11,
            "group": 13,
            "gmp": 14,
            "fee": 15,
            "wip": 16,
            "raw_budget_total": 19,
        }
    return layout


def _unit_budget_classification_layout(df: pd.DataFrame | None = None) -> Dict[str, int | None]:
    layout: Dict[str, int | None] = {
        "unit_code": 2,
        "co_date": None,
        "actual_settlement_date": None,
        "actual_settlement_year": None,
        "budget_variance": None,
        "tbd_acceptance_date": None,
        "group": None,
        "gmp": None,
        "fee": None,
        "wip": None,
    }
    if df is None or len(df) == 0:
        return layout

    # 在第 1 行或第 2 行查找标题
    h_idx = 1 if len(df) > 1 else 0

    layout["co_date"] = _find_col_in_row(df, h_idx, "C/O date")
    layout["actual_settlement_date"] = _find_col_in_row(df, h_idx, "实际结算日期") or _find_col_in_row(df, h_idx, "Actual Settlement Date") or 9
    layout["actual_settlement_year"] = _find_col_in_row(df, h_idx, "实际结算年份")
    layout["budget_variance"] = _find_col_in_row(df, h_idx, "预算差异")
    layout["tbd_acceptance_date"] = _find_col_in_row(df, h_idx, "TBD Acceptance Date") or 11
    layout["group"] = _find_col_in_row(df, h_idx, "Group")
    layout["gmp"] = _find_col_in_row(df, h_idx, "GMP")
    layout["fee"] = _find_col_in_row(df, h_idx, "Fee")
    layout["wip"] = _find_col_in_row(df, h_idx, "WIP")
    return layout


def _load_unit_budget_schedule_overrides_from_excel(
    path: str | Path,
) -> Dict[str, Dict[str, str]]:
    workbook_path = Path(path)
    if not workbook_path.exists():
        return {}

    wb = load_workbook(workbook_path, data_only=True, read_only=True)
    try:
        if not wb.worksheets:
            return {}
        ws = wb.worksheets[0]
        header_row = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), None)
        if not header_row:
            return {}

        header_lookup = {_normalize_header_token(value): idx for idx, value in enumerate(header_row)}
        unit_idx = header_lookup.get(_normalize_header_token("UnitCode"))
        co_idx = header_lookup.get(_normalize_header_token("C/O Date"))
        tbd_idx = header_lookup.get(_normalize_header_token("TBD Acceptance Date"))
        if unit_idx is None:
            return {}

        out: Dict[str, Dict[str, str]] = {}
        for row in ws.iter_rows(min_row=2, values_only=True):
            unit_code = _safe_string(row[unit_idx] if unit_idx < len(row) else "")
            if not unit_code:
                continue
            out[unit_code] = {
                "co_date": _format_iso_date_or_blank(row[co_idx] if co_idx is not None and co_idx < len(row) else ""),
                "tbd_acceptance_date": _format_iso_date_or_blank(
                    row[tbd_idx] if tbd_idx is not None and tbd_idx < len(row) else ""
                ),
            }
        return out
    finally:
        wb.close()


def _load_default_unit_budget_schedule_overrides() -> Dict[str, Dict[str, str]]:
    return _load_unit_budget_schedule_overrides_from_excel(SANDY_COVE_DATES_FILE)


def _build_unit_budget_schedule_map(
    wsb: pd.DataFrame,
    schedule_overrides: Mapping[str, Mapping[str, str]] | None = None,
) -> Dict[str, Dict[str, pd.Timestamp | None]]:
    layout = _unit_budget_classification_layout(wsb)
    overrides = schedule_overrides or {}
    schedule: Dict[str, Dict[str, pd.Timestamp | None]] = {}
    latest_numeric_actual: pd.Timestamp | None = None
    latest_numeric_tbd: pd.Timestamp | None = None

    for r in range(1, len(wsb)):
        unit_code = _safe_string(_get_cell(wsb, r, int(layout["unit_code"] or 2)))
        if not unit_code:
            continue
        override_item = overrides.get(unit_code, {})
        co_col = layout.get("co_date")
        co_date = override_item.get("co_date", "") or (
            _safe_string(_get_cell(wsb, r, int(co_col))) if co_col else ""
        )
        actual_dt = _normalize_date_value(_co_date_to_actual_settlement_date(co_date))
        if actual_dt is None:
            actual_dt = _normalize_date_value(_get_cell(wsb, r, int(layout["actual_settlement_date"] or 9)))
        tbd_col = layout.get("tbd_acceptance_date")
        tbd_source = override_item.get("tbd_acceptance_date", "") or (
            _get_cell(wsb, r, int(tbd_col)) if tbd_col else ""
        )
        tbd_dt = _normalize_date_value(tbd_source)
        schedule[unit_code] = {
            "actual_settlement_date": actual_dt,
            "tbd_acceptance_date": tbd_dt,
        }
        if _has_digits(unit_code):
            if actual_dt is not None:
                latest_numeric_actual = actual_dt if latest_numeric_actual is None else max(latest_numeric_actual, actual_dt)
            if tbd_dt is not None:
                latest_numeric_tbd = tbd_dt if latest_numeric_tbd is None else max(latest_numeric_tbd, tbd_dt)

    for unit_code, item in schedule.items():
        if _has_digits(unit_code):
            continue
        if item["actual_settlement_date"] is None:
            item["actual_settlement_date"] = latest_numeric_actual
        if item["tbd_acceptance_date"] is None:
            item["tbd_acceptance_date"] = latest_numeric_tbd

    schedule["__COMMON_FALLBACK__"] = {
        "actual_settlement_date": latest_numeric_actual,
        "tbd_acceptance_date": latest_numeric_tbd,
    }
    return schedule


def ensure_uid_anchor(df: pd.DataFrame, uid_column: str) -> Tuple[pd.DataFrame, int]:
    out = df.copy()
    generated = 0

    if uid_column not in out.columns:
        out[uid_column] = ""

    if UID_STATUS_COL not in out.columns:
        out[UID_STATUS_COL] = ""

    existing = {
        _safe_string(v)
        for v in out[uid_column].tolist()
        if _safe_string(v)
    }

    for idx in out.index:
        uid = _safe_string(out.at[idx, uid_column])
        status = _safe_string(out.at[idx, UID_STATUS_COL])

        if not uid:
            while True:
                candidate = f"AIWB-{uuid.uuid4().hex[:12].upper()}"
                if candidate not in existing:
                    existing.add(candidate)
                    uid = candidate
                    break
            out.at[idx, uid_column] = uid
            out.at[idx, UID_STATUS_COL] = UID_PENDING_VALUE
            generated += 1
        else:
            if status not in (UID_PENDING_VALUE, UID_SYNCED_VALUE):
                out.at[idx, UID_STATUS_COL] = UID_SYNCED_VALUE

    return out, generated


def mark_uid_synced(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if UID_STATUS_COL in out.columns:
        out[UID_STATUS_COL] = out[UID_STATUS_COL].astype("string").replace(UID_PENDING_VALUE, UID_SYNCED_VALUE)
    return out


def apply_shadow_logic(
    df: pd.DataFrame,
    revenue_col: str,
    cost_col: str,
    profit_col: str,
    tax_rate_col: str,
    tax_col: str,
    tolerance: float = 0.01,
) -> pd.DataFrame:
    out = df.copy()

    if SHADOW_CONFLICT_COL not in out.columns:
        out[SHADOW_CONFLICT_COL] = ""

    out[SHADOW_PY_PROFIT_COL] = pd.NA
    out[SHADOW_PY_TAX_COL] = pd.NA

    required = [revenue_col, cost_col, profit_col, tax_rate_col, tax_col]
    if any(col not in out.columns for col in required):
        out[SHADOW_CONFLICT_COL] = ""
        return out

    revenue = pd.to_numeric(out[revenue_col], errors="coerce")
    cost = pd.to_numeric(out[cost_col], errors="coerce")
    sheet_profit = pd.to_numeric(out[profit_col], errors="coerce")

    tax_rate = pd.to_numeric(out[tax_rate_col], errors="coerce").fillna(0)
    tax_rate = tax_rate.where(tax_rate <= 1, tax_rate / 100)

    py_profit = revenue.fillna(0) - cost.fillna(0)
    py_tax = py_profit.clip(lower=0) * tax_rate
    sheet_tax = pd.to_numeric(out[tax_col], errors="coerce")

    out[SHADOW_PY_PROFIT_COL] = py_profit.round(6)
    out[SHADOW_PY_TAX_COL] = py_tax.round(6)

    conflict_mask = (
        (sheet_profit - py_profit).abs().fillna(0) > tolerance
    ) | ((sheet_tax - py_tax).abs().fillna(0) > tolerance)

    out[SHADOW_CONFLICT_COL] = conflict_mask.map(lambda x: "冲突" if x else "")
    return out


def calculate_diff(
    original_df: pd.DataFrame,
    edited_df: pd.DataFrame,
    uid_column: str,
    amount_column: str,
) -> Dict[str, Any]:
    original = _cloud_view(original_df)
    edited = _cloud_view(edited_df)

    if uid_column not in original.columns or uid_column not in edited.columns:
        raise ValueError(f"缺少主键列 {uid_column}")

    original_uid = original[uid_column].astype("string").fillna("").str.strip()
    edited_uid = edited[uid_column].astype("string").fillna("").str.strip()

    duplicate_uid_count = int(edited_uid[edited_uid != ""].duplicated().sum())
    invalid_uid_rows = int((edited_uid == "").sum())

    original_idx = original.copy()
    edited_idx = edited.copy()
    original_idx[uid_column] = original_uid
    edited_idx[uid_column] = edited_uid
    original_idx = original_idx[original_idx[uid_column] != ""].drop_duplicates(uid_column, keep="first")
    edited_idx = edited_idx[edited_idx[uid_column] != ""].drop_duplicates(uid_column, keep="first")

    original_set = set(original_idx[uid_column].tolist())
    edited_set = set(edited_idx[uid_column].tolist())

    added = edited_set - original_set
    deleted = original_set - edited_set
    common = sorted(original_set & edited_set)

    compare_cols = [c for c in sorted(set(original_idx.columns) | set(edited_idx.columns)) if c != uid_column]

    modified_rows = 0
    if common:
        o = original_idx.set_index(uid_column).reindex(common).reindex(columns=compare_cols).astype("string").fillna("").apply(lambda s: s.str.strip())
        e = edited_idx.set_index(uid_column).reindex(common).reindex(columns=compare_cols).astype("string").fillna("").apply(lambda s: s.str.strip())
        modified_rows = int((o != e).any(axis=1).sum())

    before_amount = float(pd.to_numeric(original.get(amount_column, pd.Series(dtype="float64")), errors="coerce").fillna(0).sum())
    after_amount = float(pd.to_numeric(edited.get(amount_column, pd.Series(dtype="float64")), errors="coerce").fillna(0).sum())

    return {
        "added_rows": len(added),
        "modified_rows": modified_rows,
        "deleted_rows": len(deleted),
        "amount_delta": after_amount - before_amount,
        "before_amount_total": before_amount,
        "after_amount_total": after_amount,
        "invalid_uid_rows": invalid_uid_rows,
        "duplicate_uid_count": duplicate_uid_count,
        "original_rows": len(original),
        "edited_rows": len(edited),
    }


def build_sheet_delta_payload(
    sheet_name: str,
    original_df: pd.DataFrame,
    edited_df: pd.DataFrame,
    uid_column: str,
    amount_column: str,
    entity_column: str,
) -> Dict[str, Any]:
    original = _cloud_view(original_df)
    edited = _cloud_view(edited_df)

    if uid_column not in edited.columns:
        raise ValueError(f"工作表 {sheet_name} 缺少主键列 {uid_column}")

    uid_series = edited[uid_column].astype("string").fillna("").str.strip()
    dup_count = int(uid_series[uid_series != ""].duplicated().sum())
    if dup_count > 0:
        raise ValueError(f"工作表 {sheet_name} 存在 {dup_count} 个重复 {uid_column}，请先修复")

    headers = list(edited.columns)
    col_index = {col: idx + 1 for idx, col in enumerate(headers)}
    uid_col_index = col_index[uid_column]

    original_uid_series = (
        original[uid_column].astype("string").fillna("").str.strip()
        if uid_column in original.columns
        else pd.Series([""] * len(original))
    )

    original_row_map: Dict[str, Tuple[int, pd.Series]] = {}
    for pos, uid in enumerate(original_uid_series.tolist()):
        if uid and uid not in original_row_map:
            original_row_map[uid] = (pos + 2, original.iloc[pos])

    pending_col = edited_df.get(UID_STATUS_COL, pd.Series([""] * len(edited_df)))

    updates: List[dict] = []
    changed_rows = 0
    changed_cells = 0
    new_rows = 0
    pending_uid_updates = 0

    amount_delta_total = 0.0
    entity_amount_delta: Dict[str, float] = {}

    append_row_num = len(original) + 2
    seen_uid: set[str] = set()

    for idx in range(len(edited)):
        row = edited.iloc[idx]
        uid = _safe_string(row.get(uid_column, ""))
        if not uid:
            continue
        seen_uid.add(uid)

        force_uid_sync = _safe_string(pending_col.iloc[idx]) == UID_PENDING_VALUE

        if uid in original_row_map:
            row_num, old_row = original_row_map[uid]
            changed_idx: List[int] = []
            value_by_index: Dict[int, Any] = {}

            for col in headers:
                new_val = row.get(col, "")
                old_val = old_row[col] if col in original.columns else ""
                if not _values_equal(old_val, new_val):
                    col_i = col_index[col]
                    changed_idx.append(col_i)
                    value_by_index[col_i] = _serialize_for_api(new_val)

                    if col == amount_column:
                        old_num = _to_float(old_val) or 0.0
                        new_num = _to_float(new_val) or 0.0
                        delta = new_num - old_num
                        amount_delta_total += delta
                        entity = _safe_string(row.get(entity_column, "")) or "(未分类)"
                        entity_amount_delta[entity] = entity_amount_delta.get(entity, 0.0) + delta

            if force_uid_sync and uid_col_index not in value_by_index:
                changed_idx.append(uid_col_index)
                value_by_index[uid_col_index] = uid
                pending_uid_updates += 1

            if changed_idx:
                changed_rows += 1
                for start_i, end_i in _contiguous_segments(changed_idx):
                    values = [
                        value_by_index.get(col_i, _serialize_for_api(row.iloc[col_i - 1]))
                        for col_i in range(start_i, end_i + 1)
                    ]
                    updates.append(
                        {
                            "range": (
                                f"{_quote_sheet_name(sheet_name)}!"
                                f"{_column_number_to_a1(start_i)}{row_num}:"
                                f"{_column_number_to_a1(end_i)}{row_num}"
                            ),
                            "majorDimension": "ROWS",
                            "values": [values],
                        }
                    )
                    changed_cells += (end_i - start_i + 1)

        else:
            row_num = append_row_num
            append_row_num += 1
            new_rows += 1
            changed_rows += 1

            row_values = [_serialize_for_api(row.get(col, "")) for col in headers]
            updates.append(
                {
                    "range": (
                        f"{_quote_sheet_name(sheet_name)}!"
                        f"A{row_num}:{_column_number_to_a1(len(headers))}{row_num}"
                    ),
                    "majorDimension": "ROWS",
                    "values": [row_values],
                }
            )
            changed_cells += len(headers)

            if amount_column in headers:
                delta = _to_float(row.get(amount_column, "")) or 0.0
                amount_delta_total += delta
                entity = _safe_string(row.get(entity_column, "")) or "(未分类)"
                entity_amount_delta[entity] = entity_amount_delta.get(entity, 0.0) + delta

    deleted_rows = len(set(original_row_map.keys()) - seen_uid)

    return {
        "sheet": sheet_name,
        "updates": updates,
        "stats": {
            "changed_rows": changed_rows,
            "changed_cells": changed_cells,
            "new_rows": new_rows,
            "deleted_rows": deleted_rows,
            "pending_uid_updates": pending_uid_updates,
            "amount_delta": amount_delta_total,
            "entity_amount_delta": entity_amount_delta,
        },
    }


def build_commit_bundle(
    original_map: Mapping[str, pd.DataFrame],
    edited_map: Mapping[str, pd.DataFrame],
    target_sheets: Sequence[str],
    uid_column: str,
    amount_column: str,
    entity_column: str,
) -> Dict[str, Any]:
    all_updates: List[dict] = []
    per_sheet: List[Dict[str, Any]] = []

    summary = {
        "target_sheet_count": len(target_sheets),
        "changed_rows": 0,
        "changed_cells": 0,
        "new_rows": 0,
        "deleted_rows": 0,
        "pending_uid_updates": 0,
        "amount_delta": 0.0,
    }

    audit_lines: List[str] = []

    for sheet in target_sheets:
        payload = build_sheet_delta_payload(
            sheet_name=sheet,
            original_df=original_map.get(sheet, pd.DataFrame()),
            edited_df=edited_map.get(sheet, pd.DataFrame()),
            uid_column=uid_column,
            amount_column=amount_column,
            entity_column=entity_column,
        )
        stats = payload["stats"]
        updates = payload["updates"]

        per_sheet.append({"sheet": sheet, **stats, "update_count": len(updates)})
        all_updates.extend(updates)

        summary["changed_rows"] += int(stats["changed_rows"])
        summary["changed_cells"] += int(stats["changed_cells"])
        summary["new_rows"] += int(stats["new_rows"])
        summary["deleted_rows"] += int(stats["deleted_rows"])
        summary["pending_uid_updates"] += int(stats["pending_uid_updates"])
        summary["amount_delta"] += float(stats["amount_delta"])

        entity_delta: Dict[str, float] = stats["entity_amount_delta"]
        if entity_delta:
            for entity, delta in sorted(entity_delta.items(), key=lambda x: abs(x[1]), reverse=True):
                audit_lines.append(
                    f"实体 {entity}：金额差异合计 {delta:,.2f}（sheet={sheet}）"
                )
        else:
            audit_lines.append(
                f"sheet={sheet}：变更 {stats['changed_rows']} 行，新增 {stats['new_rows']} 行"
            )

    return {
        "updates": all_updates,
        "summary": summary,
        "per_sheet": per_sheet,
        "audit_lines": audit_lines,
    }


def _sync_unit_master_py(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Any]]:
    out = {k: v.copy() for k, v in sheet_map.items()}
    wsb_key = _sheet_key(out, "Unit Budget")
    layout = _unit_budget_layout(out[wsb_key])
    wsb = _ensure_column_count(out[wsb_key], layout["unit_header_start"])
    units: set[str] = set()

    for col_i in range(layout["unit_header_start"], len(wsb.columns) + 1):
        h = _safe_string(wsb.columns[col_i - 1])
        if h and h.upper() != "UNIT CODE":
            units.add(h)

    scan_specs = [
        ("Payable", 38),
        ("Final Detail", 21),
        ("Draw request report", 8),
    ]
    for name, col in scan_specs:
        try:
            key = _sheet_key(out, name)
        except KeyError:
            continue
        src = _ensure_column_count(out[key], col)
        for r in range(0, len(src)):
            val = _safe_string(_get_cell(src, r, col))
            if val:
                units.add(val)

    sorted_units = sorted(units)

    if len(wsb) >= 2:
        for r in range(1, len(wsb)):
            wsb = _set_cell(wsb, r, 2, "")

    for idx, unit in enumerate(sorted_units):
        row_idx = 1 + idx
        wsb = _set_cell(wsb, row_idx, 2, unit)

    out[wsb_key] = wsb
    return out, {"unit_count": len(sorted_units)}


def _calculate_unit_budget_cd_py(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Any]]:
    out = {k: v.copy() for k, v in sheet_map.items()}
    wsb_key = _sheet_key(out, "Unit Budget")
    wsb = out[wsb_key].copy()
    layout = _unit_budget_layout(wsb)

    row_count = len(wsb)
    col_count = len(wsb.columns)
    if row_count == 0:
        return out, {"computed_rows": 0}

    unit_col_map: Dict[str, int] = {}
    for j in range(layout["unit_header_start"], col_count + 1):
        h = _safe_string(wsb.columns[j - 1])
        if h:
            unit_col_map[h] = j

    results: List[Tuple[Any, Any]] = []

    for i in range(1, row_count):
        u_code = _safe_string(_get_cell(wsb, i, 2))
        sum_c = 0.0
        sum_d = 0.0

        target_col = unit_col_map.get(u_code)
        if u_code and target_col is not None:
            for r in range(0, row_count):
                val_k = _to_float(_get_cell(wsb, r, layout["gmp"]))
                val_m = _safe_string(_get_cell(wsb, r, layout["wip"]))
                cell_value = _safe_number(_get_cell(wsb, r, target_col))

                if val_k is not None and abs(val_k - 1) < 1e-9:
                    sum_c += cell_value
                if val_m.endswith("3"):
                    sum_d += cell_value

        c_val = "" if abs(sum_c) < 1e-12 else sum_c
        d_val = "" if abs(sum_d) < 1e-12 else sum_d
        results.append((c_val, d_val))

    for offset, (c_val, d_val) in enumerate(results):
        row_idx = 1 + offset
        wsb = _set_cell(wsb, row_idx, 3, c_val)
        wsb = _set_cell(wsb, row_idx, 4, d_val)

    out[wsb_key] = wsb
    return out, {"computed_rows": len(results)}


def _build_final_detail_summary_rows(
    units: Sequence[str],
    row_unit_codes: Sequence[str],
    row_d_values: Sequence[Any],
    row_c_values: Sequence[Any],
    row_p_values: Sequence[Any],
    row_t_texts: Sequence[str],
    row_v_texts: Sequence[str],
) -> List[List[Any]]:
    summary_by_unit: Dict[str, List[float]] = {}
    row_count = min(
        len(row_unit_codes),
        len(row_d_values),
        len(row_c_values),
        len(row_p_values),
        len(row_t_texts),
        len(row_v_texts),
    )

    for i in range(row_count):
        unit_code = _safe_string(row_unit_codes[i])
        if not unit_code:
            continue
        bucket = summary_by_unit.setdefault(unit_code, [0.0, 0.0, 0.0])
        bucket[0] += _safe_number(row_d_values[i])

        c_flag = _to_float(row_c_values[i])
        p_val = _safe_number(row_p_values[i])
        if c_flag is not None and abs(c_flag - 1) < 1e-9:
            bucket[1] += p_val
        if not _safe_string(row_t_texts[i]) and _safe_string(row_v_texts[i]) != "Sharing":
            bucket[2] += p_val

    summary_rows: List[List[Any]] = []
    for unit_code in units:
        if not unit_code:
            summary_rows.append(["", "", "", ""])
            continue
        sum_f, sum_g, sum_h = summary_by_unit.get(unit_code, [0.0, 0.0, 0.0])
        summary_rows.append(
            [
                unit_code,
                "" if abs(sum_f) < 1e-12 else sum_f,
                "" if abs(sum_g) < 1e-12 else sum_g,
                "" if abs(sum_h) < 1e-12 else sum_h,
            ]
        )
    return summary_rows


def _collect_rule_ids_from_sheet_map(
    sheet_map: Mapping[str, pd.DataFrame],
    target_sheets: Sequence[str] = ("Payable", "Final Detail"),
) -> List[str]:
    rule_ids: List[str] = []
    for sheet_name in target_sheets:
        try:
            key = _sheet_key(sheet_map, sheet_name)
        except KeyError:
            continue
        df = sheet_map.get(key, pd.DataFrame())
        if len(df.columns) < 2:
            continue
        for value in df.iloc[:, 1].tolist():
            text = _safe_string(value)
            if text:
                rule_ids.append(text)
    return rule_ids


def _detect_rule_id_hit_rate_alerts(
    current_rule_ids: Sequence[str],
    historical_avg_rates: Mapping[str, float],
    deviation_threshold: float = DEFAULT_RULE_ID_HIT_RATE_ALERT_THRESHOLD,
) -> List[Dict[str, Any]]:
    cleaned_rule_ids = [_safe_string(rule_id) for rule_id in current_rule_ids if _safe_string(rule_id)]
    total = len(cleaned_rule_ids)
    if total <= 0:
        return []

    counts: Dict[str, int] = {}
    for rule_id in cleaned_rule_ids:
        counts[rule_id] = counts.get(rule_id, 0) + 1

    alerts: List[Dict[str, Any]] = []
    for rule_id, historical_avg_rate in historical_avg_rates.items():
        key = _safe_string(rule_id)
        if not key:
            continue
        try:
            historical_rate = float(historical_avg_rate)
        except Exception:
            continue
        if historical_rate < 0.0 or historical_rate > 1.0:
            continue

        current_rate = counts.get(key, 0) / total
        deviation = current_rate - historical_rate
        if abs(deviation) <= float(deviation_threshold):
            continue

        alerts.append(
            {
                "rule_id": key,
                "current_rate": current_rate,
                "historical_avg_rate": historical_rate,
                "deviation": deviation,
                "current_count": counts.get(key, 0),
                "total_count": total,
            }
        )

    alerts.sort(key=lambda item: abs(float(item["deviation"])), reverse=True)
    return alerts


def _process_payable_py(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Any]]:
    from .finance_classification import compute_payable_classifications
    out = {k: v.copy() for k, v in sheet_map.items()}
    wsp_key = _sheet_key(out, "Payable")
    wss_key = _sheet_key(out, "Scoping")

    wsp = _ensure_column_count(out[wsp_key], 43)
    wss = _ensure_column_count(out[wss_key], 10)

    mapping = {
        "Wan Bridge Development LLC": "WBD",
        "Wan Pacific Real Estate Development LLC": "WPRED",
        "WB Home LLC": "WBH",
        "WB Lago Mar Pod 8 Land LLC": "WLM",
    }
    categories, classification_extra = compute_payable_classifications(out)
    if len(categories) == len(wsp):
        first_col = wsp.columns[0]
        wsp[first_col] = categories
    rule_ids = list(classification_extra.get("rule_ids", []))
    if len(rule_ids) == len(wsp) and len(wsp.columns) >= 2:
        second_col = wsp.columns[1]
        wsp[second_col] = rule_ids

    scoping_rows = len(wss)
    scope_agg: Dict[int, Tuple[float, float, float]] = {}
    for r in range(scoping_rows):
        code = _to_float(_get_cell(wss, r, 3))
        if code is None:
            continue
        key = int(code)
        cur = scope_agg.get(key, (0.0, 0.0, 0.0))
        e = cur[0] + _safe_number(_get_cell(wss, r, 5))
        f = cur[1] + _safe_number(_get_cell(wss, r, 6))
        g = cur[2] + _safe_number(_get_cell(wss, r, 8))
        scope_agg[key] = (e, f, g)

    write_rows: List[List[Any]] = []
    for i in range(len(wsp)):
        o_text = _safe_string(_get_cell(wsp, i, 15))
        v_text = _safe_string(_get_cell(wsp, i, 22))
        am_text = _safe_string(_get_cell(wsp, i, 39))

        j_val = _extract_tail_str(v_text, 4)
        d_val = _extract_tail_int(am_text, 3)
        c_val = mapping.get(o_text, "")

        s_e: Any = ""
        s_f: Any = ""
        s_g: Any = ""
        if d_val is not None:
            sums = scope_agg.get(int(d_val), (0.0, 0.0, 0.0))
            s_e = "" if abs(sums[0]) < 1e-12 else sums[0]
            s_f = "" if abs(sums[1]) < 1e-12 else sums[1]
            s_g = "" if abs(sums[2]) < 1e-12 else sums[2]

        write_rows.append([c_val, d_val if d_val is not None else "", s_e, s_f, s_g, "", "", j_val])

    payable_write_cols = list(wsp.columns[2:10])
    if len(write_rows) == len(wsp) and len(payable_write_cols) == 8:
        for col in payable_write_cols:
            if str(wsp[col].dtype) != "object":
                wsp[col] = wsp[col].astype(object)
        wsp.loc[:, payable_write_cols] = pd.DataFrame(write_rows, index=wsp.index, columns=payable_write_cols)

    out[wsp_key] = wsp
    return out, classification_extra


def _process_final_detail_py(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Any]]:
    from .finance_classification import compute_final_detail_classifications
    out = {k: v.copy() for k, v in sheet_map.items()}
    wsf_key = _sheet_key(out, "Final Detail")
    wss_key = _sheet_key(out, "Scoping")
    wsb_key = _sheet_key(out, "Unit Budget")

    wsf = _ensure_column_count(out[wsf_key], 30)
    wss = _ensure_column_count(out[wss_key], 10)
    wsb = _ensure_column_count(out[wsb_key], 16)
    categories, classification_extra = compute_final_detail_classifications(out)
    if len(categories) == len(wsf):
        first_col = wsf.columns[0]
        wsf[first_col] = categories
    rule_ids = list(classification_extra.get("rule_ids", []))
    if len(rule_ids) == len(wsf) and len(wsf.columns) >= 2:
        second_col = wsf.columns[1]
        wsf[second_col] = rule_ids

    scope_sum_c: Dict[int, float] = {}
    scope_codes = _column_values_1based(wss, 3)
    scope_amounts = _column_values_1based(wss, 5)
    for r in range(len(wss)):
        code = _to_float(scope_codes[r])
        if code is None:
            continue
        key = int(code)
        scope_sum_c[key] = scope_sum_c.get(key, 0.0) + _safe_number(scope_amounts[r])

    unit_seen: set[str] = set()
    z_texts = [_safe_string(value) for value in _column_values_1based(wsf, 26)]
    o_values = _column_values_1based(wsf, 15)
    t_values = _column_values_1based(wsf, 20)
    u_keys = [_safe_string(value) for value in _column_values_1based(wsf, 21)]

    row_level_write_rows: List[List[Any]] = []
    for i in range(len(wsf)):
        z_text = z_texts[i]
        o_val = o_values[i]
        t_val = t_values[i]
        u_key = u_keys[i]

        b_val = _extract_tail_int(z_text, 3)
        k_val = _extract_year(t_val)

        c_val: Any = ""
        if b_val is not None:
            s = scope_sum_c.get(int(b_val), 0.0)
            c_val = "" if abs(s) < 1e-12 else s

        d_val: Any = ""
        if u_key and u_key not in unit_seen:
            y = _extract_year(o_val)
            d_val = y if y != "" else ""
            unit_seen.add(u_key)

        row_level_write_rows.append(
            [
                c_val,
                d_val,
                "",
                "",
                "",
                "",
                "",
                "",
                k_val if k_val != "" else "",
            ]
        )

    final_detail_row_cols = list(wsf.columns[2:11])
    if len(row_level_write_rows) == len(wsf) and len(final_detail_row_cols) == 9:
        for col in final_detail_row_cols:
            if str(wsf[col].dtype) != "object":
                wsf[col] = wsf[col].astype(object)
        wsf.loc[:, final_detail_row_cols] = pd.DataFrame(
            row_level_write_rows,
            index=wsf.index,
            columns=final_detail_row_cols,
        )

    units = [_safe_string(value) for value in _column_values_1based(wsb, 2)[1:]]
    summary_rows = _build_final_detail_summary_rows(
        units=units,
        row_unit_codes=u_keys,
        row_d_values=_column_values_1based(wsf, 4),
        row_c_values=_column_values_1based(wsf, 3),
        row_p_values=_column_values_1based(wsf, 16),
        row_t_texts=[_safe_string(value) for value in _column_values_1based(wsf, 20)],
        row_v_texts=[_safe_string(value) for value in _column_values_1based(wsf, 22)],
    )

    summary_write_cols = list(wsf.columns[4:8])
    if len(summary_rows) == len(units) and len(summary_write_cols) == 4:
        summary_df = pd.DataFrame(summary_rows, columns=summary_write_cols, index=range(len(units)))
        if len(wsf) < len(summary_df):
            wsf = _ensure_row_count(wsf, len(summary_df))
        for col in summary_write_cols:
            if str(wsf[col].dtype) != "object":
                wsf[col] = wsf[col].astype(object)
        wsf.loc[summary_df.index, summary_write_cols] = summary_df

    if len(rule_ids) == len(wsf) and len(wsf.columns) >= 2:
        second_col = wsf.columns[1]
        wsf[second_col] = rule_ids

    out[wsf_key] = wsf
    final_extra = dict(classification_extra)
    final_extra["summary_rows"] = len(units)
    return out, final_extra


def load_rule_id_hit_rate_baseline() -> Dict[str, float]:
    if not RULE_ID_HIT_RATE_BASELINE_FILE.exists():
        return {}
    try:
        payload = json.loads(RULE_ID_HIT_RATE_BASELINE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}

    if isinstance(payload, Mapping):
        candidate = payload.get("rule_rates", payload)
    else:
        candidate = {}

    if not isinstance(candidate, Mapping):
        return {}

    baseline: Dict[str, float] = {}
    for rule_id, rate in candidate.items():
        key = _safe_string(rule_id)
        if not key:
            continue
        try:
            numeric_rate = float(rate)
        except Exception:
            continue
        if 0.0 <= numeric_rate <= 1.0:
            baseline[key] = numeric_rate
    return baseline


def run_apps_shadow_pipeline(
    edited_map: Mapping[str, pd.DataFrame],
    uid_column: str,
    shadow_cfg: Mapping[str, Any],
) -> Tuple[Dict[str, pd.DataFrame], List[Dict[str, Any]], List[str]]:
    working = {k: v.copy() for k, v in edited_map.items()}
    reports: List[Dict[str, Any]] = []
    audit_lines: List[str] = []

    def apply_and_report(
        step_name: str,
        handler,
        focus_sheets: Sequence[str],
    ) -> None:
        nonlocal working
        resolved_focus: List[str] = []
        for s in focus_sheets:
            try:
                resolved_focus.append(_sheet_key(working, s))
            except KeyError:
                continue
        before = {k: working[k].copy() for k in resolved_focus if k in working}
        working, extra = handler(working)
        changed_rows = 0
        changed_cells = 0
        touched: List[str] = []
        for sheet in resolved_focus:
            if sheet not in working or sheet not in before:
                continue
            stats = _sheet_delta_stats(before[sheet], working[sheet])
            if stats["changed_cells"] > 0:
                touched.append(sheet)
                changed_rows += stats["changed_rows"]
                changed_cells += stats["changed_cells"]
        reports.append(
            {
                "step": step_name,
                "sheets": "、".join(touched) if touched else "无",
                "changed_rows": changed_rows,
                "changed_cells": changed_cells,
                "extra": extra,
            }
        )
        audit_lines.append(
            f"{step_name}: sheets={reports[-1]['sheets']}, rows={changed_rows}, cells={changed_cells}, extra={extra}"
        )

    def apply_from_source_and_report(
        step_name: str,
        handler,
        focus_sheets: Sequence[str],
        source_map: Mapping[str, pd.DataFrame],
    ) -> None:
        nonlocal working
        resolved_focus: List[str] = []
        for s in focus_sheets:
            try:
                resolved_focus.append(_sheet_key(working, s))
            except KeyError:
                continue
        before = {k: working[k].copy() for k in resolved_focus if k in working}
        source_copy = {k: v.copy() for k, v in source_map.items()}
        processed_map, extra = handler(source_copy)
        for sheet in resolved_focus:
            if sheet in processed_map:
                working[sheet] = processed_map[sheet]

        changed_rows = 0
        changed_cells = 0
        touched: List[str] = []
        for sheet in resolved_focus:
            if sheet not in working or sheet not in before:
                continue
            stats = _sheet_delta_stats(before[sheet], working[sheet])
            if stats["changed_cells"] > 0:
                touched.append(sheet)
                changed_rows += stats["changed_rows"]
                changed_cells += stats["changed_cells"]
        reports.append(
            {
                "step": step_name,
                "sheets": "、".join(touched) if touched else "无",
                "changed_rows": changed_rows,
                "changed_cells": changed_cells,
                "extra": extra,
            }
        )
        audit_lines.append(
            f"{step_name}: sheets={reports[-1]['sheets']}, rows={changed_rows}, cells={changed_cells}, extra={extra}"
        )

    apply_and_report("同步 Unit 列表(B列)", _sync_unit_master_py, ["Unit Budget"])
    apply_and_report("计算 Unit Budget C/D", _calculate_unit_budget_cd_py, ["Unit Budget"])
    classification_base = {k: v.copy() for k, v in working.items()}
    apply_from_source_and_report("核算 Payable C:J", _process_payable_py, ["Payable"], classification_base)
    apply_from_source_and_report("核算 Final Detail(B:K,E:H)", _process_final_detail_py, ["Final Detail"], classification_base)

    for sheet, df in list(working.items()):
        prepared, _ = ensure_uid_anchor(df, uid_column)
        prepared = apply_shadow_logic(
            prepared,
            revenue_col=shadow_cfg["revenue_col"],
            cost_col=shadow_cfg["cost_col"],
            profit_col=shadow_cfg["profit_col"],
            tax_rate_col=shadow_cfg["tax_rate_col"],
            tax_col=shadow_cfg["tax_col"],
            tolerance=float(shadow_cfg["tolerance"]),
        )
        working[sheet] = prepared

    historical_rule_rates = load_rule_id_hit_rate_baseline()
    if historical_rule_rates:
        current_rule_ids = _collect_rule_ids_from_sheet_map(working)
        alerts = _detect_rule_id_hit_rate_alerts(
            current_rule_ids=current_rule_ids,
            historical_avg_rates=historical_rule_rates,
            deviation_threshold=DEFAULT_RULE_ID_HIT_RATE_ALERT_THRESHOLD,
        )
        reports.append(
            {
                "step": "Rule ID 异常波动预警",
                "sheets": "Payable、Final Detail",
                "changed_rows": 0,
                "changed_cells": 0,
                "extra": {
                    "alert_count": len(alerts),
                    "alerts": alerts,
                    "baseline_rule_count": len(historical_rule_rates),
                    "observed_rule_id_count": len(current_rule_ids),
                },
            }
        )
        if alerts:
            top_alert = alerts[0]
            audit_lines.append(
                "Rule ID 异常波动预警: "
                f"alert_count={len(alerts)}, "
                f"top_rule={top_alert['rule_id']}, "
                f"current_rate={top_alert['current_rate']:.2%}, "
                f"historical_avg_rate={top_alert['historical_avg_rate']:.2%}, "
                f"deviation={top_alert['deviation']:.2%}"
            )
        else:
            audit_lines.append(
                "Rule ID 异常波动预警: alert_count=0, baseline_loaded=1"
            )

    return working, reports, audit_lines


def _safety_check(
    service,
    spreadsheet_id: str,
    guard_sheet_name: str,
    expected_first_cell: str,
) -> None:
    first_row_resp = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"{guard_sheet_name}!1:1")
        .execute()
    )
    first_row = first_row_resp.get("values", [[]])[0] if first_row_resp.get("values") else []
    row_tokens = {str(item).strip() for item in first_row}

    if expected_first_cell and expected_first_cell not in row_tokens:
        raise RuntimeError(
            f"安全校验失败：{guard_sheet_name} 首行未检测到 '{expected_first_cell}'，已中止写入。"
        )


def execute_commit(
    service,
    spreadsheet_id: str,
    bundle: Mapping[str, Any],
    guard_sheet_name: str,
    expected_first_cell: str,
) -> Dict[str, Any]:
    updates = list(bundle.get("updates", []))
    if not updates:
        return {"api_calls": 0, "updated_ranges": 0}

    _safety_check(service, spreadsheet_id, guard_sheet_name, expected_first_cell)

    api_calls = 1
    for chunk in _chunked(updates, 500):
        (
            service.spreadsheets()
            .values()
            .batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={
                    "valueInputOption": "USER_ENTERED",
                    "data": list(chunk),
                },
            )
            .execute()
        )
        api_calls += 1

    return {"api_calls": api_calls, "updated_ranges": len(updates)}


def _find_year_header_row_109(rows: Sequence[Sequence[Any]]) -> int | None:
    axis = _detect_109_year_axis(rows)
    if axis:
        return axis[0]
    return None


def _detect_109_year_axis(rows: Sequence[Sequence[Any]]) -> Tuple[int, List[int], List[int]] | None:
    for row_i in range(1, len(rows) + 1):
        row = rows[row_i - 1] if row_i - 1 < len(rows) else []
        starts: List[int] = []
        for start_col in range(1, max(len(row) - 4, 1)):
            vals = [_extract_year(_grid_cell(rows, row_i, col)) for col in range(start_col, start_col + 6)]
            if all(isinstance(val, int) for val in vals) and vals == list(range(int(vals[0]), int(vals[0]) + 6)):
                starts.append(start_col)
        if starts:
            primary = list(range(starts[0], starts[0] + 6))
            audit_start = starts[1] if len(starts) > 1 else starts[0] + 7
            audit = list(range(audit_start, audit_start + 6))
            return row_i, primary, audit
    return None


def _build_109_year_axis_config(rows: Sequence[Sequence[Any]]) -> Dict[str, Any]:
    axis = _detect_109_year_axis(rows)
    if not axis:
        return {}
    _, primary_cols, audit_cols = axis
    anchor_col = _column_number_to_a1(primary_cols[-1])
    return {
        "primary_year_cols": [_column_number_to_a1(col) for col in primary_cols],
        "audit_year_cols": [_column_number_to_a1(col) for col in audit_cols],
        "start_year_anchor_cell": f"{anchor_col}2",
    }


def _choose_contract_price_row(rows: Sequence[Sequence[Any]], label_rows: Dict[str, List[int]]) -> int | None:
    rows_cp = label_rows.get("contract price", [])
    if not rows_cp:
        return None
    for row_i in rows_cp:
        if _to_float(_grid_cell(rows, row_i, 5)) is not None:
            return row_i
    return rows_cp[0]


def _find_contract_price_day1_row(rows: Sequence[Sequence[Any]]) -> int | None:
    for row_i in range(1, len(rows) + 1):
        label = _normalize_label(_grid_cell(rows, row_i, 4))
        if label == "contract price (day1):":
            if _grid_cell(rows, row_i, 5) != "":
                return row_i
    return None


def _find_budget_cost_row(rows: Sequence[Sequence[Any]], label_rows: Dict[str, List[int]]) -> int | None:
    for label, row_list in label_rows.items():
        if "budget cost" in label and "scoping" in label:
            return row_list[0]
    return None


def _first_present_row(label_rows: Mapping[str, Sequence[int]], *labels: str) -> int | None:
    for label in labels:
        row_list = list(label_rows.get(label, []))
        if row_list:
            return int(row_list[0])
    return None


def _merge_formula_plan_with_semantic_updates(
    plan: Sequence[Mapping[str, str]],
    semantic_updates: Sequence[Mapping[str, str]],
) -> List[Dict[str, str]]:
    merged_by_range: Dict[str, Dict[str, str]] = {}
    ordered_ranges: List[str] = []

    for item in plan:
        range_ref = str(item["range"])
        if range_ref not in merged_by_range:
            ordered_ranges.append(range_ref)
        merged_by_range[range_ref] = dict(item)

    for item in semantic_updates:
        range_ref = str(item["range"])
        if range_ref not in merged_by_range:
            ordered_ranges.append(range_ref)
        merged_by_range[range_ref] = dict(item)

    return [merged_by_range[range_ref] for range_ref in ordered_ranges]


def _compat_global(name: str) -> Any:
    wrapper = sys.modules.get("finance_engine")
    current = globals().get(name)
    if wrapper is not None and wrapper is not sys.modules.get(__name__) and hasattr(wrapper, name):
        candidate = getattr(wrapper, name)
        if candidate is not current:
            return candidate
    return current


class SnapshotStaleError(RuntimeError):
    pass


class MappingService:
    @staticmethod
    def get_project_mappings(project_id: str | None) -> Dict[str, Any]:
        if not project_id:
            return {}
        rows = _compat_global("_supabase_rest_request_json")(
            resource="sheet_field_mappings",
            query={
                "select": "sheet_name,logical_field,column_index",
                "project_id": f"eq.{project_id}",
            },
        )
        mappings: Dict[str, Dict[str, int]] = {}
        if not isinstance(rows, Sequence):
            return {}
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            sheet_name = _safe_string(row.get("sheet_name"))
            logical_field = _safe_string(row.get("logical_field"))
            column_index = row.get("column_index")
            if not sheet_name or not logical_field:
                continue
            try:
                column_number = int(column_index)
            except (TypeError, ValueError):
                continue
            if column_number < 1:
                continue
            mappings.setdefault(sheet_name, {})[logical_field] = column_number
        return mappings


def _safe_json_default(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _safe_json_default(val) for key, val in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_json_default(item) for item in value]
    if isinstance(value, (datetime, pd.Timestamp)):
        return value.isoformat()
    return value


def _supabase_rest_request_json(
    *,
    method: str = "GET",
    resource: str,
    query: Mapping[str, Any] | None = None,
    body: Mapping[str, Any] | None = None,
    base_url: str | None = None,
    service_role_key: str | None = None,
) -> Any:
    base = (base_url or os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    key = service_role_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or ""
    if not base or not key:
        return []
    url = f"{base}/rest/v1/{resource}"
    if query:
        url += "?" + urlencode({str(k): str(v) for k, v in query.items()})
    data = None
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Prefer"] = "return=representation"
    request = Request(url, data=data, method=method, headers=headers)
    with urlopen(request, timeout=20) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else []


def _fetch_project_main_sheet_title(project_id: str | None = None, **_: Any) -> str:
    if not project_id:
        return ""
    try:
        rows = _compat_global("_supabase_rest_request_json")(
            resource="projects",
            query={"select": "sheet_109_title,project_sequence", "id": f"eq.{project_id}", "limit": "1"},
        )
    except Exception as exc:
        if "project_sequence" not in str(exc):
            raise
        rows = _compat_global("_supabase_rest_request_json")(
            resource="projects",
            query={"select": "sheet_109_title", "id": f"eq.{project_id}", "limit": "1"},
        )
    if isinstance(rows, Sequence) and rows and isinstance(rows[0], Mapping):
        return _safe_string(rows[0].get("sheet_109_title")) or _safe_string(rows[0].get("project_sequence"))
    return ""


def _fetch_project_sequence(project_id: str | None = None, **_: Any) -> str:
    if not project_id:
        return ""
    try:
        rows = _compat_global("_supabase_rest_request_json")(
            resource="projects",
            query={"select": "project_sequence", "id": f"eq.{project_id}", "limit": "1"},
        )
        if isinstance(rows, Sequence) and rows and isinstance(rows[0], Mapping):
            value = _safe_string(rows[0].get("project_sequence"))
            if value:
                return value
    except Exception as exc:
        if "project_sequence" not in str(exc):
            raise
    return _compat_global("_fetch_project_main_sheet_title")(project_id=project_id)


def _fetch_current_formula_snapshot_row(
    *,
    project_id: str,
    spreadsheet_id: str,
    sync_run_id: str | None = None,
) -> Mapping[str, Any] | None:
    query = {
        "select": "*",
        "project_id": f"eq.{project_id}",
        "spreadsheet_id": f"eq.{spreadsheet_id}",
        "order": "captured_at.desc",
        "limit": "1",
    }
    if sync_run_id:
        query["sync_run_id"] = f"eq.{sync_run_id}"
    rows = _supabase_rest_request_json(resource="audit_snapshots", query=query)
    if isinstance(rows, Sequence) and rows and isinstance(rows[0], Mapping):
        return rows[0]
    return None


def _extract_template_mapping_fields(templates: Sequence[Mapping[str, Any]]) -> Dict[str, List[str]]:
    required: Dict[str, set[str]] = {}
    for item in templates:
        template = str(item.get("formula_template") or item.get("formula") or "")
        for sheet, field in re.findall(r"\$\{([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)(?::(?:col|range))?\}", template):
            required.setdefault(sheet, set()).add(field)
    return {sheet: sorted(fields) for sheet, fields in required.items()}


def _render_formula_plan_templates(
    templates: Sequence[Mapping[str, Any]],
    mappings: Mapping[str, Any],
    sheet_title: str,
) -> List[Dict[str, str]]:
    resolver = FormulaTemplateResolver()
    rendered: List[Dict[str, str]] = []
    for item in templates:
        cell = _safe_string(item.get("cell"))
        if not cell:
            continue
        sheet = _safe_string(item.get("sheet")) or sheet_title or SHEET_109_NAME
        col_match = re.match(r"([A-Z]+)", cell.upper())
        context = {"self_col": col_match.group(1) if col_match else "", "self_row": re.sub(r"[^0-9]", "", cell)}
        template = _safe_string(item.get("formula_template") or item.get("formula"))
        formula = resolver.resolve_formula(template, mappings, context=context) if template else ""
        rendered.append(
            {
                "sheet": sheet,
                "cell": cell,
                "range": f"{_quote_sheet_name(sheet)}!{cell}",
                "formula": formula,
                "logic": _safe_string(item.get("logic")),
                "formula_template": template,
            }
        )
    return rendered


def load_current_snapshot_formula_plan(
    *,
    project_id: str,
    spreadsheet_id: str,
    sheet_109_title: str | None = None,
    service: Any = None,
    sync_run_id: str | None = None,
) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    del service
    snapshot = _compat_global("_fetch_current_formula_snapshot_row")(
        project_id=project_id,
        spreadsheet_id=spreadsheet_id,
        sync_run_id=sync_run_id,
    )
    if not snapshot:
        raise RuntimeError("CURRENT_SNAPSHOT_NOT_FOUND")
    if _safe_string(snapshot.get("sync_run_status") or snapshot.get("status")) not in {"succeeded", "success", "completed"}:
        raise RuntimeError("CURRENT_SNAPSHOT_NOT_SUCCEEDED")
    data_json = snapshot.get("data_json") if isinstance(snapshot.get("data_json"), Mapping) else {}
    templates = list(data_json.get("formula_plan_templates") or [])
    required_fields = _extract_template_mapping_fields(templates)
    manifest = data_json.get("formula_mapping_manifest") if isinstance(data_json.get("formula_mapping_manifest"), Mapping) else {}
    mappings = manifest.get("mappings") if isinstance(manifest.get("mappings"), Mapping) else {}
    if required_fields and not mappings:
        raise RuntimeError("CURRENT_SNAPSHOT_MAPPING_MANIFEST_MISSING")
    resolved_sheet = _safe_string(sheet_109_title) or _compat_global("_fetch_project_main_sheet_title")(project_id=project_id) or SHEET_109_NAME
    plan = _render_formula_plan_templates(templates, mappings, resolved_sheet)
    return plan, {
        "source": "current_snapshot",
        "snapshot_id": _safe_string(snapshot.get("id")),
        "sync_run_id": _safe_string(snapshot.get("sync_run_id")),
        "formula_mapping_project_id": project_id,
        "sheet": resolved_sheet,
        "required_mapping_fields": required_fields,
        "formula_mapping_source": _safe_string(manifest.get("source")) or "snapshot_frozen",
    }


def _resolve_writeback_formula_mappings(
    *,
    project_id: str | None = None,
    snapshot_meta: Mapping[str, Any] | None = None,
) -> Mapping[str, Any]:
    del snapshot_meta
    return MappingService.get_project_mappings(project_id)


def _get_sheet_metadata(service, spreadsheet_id: str, sheet_name: str) -> Dict[str, Any]:
    metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id, includeGridData=False).execute()
    for sheet in metadata.get("sheets", []):
        props = sheet.get("properties", {})
        if props.get("title") == sheet_name:
            return {
                "sheet_id": int(props.get("sheetId", 0)),
                "row_count": int((props.get("gridProperties") or {}).get("rowCount", 0)),
                "column_count": int((props.get("gridProperties") or {}).get("columnCount", 0)),
                "protected_ranges": list(sheet.get("protectedRanges", []) or []),
            }
    raise KeyError(sheet_name)


def _get_109_sheet_metadata(service, spreadsheet_id: str, sheet_109_title: str = SHEET_109_NAME) -> Dict[str, Any]:
    return _get_sheet_metadata(service, spreadsheet_id, sheet_109_title)


def _validate_formula_row_fingerprints(service, spreadsheet_id: str, plan: Sequence[Mapping[str, Any]]) -> None:
    ranges: List[str] = []
    expected_by_range: Dict[str, Sequence[Any]] = {}
    for item in plan:
        fingerprint = item.get("row_fingerprint")
        if not isinstance(fingerprint, Mapping):
            continue
        cell_range = _safe_string(item.get("range"))
        if not cell_range:
            sheet = _safe_string(item.get("sheet")) or SHEET_109_NAME
            cell_range = f"{_quote_sheet_name(sheet)}!{_safe_string(item.get('cell'))}"
        sheet, ref = cell_range.split("!", 1)
        match = re.fullmatch(r"([A-Z]+)(\d+)(?::[A-Z]+\d+)?", ref)
        if not match:
            continue
        row = match.group(2)
        label_range = f"{sheet}!C{row}:D{row}"
        ranges.append(label_range)
        expected_by_range[_normalize_formula_range(label_range)] = list(fingerprint.get("label_cells") or [])
    if not ranges:
        return
    response = service.spreadsheets().values().batchGet(spreadsheetId=spreadsheet_id, ranges=ranges).execute()
    for value_range in response.get("valueRanges", []):
        normalized_range = _normalize_formula_range(value_range.get("range", ""))
        actual = (value_range.get("values") or [[]])[0]
        expected = list(expected_by_range.get(normalized_range, []))
        if list(actual[: len(expected)]) != expected:
            raise SnapshotStaleError(f"SNAPSHOT_STALE_ERROR: FORMULA_ROW_DRIFT {ranges[0].split('!')[0].strip(chr(39))}!{plan[0].get('cell')}")


def validate_snapshot_writeback_consistency(
    *,
    service,
    spreadsheet_id: str,
    project_id: str,
    snapshot_meta: Mapping[str, Any],
    plan: Sequence[Mapping[str, Any]],
) -> Dict[str, Any]:
    metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id, includeGridData=False).execute()
    existing_sheets = {
        str((sheet.get("properties") or {}).get("title"))
        for sheet in metadata.get("sheets", [])
    }
    required_fields = snapshot_meta.get("required_mapping_fields") if isinstance(snapshot_meta.get("required_mapping_fields"), Mapping) else {}
    missing = [sheet for sheet in required_fields if sheet not in existing_sheets]
    if missing:
        raise SnapshotStaleError(f"SNAPSHOT_STALE_ERROR: MISSING_SHEETS {', '.join(missing)}")

    mappings = _compat_global("_resolve_writeback_formula_mappings")(project_id=project_id, snapshot_meta=snapshot_meta)
    discovery_rows = _compat_global("_supabase_rest_request_json")(
        resource="sheet_discovery_snapshots",
        query={"sync_run_id": f"eq.{_safe_string(snapshot_meta.get('sync_run_id'))}"},
    )
    ranges = []
    expected_headers: Dict[str, Sequence[Any]] = {}
    if isinstance(discovery_rows, Sequence):
        for row in discovery_rows:
            if not isinstance(row, Mapping):
                continue
            sheet_name = _safe_string(row.get("sheet_name"))
            if sheet_name not in required_fields:
                continue
            ranges.append(f"{_quote_sheet_name(sheet_name)}!A1:ZZ1")
            expected_headers[sheet_name] = list(row.get("header_cells_json") or [])
    if ranges:
        response = service.spreadsheets().values().batchGet(spreadsheetId=spreadsheet_id, ranges=ranges).execute()
        for value_range in response.get("valueRanges", []):
            sheet_name = str(value_range.get("range", "")).split("!", 1)[0].strip("'")
            actual = (value_range.get("values") or [[]])[0]
            expected = list(expected_headers.get(sheet_name, []))
            if expected and list(actual[: len(expected)]) != expected:
                raise SnapshotStaleError(f"SNAPSHOT_STALE_ERROR: HEADER_DRIFT {sheet_name}")
    _validate_formula_row_fingerprints(service, spreadsheet_id, plan)
    return {"status": "ok", "checked": True}


def build_dashboard_summary_payload(
    *,
    spreadsheet_id: str,
    project_id: str,
    reclassify_summary: Mapping[str, Any],
    mapping_metrics: Mapping[str, Any] | None = None,
) -> Dict[str, Any]:
    mapping_metrics = dict(mapping_metrics or {})
    payable_count = int(reclassify_summary.get("payable_rows_written", 0) or 0)
    final_detail_count = int(reclassify_summary.get("final_detail_rows_written", 0) or 0)
    draw_request_count = int(reclassify_summary.get("draw_request_rows_written", 0) or 0)
    total_reclass_rows = payable_count + final_detail_count + draw_request_count
    return {
        "project_name": f"Project {(spreadsheet_id or '')[:8]}",
        "project_id": project_id,
        "workflow_stage": "manual_input_ready",
        "highlights": [
            {"label": "重分类行数", "value": str(total_reclass_rows), "color": "green" if total_reclass_rows else "slate"},
            {"label": "Payable", "value": str(payable_count), "color": "slate"},
            {"label": "Final Detail", "value": str(final_detail_count), "color": "slate"},
            {"label": "Draw Request", "value": str(draw_request_count), "color": "slate"},
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
                    "payable_count": payable_count,
                    "final_detail_count": final_detail_count,
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


def build_budgetco_semantic_summary_context(
    budgetco_values: Sequence[Sequence[Any]],
    start_col: str = "G",
) -> Dict[str, Any]:
    mapper = MapperFactory.create("BudgetCO", budgetco_values)
    generator = FinanceFormulaGenerator(mapper, config=mapper.config)

    row_savings = mapper.get_row("Total Savings Identified")
    row_contingency = mapper.get_row("Owner Contingency")
    row_total_eac = mapper.get_row("Total Budget (EAC)")

    return {
        "mapper": mapper,
        "row_savings": row_savings,
        "row_contingency": row_contingency,
        "row_total_eac": row_total_eac,
        "savings_ref": mapper.get_ref("Total Savings Identified", start_col),
        "contingency_ref": mapper.get_ref("Owner Contingency", start_col),
        "total_eac_ref": mapper.get_ref("Total Budget (EAC)", start_col),
        "eac_formula": generator.generate_generic_formula("eac_summary", start_col),
    }


def build_project_ledger_semantic_context(
    ledger_values: Sequence[Sequence[Any]],
    values_109: Sequence[Sequence[Any]],
    ledger_col: str = "H",
    cost_col_109: str = "F",
) -> Dict[str, Any]:
    ledger_mapper = MapperFactory.create("Project Ledger", ledger_values)
    mapper_109 = MapperFactory.create("109", values_109)

    total_actuals_label = "Total Actual Expenditure"
    accrual_adj_label = "Accrual Adjustments"
    cumulative_cost_label = "Cumulative Total Cost (Actual)"

    row_total_actuals = ledger_mapper.get_row(total_actuals_label)
    row_accrual_adj = ledger_mapper.get_row(accrual_adj_label)
    row_109_cumulative_cost = mapper_109.get_row(cumulative_cost_label)

    total_actuals_ref = ledger_mapper.get_ref(total_actuals_label, ledger_col)
    accrual_adj_ref = ledger_mapper.get_ref(accrual_adj_label, ledger_col)
    cumulative_cost_109_ref = mapper_109.get_ref(cumulative_cost_label, cost_col_109)
    ledger_total_formula = f"=N({total_actuals_ref}) + N({accrual_adj_ref})"

    return {
        "ledger_mapper": ledger_mapper,
        "mapper_109": mapper_109,
        "row_total_actuals": row_total_actuals,
        "row_accrual_adj": row_accrual_adj,
        "row_109_cumulative_cost": row_109_cumulative_cost,
        "total_actuals_ref": total_actuals_ref,
        "accrual_adj_ref": accrual_adj_ref,
        "cumulative_cost_109_ref": cumulative_cost_109_ref,
        "ledger_total_formula": ledger_total_formula,
        "shadow_reconcile_formula": f"{ledger_total_formula} = N({cumulative_cost_109_ref})",
    }


def update_109_semantic_logic(
    rows: List[List[Any]],
    sheet_109_title: str = SHEET_109_NAME,
    formula_mappings: Mapping[str, Any] | None = None,
) -> List[Dict[str, str]]:
    mapper = MapperFactory.create("109", rows)
    config: Dict[str, Any] = _build_109_year_axis_config(rows)
    if formula_mappings:
        config["formula_mappings"] = formula_mappings
    generator = FinanceFormulaGenerator(mapper, config=config)

    semantic_updates: List[Dict[str, str]] = []

    def add_update(row_num: int, col: str, formula: str, logic: str) -> None:
        semantic_updates.append(
            {
                "sheet": sheet_109_title,
                "cell": f"{col}{row_num}",
                "range": f"{_quote_sheet_name(sheet_109_title)}!{col}{row_num}",
                "formula": formula,
                "logic": logic,
            }
        )

    def maybe_add_formula_update(label: str, col: str, formula_builder, logic: str) -> None:
        try:
            row_num = mapper.get_row(label)
            formula = formula_builder(col)
        except KeyError:
            return
        add_update(row_num, col, formula, logic)

    year_row = _find_year_header_row_109(rows) or 10
    columns = list(config.get("primary_year_cols") or list("FGHIJK")) + list(config.get("audit_year_cols") or list("MNOPQR"))
    labels = mapper.config.get("labels", {})
    for col in columns:
        year_ref = f"{col}${year_row}"
        maybe_add_formula_update(labels.get("eac", "Dynamic Budget (EAC)"), col, generator.get_eac_formula, "Semantic EAC formula")
        maybe_add_formula_update("Cumulative Direct Cost", col, generator.get_cumulative_direct_cost_formula, "Semantic Cumulative Direct Cost formula")
        maybe_add_formula_update("Cost of Goods Sold-Company", col, generator.get_cogs_company_formula, "Semantic COGS Company formula")
        maybe_add_formula_update(labels.get("poc", "Percentage of Completion"), col, generator.get_poc_formula, "Semantic POC formula")
        maybe_add_formula_update(labels.get("confirmed_cogs", "Cost of Goods Sold"), col, generator.get_confirmed_cogs_formula, "Semantic COGS formula")
        maybe_add_formula_update(labels.get("revenue", "General Conditions fee"), col, generator.get_revenue_formula, "Semantic Revenue formula")
        maybe_add_formula_update("Gross Profit", col, generator.get_gross_profit_formula, "Semantic Gross Profit formula")
        try:
            add_update(mapper.get_row("Total Income Cost"), col, generator.get_income_total_formula(col, year_ref), "Semantic Total Income Cost formula")
        except KeyError:
            pass
        try:
            add_update(mapper.get_row("GC Income"), col, generator.get_gc_income_formula(col, year_ref), "Semantic GC Income formula")
        except KeyError:
            pass
        try:
            add_update(
                mapper.get_row("Actual Warranty Expenses (Reversed)"),
                col,
                generator.get_actual_warranty_formula(col, year_ref),
                "Semantic Actual Warranty Expenses formula",
            )
        except KeyError:
            pass
        maybe_add_formula_update("ROE (Current Period)", col, generator.get_roe_formula, "Semantic ROE formula")
        maybe_add_formula_update("Retention", col, generator.get_retention_formula, "Semantic Retention formula")
        maybe_add_formula_update("Net Profit (Post-Tax)", col, generator.get_net_profit_formula, "Semantic Net Profit formula")

    return semantic_updates


def _find_material_margin_rows_109(
    label_rows: Dict[str, List[int]],
    row_wbh_cogs: int | None,
    row_wbh_inv: int | None,
) -> Tuple[int | None, int | None]:
    mm_rows = sorted(label_rows.get("material margin", []))
    if not mm_rows:
        return None, None

    main_row: int | None = None
    inv_row: int | None = None

    if row_wbh_cogs is not None:
        for r in mm_rows:
            if r > row_wbh_cogs:
                main_row = r
                break

    if row_wbh_inv is not None:
        for r in mm_rows:
            if r > row_wbh_inv:
                inv_row = r
                break

    if main_row is None:
        main_row = mm_rows[0]
    if inv_row is None:
        inv_row = mm_rows[-1] if len(mm_rows) > 1 else mm_rows[0]

    return main_row, inv_row


def _load_109_formula_dictionary(path: Path | None = None) -> Dict[str, Any]:
    dictionary_path = path or FORMULA_DICTIONARY_109_FILE
    with dictionary_path.open("r", encoding="utf-8") as fh:
        payload = yaml.safe_load(fh) or {}
    if not isinstance(payload, dict):
        raise RuntimeError("109公式字典格式无效。")
    return payload


def _year_columns_from_109_dictionary(config: Mapping[str, Any]) -> List[int]:
    period_axis = dict(config.get("period_axis", {}))
    years = [int(x) for x in period_axis.get("years", [2021, 2022, 2023, 2024, 2025, 2026])]
    return list(range(6, 6 + len(years)))


def _build_109_manual_input_ranges(
    rows: Sequence[Sequence[Any]],
    years: Sequence[int],
    sheet_109_title: str = SHEET_109_NAME,
) -> List[str]:
    if not rows:
        return []

    label_rows = _find_rows_by_item_label(rows, item_col_1=3)
    sheet = _quote_sheet_name(sheet_109_title)
    start_col = _column_number_to_a1(6)
    end_col = _column_number_to_a1(5 + len(years))
    audit_start_col = _column_number_to_a1(13)
    audit_end_col = _column_number_to_a1(12 + len(years))
    ranges: List[str] = []

    def add_row_range(label: str, audit: bool = False) -> None:
        row_list = label_rows.get(label, [])
        if not row_list:
            return
        row_i = row_list[0]
        if audit:
            ranges.append(f"{sheet}!{audit_start_col}{row_i}:{audit_end_col}{row_i}")
        else:
            ranges.append(f"{sheet}!{start_col}{row_i}:{end_col}{row_i}")

    ranges.append(f"{sheet}!C2:E2")
    ranges.append(f"{sheet}!G2:I2")
    add_row_range("general conditions fee-audited")
    add_row_range("general conditions fee-audited", audit=True)
    add_row_range("owner-unapproved overrun")
    add_row_range("cost of goods sold-audited")
    add_row_range("cost of goods sold-audited", audit=True)
    add_row_range("accrued warranty expenses")
    add_row_range("wb home income")
    add_row_range("wb home cogs")
    add_row_range("wb home inventory income")
    add_row_range("wb home inventory")
    return ranges


def _build_109_units_count_formula() -> str:
    return '=IFERROR(COUNTA(FILTER(\'Unit Master\'!$A$3:$A,REGEXMATCH(\'Unit Master\'!$A$3:$A,"[0-9]"))),0)'


def _matrix_cell(row: Sequence[Any], col_1: int) -> Any:
    return row[col_1 - 1] if 0 < col_1 <= len(row) else ""


def _find_col_in_matrix_row(row: Sequence[Any], *candidates: str) -> int | None:
    wanted = {_normalize_header_token(item) for item in candidates}
    for idx, value in enumerate(row, start=1):
        if _normalize_header_token(value) in wanted:
            return idx
    return None


def _find_header_row_with_columns(rows: Sequence[Sequence[Any]], *candidates: str) -> int | None:
    for row_idx, row in enumerate(rows):
        if all(_find_col_in_matrix_row(row, candidate) is not None for candidate in candidates):
            return row_idx
    return None


def _format_mdy_no_leading_zero(value: Any) -> str:
    dt = _normalize_date_value(value)
    if dt is None:
        return ""
    return f"{dt.month}/{dt.day}/{dt.year}"


def _build_scoping_manual_input_ranges(rows: Sequence[Sequence[Any]]) -> List[str]:
    header_idx = _find_header_row_with_columns(rows, "Group Number")
    if header_idx is None:
        return []

    header = rows[header_idx]
    group_col = _find_col_in_matrix_row(header, "Group Number") or 3
    entity_col = _find_col_in_matrix_row(header, "Welltower", "Entity") or 2
    status_start_col = _find_col_in_matrix_row(header, "GMP") or 5
    status_end_col = (
        _find_col_in_matrix_row(header, "Warranty Months", "保修月数")
        or _find_col_in_matrix_row(header, "Warranty Month")
        or 11
    )
    if status_end_col < status_start_col:
        status_start_col, status_end_col = status_end_col, status_start_col

    sheet = _quote_sheet_name("Scoping")
    entity_col_a1 = _column_number_to_a1(entity_col)
    status_start_a1 = _column_number_to_a1(status_start_col)
    status_end_a1 = _column_number_to_a1(status_end_col)
    ranges: List[str] = []
    for row_idx in range(header_idx + 1, len(rows)):
        if not _safe_string(_matrix_cell(rows[row_idx], group_col)):
            continue
        row_1 = row_idx + 1
        ranges.append(f"{sheet}!{entity_col_a1}{row_1}")
        ranges.append(f"{sheet}!{status_start_a1}{row_1}:{status_end_a1}{row_1}")
    return ranges


def _build_scoping_hidden_row_numbers(rows: Sequence[Sequence[Any]]) -> List[int]:
    header_idx = _find_header_row_with_columns(rows, "Group Number")
    if header_idx is None:
        return []

    header = rows[header_idx]
    group_col = _find_col_in_matrix_row(header, "Group Number") or 3
    budget_col = _find_col_in_matrix_row(header, "Budget")
    incurred_col = _find_col_in_matrix_row(header, "Incurred amount", "Incurred Amount")

    hidden: List[int] = []
    for row_idx in range(header_idx + 1, len(rows)):
        row = rows[row_idx]
        if _safe_string(_matrix_cell(row, group_col)):
            continue
        budget = _to_float(_matrix_cell(row, budget_col)) if budget_col is not None else None
        incurred = _to_float(_matrix_cell(row, incurred_col)) if incurred_col is not None else None
        if budget is None and incurred is None:
            hidden.append(row_idx + 1)
    return hidden


def _group_co_date_map(rows: Sequence[Sequence[Any]]) -> Dict[str, pd.Timestamp]:
    header_idx = _find_header_row_with_columns(rows, "Group", "C/O date")
    if header_idx is None:
        return {}

    header = rows[header_idx]
    group_col = _find_col_in_matrix_row(header, "Group")
    co_date_col = _find_col_in_matrix_row(header, "C/O date")
    if group_col is None or co_date_col is None:
        return {}

    out: Dict[str, pd.Timestamp] = {}
    for row in rows[header_idx + 1:]:
        group = _safe_string(_matrix_cell(row, group_col))
        dt = _normalize_date_value(_matrix_cell(row, co_date_col))
        if not group or dt is None:
            continue
        out[group] = dt if group not in out else max(out[group], dt)
    return out


def _build_scoping_warranty_expiry_values(
    scoping_rows: Sequence[Sequence[Any]],
    unit_master_rows: Sequence[Sequence[Any]],
    unit_budget_rows: Sequence[Sequence[Any]] | None = None,
) -> List[List[Any]]:
    values: List[List[Any]] = [[""] for _ in scoping_rows]
    header_idx = _find_header_row_with_columns(scoping_rows, "Group Number")
    if header_idx is None:
        return values

    header = scoping_rows[header_idx]
    group_col = _find_col_in_matrix_row(header, "Group Number") or 3
    warranty_months_col = (
        _find_col_in_matrix_row(header, "Warranty Months", "保修月数")
        or _find_col_in_matrix_row(header, "Warranty Month")
    )
    values[header_idx][0] = "保修到期日"
    if warranty_months_col is None:
        return values

    unit_master_dates = _group_co_date_map(unit_master_rows)
    unit_budget_dates = _group_co_date_map(unit_budget_rows or [])
    for row_idx in range(header_idx + 1, len(scoping_rows)):
        row = scoping_rows[row_idx]
        group = _safe_string(_matrix_cell(row, group_col))
        months = _to_float(_matrix_cell(row, warranty_months_col))
        if not group or months is None:
            continue
        co_date = unit_master_dates.get(group) or unit_budget_dates.get(group)
        if co_date is None:
            continue
        expiry = co_date + pd.Timedelta(days=months * 30.25)
        values[row_idx][0] = _format_mdy_no_leading_zero(expiry)
    return values


def _build_unit_master_manual_input_ranges(row_count: int) -> List[str]:
    end_row = max(int(row_count), 3)
    sheet = _quote_sheet_name(SHEET_UNIT_MASTER_NAME)
    return [
        f"{sheet}!H3:H{end_row}",
        f"{sheet}!K3:K{end_row}",
    ]


def _build_external_sheet_edit_specs() -> Dict[str, Dict[str, List[str]]]:
    return {
        "Contract": {"editable_ranges": ["'Contract'!A:ZZ"], "clear_ranges": ["'Contract'!A:ZZ"]},
        "Unit Budget": {
            "editable_ranges": ["'Unit Budget'!S:ZZ"],
            "filter_header_ranges": ["'Unit Budget'!A1:ZZ1"],
            "clear_ranges": ["'Unit Budget'!S:ZZ"],
        },
        "Payable": {
            "editable_ranges": ["'Payable'!L:AZ"],
            "filter_header_ranges": ["'Payable'!A1:ZZ1"],
            "clear_ranges": ["'Payable'!A2:ZZ"],
        },
        "Final Detail": {
            "editable_ranges": ["'Final Detail'!N:AL"],
            "filter_header_ranges": ["'Final Detail'!A1:ZZ1"],
            "clear_ranges": ["'Final Detail'!A2:ZZ"],
        },
        "Draw request report": {
            "editable_ranges": ["'Draw request report'!H:AR"],
            "filter_header_ranges": ["'Draw request report'!A1:ZZ2"],
            "clear_ranges": ["'Draw request report'!A3:ZZ"],
        },
        "Draw Invoice List": {
            "editable_ranges": ["'Draw Invoice List'!G:AE"],
            "filter_header_ranges": ["'Draw Invoice List'!A4:ZZ4"],
            "clear_ranges": ["'Draw Invoice List'!A5:ZZ"],
        },
        "Transfer Log": {
            "editable_ranges": ["'Transfer Log'!G:Z"],
            "filter_header_ranges": ["'Transfer Log'!A4:ZZ4"],
            "clear_ranges": ["'Transfer Log'!A5:ZZ"],
        },
        "Change Order Log": {
            "editable_ranges": ["'Change Order Log'!G:AE"],
            "filter_header_ranges": ["'Change Order Log'!A4:ZZ4"],
            "clear_ranges": ["'Change Order Log'!A5:ZZ"],
        },
    }


def _build_external_sheet_clear_ranges() -> List[str]:
    return [
        range_ref
        for spec in _build_external_sheet_edit_specs().values()
        for range_ref in spec["clear_ranges"]
    ]


def _build_update_hidden_sheet_request(sheet_id: int, hidden: bool) -> Dict[str, Any]:
    return {
        "updateSheetProperties": {
            "properties": {"sheetId": int(sheet_id), "hidden": bool(hidden)},
            "fields": "hidden",
        }
    }


def _iso_now_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _build_project_state_values(
    *,
    owner_email: str,
    current_stage: str,
    locked: bool,
) -> List[List[str]]:
    return [
        ["key", "value"],
        ["current_stage", current_stage],
        ["external_data_dirty", "FALSE"],
        ["manual_input_dirty", "FALSE"],
        ["locked", "TRUE" if locked else "FALSE"],
        ["owner_email", owner_email],
        ["last_external_edit_at", ""],
        ["last_external_edit_by", ""],
        ["last_manual_edit_at", ""],
        ["last_manual_edit_by", ""],
        ["last_sync_at", ""],
        ["last_validate_input_at", ""],
        ["last_reclassify_at", ""],
        ["last_109_initial_approval_at", ""],
        ["locked_at", ""],
        ["locked_by", ""],
        ["unlocked_at", ""],
        ["unlocked_by", ""],
    ]


def append_project_audit_log(
    *,
    service,
    spreadsheet_id: str,
    actor_email: str,
    action: str,
    previous_stage: str,
    next_stage: str,
    status: str,
    message: str,
) -> None:
    service.spreadsheets().values().append(
        spreadsheetId=spreadsheet_id,
        range="'AiWB_Audit_Log'!A:I",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [[_iso_now_utc(), actor_email, action, previous_stage, spreadsheet_id, "", next_stage, status, message]]},
    ).execute()


def _build_project_bootstrap_manual_clear_ranges(
    *,
    rows_109: Sequence[Sequence[Any]],
    rows_scoping: Sequence[Sequence[Any]],
    row_count_unit_master: int,
    sheet_109_title: str = SHEET_109_NAME,
) -> List[str]:
    ranges: List[str] = []
    ranges.extend(_build_109_manual_input_ranges(rows_109, [2021, 2022, 2023, 2024, 2025, 2026], sheet_109_title=sheet_109_title))

    scoping_ranges = _build_scoping_manual_input_ranges(rows_scoping)
    if not scoping_ranges:
        group_rows = [
            idx + 1
            for idx, row in enumerate(rows_scoping)
            if _safe_string(row[2] if len(row) > 2 else "")
        ]
        if group_rows:
            first_row, last_row = min(group_rows), max(group_rows)
            scoping_ranges = [
                f"'Scoping'!B{first_row}:B{last_row}",
                f"'Scoping'!E{first_row}:K{last_row}",
            ]
    ranges.extend(scoping_ranges)
    unit_master_sheet = _quote_sheet_name(SHEET_UNIT_MASTER_NAME)
    end_row = max(int(row_count_unit_master), 3)
    ranges.append(f"{unit_master_sheet}!B1:M1")
    ranges.append(f"{unit_master_sheet}!A3:M{end_row}")
    ranges.extend(_build_unit_master_manual_input_ranges(end_row))
    ranges.extend(_build_external_sheet_clear_ranges())
    return ranges


def _hide_system_log_sheet(service, spreadsheet_id: str) -> bool:
    try:
        metadata = _get_sheet_metadata(service, spreadsheet_id, SHEET_109_LOG_NAME)
    except KeyError:
        return False
    request = _build_update_hidden_sheet_request(int(metadata["sheet_id"]), True)
    service.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": [request]}).execute()
    return True


def _apply_external_sheet_controls(service, spreadsheet_id: str) -> Dict[str, Any]:
    requests = _build_external_sheet_protection_requests(service, spreadsheet_id)
    if requests:
        service.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": requests}).execute()
    return {
        "external_protection_request_count": len(requests),
        "log_hidden": _hide_system_log_sheet(service, spreadsheet_id),
    }


def _a1_to_grid_range_flexible(a1: str, sheet_id: int, column_count: int | None = None) -> Dict[str, int]:
    normalized = _normalize_formula_range(a1)
    ref = normalized.split("!", 1)[1] if "!" in normalized else normalized
    col_only = re.fullmatch(r"([A-Z]+):([A-Z]+)", ref)
    if col_only:
        return {
            "sheetId": int(sheet_id),
            "startColumnIndex": _column_a1_to_number(col_only.group(1)) - 1,
            "endColumnIndex": _column_a1_to_number(col_only.group(2)),
        }
    grid = _a1_to_grid_range(normalized, sheet_id)
    if column_count and grid.get("endColumnIndex", 0) > column_count:
        grid["endColumnIndex"] = int(column_count)
    return grid


def _build_external_sheet_protection_requests(service, spreadsheet_id: str) -> List[Dict[str, Any]]:
    metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id, includeGridData=False).execute()
    specs = _build_external_sheet_edit_specs()
    requests: List[Dict[str, Any]] = []
    for sheet in metadata.get("sheets", []):
        props = sheet.get("properties", {})
        title = _safe_string(props.get("title"))
        if title not in specs:
            continue
        sheet_id = int(props.get("sheetId", 0))
        column_count = int((props.get("gridProperties") or {}).get("columnCount", 0) or 0)
        for protected_range in sheet.get("protectedRanges", []) or []:
            description = _safe_string(protected_range.get("description"))
            if description.startswith(f"{MANAGED_EXTERNAL_PROTECTION_PREFIX}:"):
                protected_range_id = protected_range.get("protectedRangeId")
                if protected_range_id is not None:
                    requests.append(_build_delete_protected_range_request(int(protected_range_id)))
        if title == "Contract":
            continue
        unprotected_ranges = []
        max_required_columns = column_count
        for range_ref in specs[title].get("editable_ranges", []):
            grid = _a1_to_grid_range_flexible(range_ref, sheet_id)
            max_required_columns = max(max_required_columns, int(grid.get("endColumnIndex", 0)))
            unprotected_ranges.append(grid)
        for range_ref in specs[title].get("filter_header_ranges", []):
            unprotected_ranges.append(_a1_to_grid_range_flexible(range_ref, sheet_id, column_count=column_count))
        if max_required_columns > column_count:
            requests.append(
                {
                    "updateSheetProperties": {
                        "properties": {"sheetId": sheet_id, "gridProperties": {"columnCount": max_required_columns}},
                        "fields": "gridProperties.columnCount",
                    }
                }
            )
        protected_range = {
            "range": {"sheetId": sheet_id},
            "description": f"{MANAGED_EXTERNAL_PROTECTION_PREFIX}: {title}",
            "warningOnly": True,
            "unprotectedRanges": unprotected_ranges,
        }
        requests.append({"addProtectedRange": {"protectedRange": protected_range}})
    return requests


def _build_project_data_lock_requests(
    service,
    spreadsheet_id: str,
    *,
    locked: bool,
    sheet_109_title: str = SHEET_109_NAME,
) -> List[Dict[str, Any]]:
    lock_sheets = {"Payable", "Final Detail", "Draw request report", "Unit Budget", "Unit Master", "Scoping", sheet_109_title}
    metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id, includeGridData=False).execute()
    requests: List[Dict[str, Any]] = []
    for sheet in metadata.get("sheets", []):
        props = sheet.get("properties", {})
        title = _safe_string(props.get("title"))
        if title not in lock_sheets:
            continue
        description = f"{MANAGED_DATA_LOCK_PREFIX}: {title}"
        for protected_range in sheet.get("protectedRanges", []) or []:
            if _safe_string(protected_range.get("description")) == description:
                protected_range_id = protected_range.get("protectedRangeId")
                if protected_range_id is not None:
                    requests.append(_build_delete_protected_range_request(int(protected_range_id)))
        if locked:
            requests.append(
                {
                    "addProtectedRange": {
                        "protectedRange": {
                            "range": {"sheetId": int(props.get("sheetId", 0))},
                            "description": description,
                            "warningOnly": True,
                        }
                    }
                }
            )
    return requests


def _cleanup_109_legacy_duplicate_contract_change_row(service, spreadsheet_id: str, sheet_109_title: str = SHEET_109_NAME) -> Dict[str, Any]:
    del service, spreadsheet_id, sheet_109_title
    return {"cleared": False}


def _apply_109_layout_controls(
    service,
    spreadsheet_id: str,
    rows: Sequence[Sequence[Any]] | None = None,
    years: Sequence[int] | None = None,
    sheet_109_title: str = SHEET_109_NAME,
) -> Dict[str, Any]:
    del rows, years
    try:
        return _get_109_sheet_metadata(service, spreadsheet_id, sheet_109_title)
    except KeyError:
        return {}


def _write_project_state_and_log(
    service,
    spreadsheet_id: str,
    *,
    creator_email: str,
    project_name: str,
    project_owner: str,
) -> Dict[str, bool]:
    del project_owner
    state_values = _build_project_state_values(
        owner_email=creator_email,
        current_stage=WORKBENCH_STAGE_PROJECT_CREATED,
        locked=False,
    )
    values = service.spreadsheets().values()
    values.update(
        spreadsheetId=spreadsheet_id,
        range="'AiWB_Project_State'!A:B",
        valueInputOption="USER_ENTERED",
        body={"values": state_values},
    ).execute()
    append_project_audit_log(
        service=service,
        spreadsheet_id=spreadsheet_id,
        actor_email=creator_email,
        action="create_project",
        previous_stage="",
        next_stage=WORKBENCH_STAGE_PROJECT_CREATED,
        status="success",
        message=project_name,
    )
    return {"project_state_initialized": True, "audit_log_initialized": True}


def initialize_project_workbook(
    *,
    service,
    spreadsheet_id: str,
    project_name: str = "",
    project_owner: str = "",
    creator_email: str = "",
    sheet_109_title: str = SHEET_109_NAME,
) -> Dict[str, Any]:
    metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id, includeGridData=False).execute()
    sheet_titles = {
        _safe_string((sheet.get("properties") or {}).get("title")): sheet
        for sheet in metadata.get("sheets", [])
    }
    resolved_sheet_109_title = _safe_string(sheet_109_title) or SHEET_109_NAME
    sheet_109_renamed = False
    if resolved_sheet_109_title != SHEET_109_NAME and resolved_sheet_109_title not in sheet_titles and SHEET_109_NAME in sheet_titles:
        sheet_id = int((sheet_titles[SHEET_109_NAME].get("properties") or {}).get("sheetId", 0))
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {
                        "updateSheetProperties": {
                            "properties": {"sheetId": sheet_id, "title": resolved_sheet_109_title},
                            "fields": "title",
                        }
                    }
                ]
            },
        ).execute()
        sheet_109_renamed = True

    values = service.spreadsheets().values()
    rows_109 = values.get(spreadsheetId=spreadsheet_id, range=f"{_quote_sheet_name(resolved_sheet_109_title)}!A:ZZ").execute().get("values", [])
    rows_scoping = values.get(spreadsheetId=spreadsheet_id, range="'Scoping'!A:Z").execute().get("values", [])
    try:
        row_count_unit_master = int((_compat_global("_get_sheet_metadata")(service, spreadsheet_id, SHEET_UNIT_MASTER_NAME).get("row_count") or 12))
    except KeyError:
        row_count_unit_master = 12
    clear_ranges = _build_project_bootstrap_manual_clear_ranges(
        rows_109=rows_109,
        rows_scoping=rows_scoping,
        row_count_unit_master=row_count_unit_master,
        sheet_109_title=resolved_sheet_109_title,
    )
    values.batchClear(spreadsheetId=spreadsheet_id, body={"ranges": clear_ranges}).execute()
    values.batchUpdate(
        spreadsheetId=spreadsheet_id,
        body={
            "valueInputOption": "USER_ENTERED",
            "data": [
                {"range": f"{_quote_sheet_name(resolved_sheet_109_title)}!C2", "values": [[project_name]]},
                {"range": f"{_quote_sheet_name(resolved_sheet_109_title)}!G2", "values": [[project_owner]]},
            ],
        },
    ).execute()
    state_result = _write_project_state_and_log(
        service,
        spreadsheet_id,
        creator_email=creator_email,
        project_name=project_name,
        project_owner=project_owner,
    )
    scoping_layout = _compat_global("_apply_scoping_layout_controls")(service, spreadsheet_id)
    unit_budget_count = _compat_global("_apply_unit_budget_support_formatting")(service, spreadsheet_id)
    layout_109 = _compat_global("_apply_109_layout_controls")(
        service,
        spreadsheet_id,
        rows=rows_109,
        years=[2021, 2022, 2023, 2024, 2025, 2026],
        sheet_109_title=resolved_sheet_109_title,
    )
    external_controls = _compat_global("_apply_external_sheet_controls")(service, spreadsheet_id)
    return {
        "headers_written": 2,
        "manual_clear_range_count": len(clear_ranges),
        "external_clear_range_count": len(_build_external_sheet_clear_ranges()),
        "external_data_rows_after_sanitize": {
            "Payable": 0,
            "Final Detail": 0,
            "Draw request report": 0,
        },
        "scoping_layout": scoping_layout,
        "unit_budget_layout_request_count": unit_budget_count,
        "109_layout": layout_109,
        **external_controls,
        **state_result,
        "sheet_109_renamed": sheet_109_renamed,
    }


def _build_109_date_array_formula(func_name: str) -> str:
    date_floor = "DATE(2021,1,1)"
    arrays = [
        'IFERROR(FILTER(Payable!$T:$T,Payable!$T:$T<>""),"")',
        'IFERROR(FILTER(Payable!$V:$V,Payable!$V:$V<>""),"")',
        'IFERROR(FILTER(Payable!$AC:$AC,Payable!$AC:$AC<>""),"")',
        'IFERROR(FILTER(\'Final Detail\'!$O:$O,\'Final Detail\'!$O:$O<>""),"")',
        'IFERROR(FILTER(\'Final Detail\'!$S:$S,\'Final Detail\'!$S:$S<>""),"")',
        'IFERROR(FILTER(\'Draw request report\'!$R:$R,\'Draw request report\'!$R:$R<>""),"")',
        'IFERROR(FILTER(\'Draw request report\'!$Z:$Z,\'Draw request report\'!$Z:$Z<>""),"")',
    ]
    merged = ";".join(arrays)
    return f"=MAX({date_floor},{func_name}(TOCOL({{{merged}}},1)))"


def _a1_to_grid_range(a1: str, sheet_id: int) -> Dict[str, int]:
    normalized = _normalize_formula_range(a1)
    if "!" in normalized:
        _, ref = normalized.split("!", 1)
    else:
        ref = normalized
    match = re.fullmatch(r"([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?", ref)
    if not match:
        raise ValueError(f"暂不支持的A1范围: {a1}")

    start_col = _column_a1_to_number(match.group(1)) - 1
    start_row = int(match.group(2)) - 1
    end_col = _column_a1_to_number(match.group(3) or match.group(1))
    end_row = int(match.group(4) or match.group(2))
    return {
        "sheetId": int(sheet_id),
        "startRowIndex": start_row,
        "endRowIndex": end_row,
        "startColumnIndex": start_col,
        "endColumnIndex": end_col,
    }


def _build_delete_protected_range_request(protected_range_id: int) -> Dict[str, Any]:
    return {"deleteProtectedRange": {"protectedRangeId": int(protected_range_id)}}


def _build_add_protected_range_request(
    sheet_id: int,
    unprotected_ranges: Sequence[Mapping[str, Any]],
    editor_email: str | None = None,
) -> Dict[str, Any]:
    protected_range: Dict[str, Any] = {
        "range": {"sheetId": int(sheet_id)},
        "description": MANAGED_109_PROTECTION_DESCRIPTION,
        "warningOnly": False,
        "unprotectedRanges": [dict(item) for item in unprotected_ranges],
    }
    if editor_email:
        protected_range["editors"] = {"users": [str(editor_email)]}
    return {"addProtectedRange": {"protectedRange": protected_range}}


def _format_a1_range(sheet_name: str, start_col_0: int, end_col_0_exclusive: int, row_0: int) -> str:
    start_col = _column_number_to_a1(start_col_0 + 1)
    end_col = _column_number_to_a1(end_col_0_exclusive)
    row = row_0 + 1
    if start_col == end_col:
        return f"{_quote_sheet_name(sheet_name)}!{start_col}{row}"
    return f"{_quote_sheet_name(sheet_name)}!{start_col}{row}:{end_col}{row}"


def _merge_grid_ranges_to_a1(sheet_name: str, ranges: Sequence[Mapping[str, int]]) -> List[str]:
    grouped: Dict[int, List[Tuple[int, int]]] = {}
    for grid in ranges:
        if int(grid.get("endRowIndex", 0)) - int(grid.get("startRowIndex", 0)) != 1:
            continue
        grouped.setdefault(int(grid["startRowIndex"]), []).append(
            (int(grid["startColumnIndex"]), int(grid["endColumnIndex"]))
        )
    out: List[str] = []
    for row_0, spans in sorted(grouped.items()):
        merged: List[Tuple[int, int]] = []
        for start, end in sorted(spans):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end))
            else:
                merged.append((start, end))
        for start, end in merged:
            out.append(_format_a1_range(sheet_name, start, end, row_0))
    return out


def _apply_109_formula_lock_protection(
    *,
    service,
    spreadsheet_id: str,
    plan: Sequence[Mapping[str, str]],
    sheet_109_title: str = SHEET_109_NAME,
) -> Dict[str, Any]:
    metadata = _compat_global("_get_109_sheet_metadata")(service, spreadsheet_id, sheet_109_title)
    sheet_id = int(metadata["sheet_id"])
    formula_ranges = []
    for item in plan:
        range_ref = _safe_string(item.get("range"))
        if not range_ref or not item.get("formula"):
            continue
        range_sheet = range_ref.split("!", 1)[0].strip("'") if "!" in range_ref else _safe_string(item.get("sheet") or sheet_109_title)
        if range_sheet != sheet_109_title:
            continue
        formula_ranges.append(_a1_to_grid_range(range_ref, sheet_id))
    merged_ranges = _merge_grid_ranges_to_a1(sheet_109_title, formula_ranges)
    requests: List[Dict[str, Any]] = []
    for protected_range in metadata.get("protected_ranges", []):
        description = str(protected_range.get("description") or "")
        if description.startswith(f"{MANAGED_109_FORMULA_LOCK_PREFIX}:"):
            protected_range_id = protected_range.get("protectedRangeId")
            if protected_range_id is not None:
                requests.append(_build_delete_protected_range_request(int(protected_range_id)))
    if formula_ranges:
        editor_email = _safe_string(_compat_global("_get_service_account_info")().get("client_email", ""))
        protected_range = dict(formula_ranges[0])
        for grid in formula_ranges[1:]:
            if (
                grid.get("startRowIndex") == protected_range.get("startRowIndex")
                and grid.get("endRowIndex") == protected_range.get("endRowIndex")
                and grid.get("startColumnIndex") == protected_range.get("endColumnIndex")
            ):
                protected_range["endColumnIndex"] = grid["endColumnIndex"]
            else:
                break
        add_request = _build_add_protected_range_request(sheet_id, [], editor_email or None)
        add_request["addProtectedRange"]["protectedRange"]["description"] = f"{MANAGED_109_FORMULA_LOCK_PREFIX}: 1"
        add_request["addProtectedRange"]["protectedRange"]["range"] = protected_range
        requests.append(add_request)
    if requests:
        service.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": requests}).execute()
    return {
        "formula_lock_range_count": len(merged_ranges),
        "formula_lock_ranges": merged_ranges,
    }


def _compress_a1_ranges(a1_ranges: Sequence[str]) -> List[str]:
    grouped: Dict[Tuple[str, int], List[int]] = {}
    passthrough: List[str] = []
    for a1 in a1_ranges:
        normalized = _normalize_formula_range(a1)
        if "!" in normalized:
            sheet, ref = normalized.split("!", 1)
        else:
            sheet, ref = SHEET_109_NAME, normalized
        match = re.fullmatch(r"([A-Z]+)(\d+)", ref)
        if not match:
            passthrough.append(f"{_quote_sheet_name(sheet)}!{ref}")
            continue
        col_n = _column_a1_to_number(match.group(1))
        row_n = int(match.group(2))
        grouped.setdefault((sheet, row_n), []).append(col_n)

    out = list(passthrough)
    for (sheet, row_n), cols in sorted(grouped.items()):
        for start, end in _contiguous_segments(cols):
            start_col = _column_number_to_a1(start)
            end_col = _column_number_to_a1(end)
            if start == end:
                out.append(f"{_quote_sheet_name(sheet)}!{start_col}{row_n}")
            else:
                out.append(f"{_quote_sheet_name(sheet)}!{start_col}{row_n}:{end_col}{row_n}")
    return out


def _build_repeat_cell_request(grid_range: Mapping[str, int], color: Mapping[str, float]) -> Dict[str, Any]:
    return {
        "repeatCell": {
            "range": dict(grid_range),
            "cell": {"userEnteredFormat": {"backgroundColor": dict(color)}},
            "fields": "userEnteredFormat.backgroundColor",
        }
    }


def _build_number_format_request(
    grid_range: Mapping[str, int],
    number_format: Mapping[str, str],
) -> Dict[str, Any]:
    return {
        "repeatCell": {
            "range": dict(grid_range),
            "cell": {"userEnteredFormat": {"numberFormat": dict(number_format)}},
            "fields": "userEnteredFormat.numberFormat",
        }
    }


def _build_hide_columns_request(
    sheet_id: int,
    start_col_1: int,
    end_col_1_inclusive: int,
) -> Dict[str, Any]:
    return {
        "updateDimensionProperties": {
            "range": {
                "sheetId": int(sheet_id),
                "dimension": "COLUMNS",
                "startIndex": int(start_col_1 - 1),
                "endIndex": int(end_col_1_inclusive),
            },
            "properties": {"hiddenByUser": True},
            "fields": "hiddenByUser",
        }
    }


def _build_109_format_requests(
    sheet_id: int,
    row_count: int,
    column_count: int,
    manual_ranges: Sequence[str],
    highlight_ranges: Sequence[str],
    error_ranges: Sequence[str],
) -> List[Dict[str, Any]]:
    requests: List[Dict[str, Any]] = [
        _build_repeat_cell_request(
            {
                "sheetId": int(sheet_id),
                "startRowIndex": 0,
                "endRowIndex": int(row_count),
                "startColumnIndex": 0,
                "endColumnIndex": int(column_count),
            },
            COLOR_FILL_WHITE,
        )
    ]

    for a1 in manual_ranges:
        requests.append(_build_repeat_cell_request(_a1_to_grid_range(a1, sheet_id), COLOR_FILL_LIGHT_GRAY))
    for a1 in _compress_a1_ranges(highlight_ranges):
        requests.append(_build_repeat_cell_request(_a1_to_grid_range(a1, sheet_id), COLOR_FILL_LIGHT_YELLOW))
    for a1 in _compress_a1_ranges(error_ranges):
        requests.append(_build_repeat_cell_request(_a1_to_grid_range(a1, sheet_id), COLOR_FILL_LIGHT_RED))
    return requests


def _build_unit_budget_actual_settlement_values(
    rows: Sequence[Sequence[Any]],
    overrides: Mapping[str, Mapping[str, str]],
) -> List[List[Any]]:
    prepared: List[Tuple[str, Any, str, str, int | str, str]] = []
    latest_unit_year: int | None = None
    latest_numeric_actual_dt: pd.Timestamp | None = None
    latest_numeric_tbd_dt: pd.Timestamp | None = None

    for row in rows[2:]:
        unit_code = _safe_string(row[1] if len(row) > 1 else "")
        settlement_year = row[6] if len(row) > 6 else ""
        override_item = overrides.get(unit_code, {})
        co_date = override_item.get("co_date", "") or (row[7] if len(row) > 7 else "")
        tbd_date = override_item.get("tbd_acceptance_date", "") or (row[10] if len(row) > 10 else "")
        actual_date, actual_year = _derive_unit_budget_actual_settlement_fields(
            unit_code, settlement_year, co_date, None
        )
        if _has_digits(unit_code):
            if actual_year != "":
                year_num = int(actual_year)
                latest_unit_year = year_num if latest_unit_year is None else max(latest_unit_year, year_num)
            actual_dt = _normalize_date_value(actual_date)
            if actual_dt is not None:
                latest_numeric_actual_dt = actual_dt if latest_numeric_actual_dt is None else max(latest_numeric_actual_dt, actual_dt)
            tbd_dt = _normalize_date_value(tbd_date)
            if tbd_dt is not None:
                latest_numeric_tbd_dt = tbd_dt if latest_numeric_tbd_dt is None else max(latest_numeric_tbd_dt, tbd_dt)
        prepared.append((unit_code, settlement_year, _safe_string(co_date), actual_date, actual_year, _safe_string(tbd_date)))

    values: List[List[Any]] = []
    latest_actual_text = _format_iso_date_or_blank(latest_numeric_actual_dt)
    latest_tbd_text = _format_iso_date_or_blank(latest_numeric_tbd_dt)
    latest_actual_year = latest_numeric_actual_dt.year if latest_numeric_actual_dt is not None else latest_unit_year
    for unit_code, settlement_year, co_date, actual_date, _, tbd_date in prepared:
        _, actual_year = _derive_unit_budget_actual_settlement_fields(unit_code, settlement_year, co_date, latest_unit_year)
        actual_date_out = actual_date
        tbd_date_out = tbd_date
        if not _has_digits(unit_code):
            if not actual_date_out: actual_date_out = latest_actual_text
            if actual_year == "" and latest_actual_year is not None: actual_year = latest_actual_year
            if not tbd_date_out: tbd_date_out = latest_tbd_text
        values.append([co_date, actual_date_out, actual_year if actual_year != "" else "", tbd_date_out])
    return values


def _build_unit_master_rows_v2(
    ub_rows: Sequence[Sequence[Any]],
    fd_rows: Sequence[Sequence[Any]],
    pay_rows: Sequence[Sequence[Any]]
) -> List[List[Any]]:
    if not ub_rows: return []
    units = set()
    for r in ub_rows[2:]:
        val = _safe_string(r[1] if len(r) > 1 else "")
        if val and val.upper() not in ("TOTAL", "SUM"): units.add(val)
    for r in pay_rows[1:]:
        if len(r) > 37:
            val = _safe_string(r[37])
            if val: units.add(val)
    for r in fd_rows[1:]:
        if len(r) > 20:
            val = _safe_string(r[20])
            if val: units.add(val)
    sorted_units = sorted(list(units))

    header_row = ub_rows[0] if ub_rows else []
    ub_unit_to_col = {}
    for idx in range(20, len(header_row)):
        val = _safe_string(header_row[idx])
        if val: ub_unit_to_col[val] = idx
    ub_unit_to_row = {}
    for r in ub_rows[1:]:
        u_code = _safe_string(r[1] if len(r) > 1 else "")
        if u_code: ub_unit_to_row[u_code] = r
    unit_to_latest_date: Dict[str, pd.Timestamp] = {}
    for r in fd_rows[1:]:
        if len(r) > 20:
            u = _safe_string(r[20])
            d_raw = r[14] if len(r) > 14 else ""
            if u and d_raw:
                dt = _normalize_date_value(d_raw)
                if dt:
                    if u not in unit_to_latest_date or dt > unit_to_latest_date[u]:
                        unit_to_latest_date[u] = dt

    master_header = ["Unit Code", "Total Budget", "GC Budget", "WIP Budget", "Incurred Amount", "Settlement Amount", "Final Date", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "Budget Variance", "Group"]
    data_rows: List[List[Any]] = []
    for uc in sorted_units:
        curr_row_idx = len(data_rows) + 3
        row_out = ["" for _ in range(13)]
        row_out[0] = uc
        total_budget, gc_budget, wip_budget = 0.0, 0.0, 0.0
        col_idx = ub_unit_to_col.get(uc)
        if col_idx is not None:
            for r in ub_rows[1:]:
                cell_val = _to_float(r[col_idx]) if col_idx < len(r) else None
                if cell_val is not None:
                    if len(r) > 14 and _safe_string(r[14]) == "1": total_budget += cell_val
                    if len(r) > 15 and _safe_string(r[15]) == "2": gc_budget += cell_val
                    if len(r) > 16 and _safe_string(r[16]) == "3": wip_budget += cell_val
        row_out[1] = "" if abs(total_budget) < 1e-12 else total_budget
        row_out[2] = "" if abs(gc_budget) < 1e-12 else gc_budget
        row_out[3] = "" if abs(wip_budget) < 1e-12 else wip_budget
        row_out[4] = f"=SUMIFS(Payable!$U:$U, Payable!$AL:$AL, $A{curr_row_idx}, Payable!$A:$A, \"ROE\") + SUMIFS(Payable!$U:$U, Payable!$AL:$AL, $A{curr_row_idx}, Payable!$A:$A, \"RACC\")"
        row_out[5] = f"=SUMIFS('Final Detail'!$P:$P, 'Final Detail'!$U:$U, $A{curr_row_idx}, 'Final Detail'!$A:$A, \"ROE\") + SUMIFS('Final Detail'!$P:$P, 'Final Detail'!$U:$U, $A{curr_row_idx}, 'Final Detail'!$A:$A, \"ACC\")"
        latest_dt = unit_to_latest_date.get(uc)
        row_out[6] = latest_dt.strftime("%Y-%m-%d") if latest_dt else ""
        row_out[11] = f"=$B{curr_row_idx} - $C{curr_row_idx} - $F{curr_row_idx}"
        ub_row = ub_unit_to_row.get(uc)
        if ub_row:
            for i, target_i in [(7, 7), (8, 8), (9, 9), (10, 10), (12, 12)]:
                if len(ub_row) > i: row_out[target_i] = ub_row[i]
        data_rows.append(row_out)
    last_row = len(data_rows) + 2
    total_row = [""] * 13
    total_row[0] = "Total"
    for col_idx_1 in [2, 3, 4, 5, 6, 12]:
        col_a1 = _column_number_to_a1(col_idx_1)
        total_row[col_idx_1 - 1] = f"=SUM({col_a1}3:{col_a1}{last_row})"
    return [total_row, master_header] + data_rows


def run_validate_input_data(service, spreadsheet_id: str) -> Dict[str, Any]:
    values = service.spreadsheets().values()
    unit_budget_rows = values.get(spreadsheetId=spreadsheet_id, range="'Unit Budget'!A:ZZ").execute().get("values", [])
    final_detail_rows = values.get(spreadsheetId=spreadsheet_id, range="'Final Detail'!A:V").execute().get("values", [])
    payable_rows = values.get(spreadsheetId=spreadsheet_id, range="'Payable'!A:AL").execute().get("values", [])
    values.get(spreadsheetId=spreadsheet_id, range="'Unit Master'!A:M").execute()

    unit_master_rows = _build_unit_master_rows_v2(unit_budget_rows, final_detail_rows, payable_rows)
    end_row = max(len(unit_master_rows), 1)
    values.update(
        spreadsheetId=spreadsheet_id,
        range=f"'Unit Master'!A1:M{end_row}",
        valueInputOption="USER_ENTERED",
        body={"values": unit_master_rows},
    ).execute()
    unit_budget_layout_count = _compat_global("_apply_unit_budget_support_formatting")(service, spreadsheet_id)
    scoping_layout = _compat_global("_apply_scoping_layout_controls")(service, spreadsheet_id)
    return {
        "unit_master_rows_written": len(unit_master_rows),
        "unit_budget_layout_request_count": unit_budget_layout_count,
        "scoping_layout": scoping_layout,
    }


def _build_unit_budget_support_requests(
    unit_budget_sheet_id: int,
    unit_master_sheet_id: int,
    row_count: int,
) -> List[Dict[str, Any]]:
    end_row = max(int(row_count), 3)
    requests = [
        _build_hide_columns_request(unit_budget_sheet_id, 2, 13),
        _build_repeat_cell_request({"sheetId": int(unit_budget_sheet_id), "startRowIndex": 0, "endRowIndex": end_row, "startColumnIndex": 1, "endColumnIndex": 13}, COLOR_FILL_WHITE),
        _build_repeat_cell_request({"sheetId": int(unit_master_sheet_id), "startRowIndex": 0, "endRowIndex": end_row, "startColumnIndex": 0, "endColumnIndex": 12}, COLOR_FILL_WHITE),
        _build_repeat_cell_request({"sheetId": int(unit_budget_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 7, "endColumnIndex": 8}, COLOR_FILL_LIGHT_GRAY),
        _build_repeat_cell_request({"sheetId": int(unit_budget_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 10, "endColumnIndex": 11}, COLOR_FILL_LIGHT_GRAY),
        _build_number_format_request({"sheetId": int(unit_budget_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 9, "endColumnIndex": 10}, NUMBER_FORMAT_YEAR_0),
        _build_repeat_cell_request({"sheetId": int(unit_master_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 7, "endColumnIndex": 8}, COLOR_FILL_LIGHT_GRAY),
        _build_repeat_cell_request({"sheetId": int(unit_master_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 10, "endColumnIndex": 11}, COLOR_FILL_LIGHT_GRAY),
        _build_number_format_request({"sheetId": int(unit_master_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 8, "endColumnIndex": 9}, NUMBER_FORMAT_YEAR_0),
    ]
    for grid_range in [
        {"sheetId": int(unit_budget_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 7, "endColumnIndex": 8},
        {"sheetId": int(unit_budget_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 8, "endColumnIndex": 9},
        {"sheetId": int(unit_budget_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 10, "endColumnIndex": 11},
        {"sheetId": int(unit_master_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 7, "endColumnIndex": 8},
        {"sheetId": int(unit_master_sheet_id), "startRowIndex": 2, "endRowIndex": end_row, "startColumnIndex": 10, "endColumnIndex": 11},
    ]:
        requests.append(_build_number_format_request(grid_range, NUMBER_FORMAT_DATE_ISO))
    return requests


def _build_109_error_ranges_from_values(value_map: Mapping[str, float | None]) -> List[str]:
    errors: List[str] = []
    e3, e4, e5, e12, e13, e37 = [value_map.get(f"109!E{i}") for i in [3, 4, 5, 12, 13, 37]]
    if e3 is not None and e4 is not None and e5 is not None and abs((e3 - e4) - e5) > 0.01:
        errors.append(f"{_quote_sheet_name(SHEET_109_NAME)}!E5")
    if e12 is not None and e12 > 1.0 + 1e-9:
        errors.append(f"{_quote_sheet_name(SHEET_109_NAME)}!E12")
    if e13 is not None:
        if e13 > 1.0 + 1e-9: errors.append(f"{_quote_sheet_name(SHEET_109_NAME)}!E13")
        elif e12 is not None and abs(e13 - e12) > 1e-6: errors.append(f"{_quote_sheet_name(SHEET_109_NAME)}!E13")
    if e37 is not None and e12 is not None and abs(e37 - e12) > 1e-6:
        errors.append(f"{_quote_sheet_name(SHEET_109_NAME)}!E37")
    return errors


def _build_109_formula_plan_from_grid(
    rows: Sequence[Sequence[Any]],
    config: Mapping[str, Any] | None = None,
    sheet_109_title: str = SHEET_109_NAME,
    formula_mappings: Mapping[str, Any] | None = None,
) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    if not rows: raise RuntimeError("109工作表为空。")
    cfg = dict(config or _load_109_formula_dictionary())
    cfg.update(_build_109_year_axis_config(rows))
    if formula_mappings:
        cfg["formula_mappings"] = formula_mappings
    mapper = MapperFactory.create("109", rows)
    generator = FinanceFormulaGenerator(mapper, config=cfg)
    meta: Dict[str, Any] = {}

    def _m_row(*labels: str) -> int | None:
        for lb in labels:
            try: return mapper.get_row(lb)
            except KeyError: continue
        return None

    year_row = _find_year_header_row_109(rows)
    row_contract_change = _m_row("Cumulative Savings (Target vs Actual)", "contract change order", "budget surplus")
    row_contract_amount = _m_row("contract amount")
    label_rows = _find_rows_by_item_label(rows, item_col_1=3)
    surplus_row_candidates = label_rows.get("cumulative savings target vs actual", []) or label_rows.get("budget surplus", [])
    row_surplus_tp = surplus_row_candidates[0] if surplus_row_candidates else None
    row_surplus_eac = surplus_row_candidates[1] if len(surplus_row_candidates) > 1 else None
    if row_contract_change is None: row_contract_change = row_surplus_tp
    if row_contract_amount is None and row_contract_change is not None and row_contract_change > 1: row_contract_amount = row_contract_change - 1

    row_contract_price = _m_row("contract change amount", "contract price") or _choose_contract_price_row(rows, label_rows)
    row_contract_price_day1 = _find_contract_price_day1_row(rows)
    row_poc = _m_row("Percentage of Completion (POC)", "percentage of completion")
    row_cr = _m_row("Completion Rate for the Period", "completion rate for the period")
    row_initial_budget = _m_row("Initial Budget (Original Contract Sum)", "day 1 budget")
    row_overrun = _m_row("Owner-unapproved Overrun", "owner-unapproved overrun")
    row_budget = _m_row("Current Dynamic EAC (Total Cost)", "dynamic budget (eac)", "scoping budget cost")
    row_cum_direct_cost = _m_row("Cumulative Total Cost (Actual)", "cumulative direct cost")
    row_cogs_calc = _m_row("cost of goods sold-company")
    row_cogs_aud = _m_row("Audit Adjustment (Current Period)", "cost of goods sold-audited")
    row_cogs = _m_row("Confirmed COGS (Current Period)", "cost of goods sold")
    row_revenue_company = _m_row("general conditions fee-company")
    row_revenue_aud = _m_row("general conditions fee-audited")
    row_revenue = _m_row("general conditions fee")
    row_gp_company = _m_row("gross profit-company")
    row_gp = _m_row("gross profit")
    row_ar_incurred = _m_row("accounts receivable-incurred")
    row_ar_aud = _m_row("accounts receivable-audited")
    row_ar_company = _m_row("accounts receivable-company")
    row_ar = _m_row("accounts receivable")
    row_wbh_income = _m_row("wb home income")
    row_wbh_cogs = _m_row("wb home cogs")
    row_inv_income = _m_row("wb home inventory income")
    row_inv = _m_row("wb home inventory")
    row_inv_income_rev = _m_row("wb home inventory income-reverse")
    row_inv_rev = _m_row("wb home inventory-reverse")
    row_roe_total = _m_row("total roe cost")
    row_roe_wbhome = _m_row("roe cost - wb home")
    row_roe_wpred = _m_row("roe cost - wpred")
    row_acc_expenses = _m_row("accrued expenses")
    row_racc_reversed = _m_row("reversed accrued expenses")
    row_income_total = _m_row("total income cost")
    row_gc_cost = _m_row("total gc cost", "gc cost")
    row_accrued_warranty = _m_row("accrued warranty expenses")
    row_actual_warranty = _m_row("actual warranty expenses (reversed)")
    row_wbh_total = _m_row("wb. home material margin total")
    row_main_mm, row_inv_mm = _find_material_margin_rows_109(label_rows, row_wbh_cogs, row_inv)

    required_rows = {
        "年度表头(2021-2026)": year_row, "Contract Amount": row_contract_amount, "Contract price": row_contract_price,
        "Contract price (Day1)": row_contract_price_day1, "Contract Change Order": row_surplus_tp,
        "Percentage of Completion": row_poc, "Completion Rate for the Period": row_cr, "Initial Budget": row_initial_budget,
        "Owner-unapproved Overrun": row_overrun, "Budget Cost(分母EAC)": row_budget, "Cumulative Direct Cost": row_cum_direct_cost,
        "Cost of Goods Sold-Company": row_cogs_calc, "General Conditions fee-Company": row_revenue_company,
        "Gross Profit-Company": row_gp_company, "Accounts Receivable-Incurred": row_ar_incurred, "Accounts Receivable-Audited": row_ar_aud,
        "Accounts Receivable-Company": row_ar_company, "Accounts Receivable": row_ar, "WB Home Income": row_wbh_income,
        "WB Home COGS": row_wbh_cogs, "WB Home Inventory Income": row_inv_income, "WB Home Inventory": row_inv,
        "WB Home Inventory Income-Reverse": row_inv_income_rev, "WB Home Inventory-Reverse": row_inv_rev,
        "WB. Home Material Margin Total": row_wbh_total, "Total ROE Cost": row_roe_total, "ROE Cost - WB Home": row_roe_wbhome,
        "ROE Cost - WPRED": row_roe_wpred, "Accrued Expenses": row_acc_expenses, "Reversed Accrued Expenses": row_racc_reversed,
        "Total Income Cost": row_income_total, "Material Margin(main)": row_main_mm, "Material Margin(inventory)": row_inv_mm,
    }
    # 新分类行设为必选
    optional_rows = {
        "Total GC Cost": row_gc_cost,
        "Accrued Warranty Expenses": row_accrued_warranty,
        "Actual Warranty Expenses (Reversed)": row_actual_warranty
    }

    missing = [name for name, row_i in required_rows.items() if row_i is None]
    if missing: raise RuntimeError("109关键行定位失败: " + "、".join(missing))

    plan: List[Dict[str, str]] = []
    def add_formula(col_i: int, row_i: int, formula: str, logic: str) -> None:
        col = _column_number_to_a1(col_i)
        plan.append({"sheet": sheet_109_title, "cell": f"{col}{row_i}", "range": f"{_quote_sheet_name(sheet_109_title)}!{col}{row_i}", "formula": formula, "logic": logic})

    axis = _detect_109_year_axis(rows)
    primary_year_cols = axis[1] if axis else list(range(6, 12))
    anchor_col_i = primary_year_cols[-1]
    anchor_col = _column_number_to_a1(anchor_col_i)
    start_year_expr = f"Year(${anchor_col}$2)"
    add_formula(anchor_col_i, 2, _build_109_date_array_formula("MIN"), "Start date")
    add_formula(anchor_col_i, 3, _build_109_date_array_formula("MAX"), "End date")
    add_formula(3, 5, '=IFERROR(COUNTA(FILTER(\'Unit Budget\'!$B$3:$B,REGEXMATCH(\'Unit Budget\'!$B$3:$B,"[0-9]"))),0)', "Units count")
    add_formula(5, 3, "=SUMIFS('Unit Budget'!$T:$T,'Unit Budget'!$O:$O,1)", "Contract price (Day1)")
    add_formula(5, 5, "=SUMIFS('Unit Budget'!$T:$T,'Unit Budget'!$P:$P,2)", "General Conditions fee")
    add_formula(5, 12, '=IFERROR(round(MAX(F12:K12),8),"")', "POC Total")
    add_formula(5, 13, '=IFERROR(round(SUM(F13:K13),8),"")', "Completion Rate Total")

    for offset, col_i in enumerate(primary_year_cols):
        col = _column_number_to_a1(col_i)
        prev_col = _column_number_to_a1(primary_year_cols[offset - 1]) if offset > 0 else ""
        year_ref = f"{col}${year_row}"
        add_formula(col_i, row_contract_amount, f'=IF({col}$10={start_year_expr},-$E$3,0)', "Contract Amount") # type: ignore
        add_formula(col_i, row_surplus_tp, f"=SUMIFS('Unit Master'!$L:$L,'Unit Master'!$J:$J,{year_ref})", "Budget Surplus") # type: ignore
        contract_price_formula = f'=IF({col}$10<{start_year_expr},"",IF({col}$10={start_year_expr},{col}{row_contract_amount}+{col}{row_surplus_tp},IFERROR({prev_col}{row_contract_price}+{col}{row_surplus_tp},"")))'
        add_formula(col_i, row_contract_price, contract_price_formula, "Contract Change Amount") # type: ignore
        add_formula(col_i, row_initial_budget, f"=IF({col}$10={start_year_expr},$C$3,0)", "Initial Budget") # type: ignore
        add_formula(col_i, row_budget, generator.get_eac_formula(col), "EAC") # type: ignore
        add_formula(col_i, row_poc, generator.get_poc_formula(col), "POC") # type: ignore
        # 核心逻辑修正：调用重构后的方法，传入 prev_col 以支持差额推算
        add_formula(col_i, row_cogs, generator.get_confirmed_cogs_formula(col, prev_col), "COGS") # type: ignore
        add_formula(col_i, row_cr, f"=IFERROR(round({col}{row_poc}-{'0' if not prev_col else prev_col+str(row_poc)},8),\"\")", "CR") # type: ignore
        # 核心逻辑修正：调用重构后的方法，传入 prev_col
        add_formula(col_i, row_revenue, generator.get_revenue_formula(col, prev_col), "Revenue") # type: ignore

        if row_income_total:
            add_formula(col_i, row_income_total, generator.get_income_total_formula(col, year_ref), "Total Income Cost")

        # Gross Profit, 52 行
        if row_gp:
            # 同样应用审计优先、差额推算逻辑
            # 这里需要你手写公式的“金标准”来确定审计行和累计行
            # 假设审计行为 gp-audited, 累计行为 gp-company
            audited_gp_row = _m_row("gross profit-audited")
            cumulative_gp_row = _m_row("gross profit-company")
            if audited_gp_row and cumulative_gp_row:
                 add_formula(col_i, row_gp, generator._get_audited_or_cumulative_diff_formula(col, prev_col, audited_gp_row, cumulative_gp_row, row_gp), "Gross Profit")

        # 固化新三行公式
        if row_gc_cost:
            add_formula(col_i, row_gc_cost, generator.get_gc_cost_formula(col, year_ref), "Total GC Cost")
        if row_accrued_warranty:
            # 计提行在 F-K 列不生成公式，保持手工值，由格式化渲染灰色
            pass
        if row_actual_warranty:
            add_formula(col_i, row_actual_warranty, generator.get_actual_warranty_formula(col, year_ref), "Actual Warranty Expenses (Reversed)")

    # 特殊格式化：计提保修费用手工区 (F37:K37)
    if row_accrued_warranty:
        # 37 行 A1 范围: F{row}:K{row}
        manual_range = f"{_quote_sheet_name(sheet_109_title)}!F{row_accrued_warranty}:K{row_accrued_warranty}"
        # 注入到 meta 中，后续格式化逻辑会读取
        if "manual_input_ranges" not in meta: meta["manual_input_ranges"] = []
        meta["manual_input_ranges"].append(manual_range)

    return plan, {"sheet": sheet_109_title, "year_row": year_row, "formula_count": len(plan), "key_rows": {**required_rows, **optional_rows}, "manual_ranges": meta.get("manual_input_ranges", [])}


def _ensure_109_labels(service, spreadsheet_id: str) -> int:
    """确保109表的关键行（如GC成本、保修费用等）具备正确的英文标签，以便后续公式匹配。"""
    resp = service.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range="109!A1:D100").execute()
    rows = resp.get("values", [])
    if not rows:
        return 0

    updates = []
    # 查找并更新标签
    for i, row in enumerate(rows):
        row_num = i + 1
        # 获取第 D 列（索引 3）的内容，如果没有则为空
        label_en = row[3] if len(row) > 3 else ""
        label_cn = row[0] if len(row) > 0 else ""

        # 1. GC Cost -> Total GC Cost
        if "GC" in label_cn and ("GC Cost" in label_en or not label_en):
            if label_en != "Total GC Cost":
                updates.append({"range": f"109!D{row_num}", "values": [["Total GC Cost"]]})

        # 2. 计提保修费用
        if label_cn == "计提保修费用":
            if label_en != "Accrued Warranty Expenses":
                updates.append({"range": f"109!D{row_num}", "values": [["Accrued Warranty Expenses"]]})

        # 3. 实际发生保修费用
        if label_cn == "实际发生保修费用":
            if label_en != "Actual Warranty Expenses (Reversed)":
                updates.append({"range": f"109!D{row_num}", "values": [["Actual Warranty Expenses (Reversed)"]]})

    if updates:
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "USER_ENTERED", "data": updates}
        ).execute()
        return len(updates)
    return 0


def generate_109_formula_plan(
    service,
    spreadsheet_id: str,
    sheet_109_title: str | None = None,
    project_id: str | None = None,
) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    # These functions need to be defined or imported
    _compat_global("_ensure_unit_budget_actual_settlement_columns")(service, spreadsheet_id)
    _compat_global("_refresh_unit_budget_actual_settlement_columns")(service, spreadsheet_id)
    _compat_global("_sync_unit_master_sheet")(service, spreadsheet_id)
    _compat_global("_apply_unit_budget_support_formatting")(service, spreadsheet_id)
    _compat_global("_apply_scoping_layout_controls")(service, spreadsheet_id)
    _compat_global("_ensure_109_contract_amount_row")(service, spreadsheet_id)
    _compat_global("_ensure_109_income_section_layout")(service, spreadsheet_id)
    _compat_global("_ensure_109_labels")(service, spreadsheet_id)
    resolved_sheet_title = _safe_string(sheet_109_title) or SHEET_109_NAME
    resp = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id,
        range=f"{_quote_sheet_name(resolved_sheet_title)}!A:ZZ",
    ).execute()
    rows = resp.get("values", [])
    formula_config = _load_109_formula_dictionary()
    if project_id:
        project_mappings = _compat_global("MappingService").get_project_mappings(project_id)
        if project_mappings:
            formula_config = dict(formula_config)
            formula_config["formula_mappings"] = project_mappings
    plan, meta = _build_109_formula_plan_from_grid(rows, formula_config, sheet_109_title=resolved_sheet_title)
    semantic_updates = update_109_semantic_logic(
        rows,
        sheet_109_title=resolved_sheet_title,
        formula_mappings=formula_config.get("formula_mappings") if isinstance(formula_config, Mapping) else None,
    )
    merged_plan = _merge_formula_plan_with_semantic_updates(plan, semantic_updates)
    if resolved_sheet_title != SHEET_109_NAME:
        for item in merged_plan:
            item["sheet"] = resolved_sheet_title
            item["range"] = f"{_quote_sheet_name(resolved_sheet_title)}!{item['cell']}"
        meta["sheet"] = resolved_sheet_title
    if project_id:
        meta["formula_mapping_project_id"] = project_id
    meta["semantic_formula_count"] = len(semantic_updates)
    return merged_plan, meta


def _ensure_unit_budget_actual_settlement_columns(service, spreadsheet_id: str) -> bool:
    rows = service.spreadsheets().values().get(spreadsheetId=spreadsheet_id, range="'Unit Budget'!H2:K2").execute().get("values", [])
    if not rows or rows[0] != ["C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date"]:
        # Logic to insert columns omitted for brevity in this mock-up
        return True
    return False

def _refresh_unit_budget_actual_settlement_columns(service, spreadsheet_id: str) -> int:
    # Logic to refresh columns omitted
    return 0

def _sync_unit_master_sheet(service, spreadsheet_id: str) -> int:
    values = service.spreadsheets().values()
    unit_budget_rows = values.get(spreadsheetId=spreadsheet_id, range="'Unit Budget'!A:ZZ").execute().get("values", [])
    final_detail_rows = values.get(spreadsheetId=spreadsheet_id, range="'Final Detail'!A:V").execute().get("values", [])
    payable_rows = values.get(spreadsheetId=spreadsheet_id, range="'Payable'!A:AL").execute().get("values", [])
    values.get(spreadsheetId=spreadsheet_id, range="'Unit Master'!A:M").execute()
    unit_master_rows = _compat_global("_build_unit_master_rows_v2")(unit_budget_rows, final_detail_rows, payable_rows)
    if len(unit_master_rows) <= 2:
        raise RuntimeError("Unit Master sync aborted: no valid data rows")
    values.update(
        spreadsheetId=spreadsheet_id,
        range=f"'Unit Master'!A1:M{len(unit_master_rows)}",
        valueInputOption="USER_ENTERED",
        body={"values": unit_master_rows},
    ).execute()
    return len(unit_master_rows)

def _apply_unit_budget_support_formatting(service, spreadsheet_id: str) -> int:
    return 0

def _apply_scoping_layout_controls(service, spreadsheet_id: str) -> Dict[str, Any]:
    return {}

def _ensure_109_contract_amount_row(service, spreadsheet_id: str) -> bool:
    return False

def _ensure_109_income_section_layout(service, spreadsheet_id: str) -> Dict[str, Any]:
    return {}

def _verify_formula_plan(service, spreadsheet_id: str, plan: Sequence[Mapping[str, str]]) -> Dict[str, Any]:
    ranges = [str(item["range"]) for item in plan if "range" in item]
    expected = { _normalize_formula_range(str(item["range"])): _normalize_formula_text_for_compare(item.get("formula", "")) for item in plan }
    matched, mismatches = 0, []
    for chunk in _chunked([{"range": r} for r in ranges], 200):
        resp = service.spreadsheets().values().batchGet(spreadsheetId=spreadsheet_id, ranges=[c["range"] for c in chunk], valueRenderOption="FORMULA").execute()
        for vr in resp.get("valueRanges", []):
            a1, actual = _normalize_formula_range(vr.get("range", "")), _normalize_formula_text_for_compare(vr.get("values", [[""]])[0][0])
            if actual == expected.get(a1): matched += 1
            else: mismatches.append({"range": a1, "expected": expected.get(a1), "actual": actual})
    return {"matched": matched, "total": len(ranges), "mismatches": mismatches}


def _merge_draft_with_cloud(base_df: pd.DataFrame, draft_df: pd.DataFrame, uid_column: str) -> pd.DataFrame:
    if draft_df.empty: return base_df.copy()
    merged = draft_df.copy()
    for col in base_df.columns:
        if col not in merged.columns: merged[col] = ""
    if uid_column in base_df.columns and uid_column in merged.columns:
        draft_uids = set(merged[uid_column].astype("string").fillna("").str.strip())
        missing = base_df[~base_df[uid_column].astype("string").fillna("").str.strip().isin(draft_uids)]
        if not missing.empty: merged = pd.concat([merged, missing], ignore_index=True)
    return merged.reindex(columns=list(base_df.columns) + [c for c in merged.columns if c not in base_df.columns])


def _prepare_sheet_df(cloud_df: pd.DataFrame, uid_column: str, shadow_cfg: Mapping[str, Any]) -> pd.DataFrame:
    prepared, _ = ensure_uid_anchor(cloud_df, uid_column)
    return apply_shadow_logic(prepared, **shadow_cfg)


def _has_pending_uid(df: pd.DataFrame) -> bool:
    return UID_STATUS_COL in df.columns and (df[UID_STATUS_COL].astype("string") == UID_PENDING_VALUE).any()


def _find_dirty_sheets(original_map: Mapping[str, pd.DataFrame], edited_map: Mapping[str, pd.DataFrame]) -> List[str]:
    dirty = []
    for s in sorted(set(original_map.keys()) | set(edited_map.keys())):
        if _df_signature(original_map.get(s, pd.DataFrame())) != _df_signature(edited_map.get(s, pd.DataFrame())) or _has_pending_uid(edited_map.get(s, pd.DataFrame())):
            dirty.append(s)
    return dirty

def append_audit_log(operator: str, summary: str, details: Sequence[str]) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lines = [f"[{now}] operator={operator} | {summary}"] + [f"  - {line}" for line in details]
    AUDIT_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG_FILE.open("a", encoding="utf-8") as fp: fp.write("\n".join(lines) + "\n")


def _ensure_local_store() -> None:
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)


def _draft_file(sheet: str) -> Path:
    return DRAFT_DIR / f"{_slugify_sheet_name(sheet)}.pkl"


def save_local_draft(sheet: str, df: pd.DataFrame) -> None:
    _ensure_local_store()
    df.to_pickle(_draft_file(sheet))


def load_local_draft(sheet: str) -> pd.DataFrame | None:
    path = _draft_file(sheet)
    if not path.exists():
        return None
    try:
        return pd.read_pickle(path)
    except Exception:
        return None


def clear_local_drafts() -> None:
    if not DRAFT_DIR.exists():
        return
    for file in DRAFT_DIR.glob("*.pkl"):
        file.unlink(missing_ok=True)


def save_local_cloud_snapshot(
    spreadsheet_id: str,
    cloud_map: Mapping[str, pd.DataFrame],
    formula_lookup_map: Mapping[str, Dict[Tuple[int, str], str]],
    cloud_meta: Mapping[str, Any],
) -> None:
    _ensure_local_store()
    payload = {
        "spreadsheet_id": spreadsheet_id,
        "cloud_map": dict(cloud_map),
        "formula_lookup_map": dict(formula_lookup_map),
        "cloud_meta": dict(cloud_meta),
        "saved_at": datetime.now(timezone.utc).isoformat(),
    }
    tmp = CLOUD_SNAPSHOT_FILE.with_suffix(".tmp")
    with tmp.open("wb") as fp:
        pickle.dump(payload, fp, protocol=pickle.HIGHEST_PROTOCOL)
    tmp.replace(CLOUD_SNAPSHOT_FILE)


def load_local_cloud_snapshot(
    spreadsheet_id: str,
) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Dict[Tuple[int, str], str]], Dict[str, Any]] | None:
    if not CLOUD_SNAPSHOT_FILE.exists():
        return None
    try:
        with CLOUD_SNAPSHOT_FILE.open("rb") as fp:
            payload = pickle.load(fp)
    except Exception:
        return None

    if not isinstance(payload, Mapping):
        return None
    if _safe_string(payload.get("spreadsheet_id")) != _safe_string(spreadsheet_id):
        return None

    cloud_map = payload.get("cloud_map")
    formula_lookup_map = payload.get("formula_lookup_map")
    cloud_meta = payload.get("cloud_meta")
    if not isinstance(cloud_map, Mapping) or not isinstance(formula_lookup_map, Mapping) or not isinstance(cloud_meta, Mapping):
        return None
    meta = dict(cloud_meta)
    meta["snapshot_source"] = "local"
    meta["snapshot_saved_at"] = _safe_string(payload.get("saved_at"))
    return dict(cloud_map), dict(formula_lookup_map), meta


def execute_109_formula_plan(
    service,
    spreadsheet_id: str,
    plan: Sequence[Mapping[str, str]],
    meta: Mapping[str, Any] | None = None,
    *,
    sheet_109_title: str | None = None,
) -> Dict[str, Any]:
    resolved_sheet_title = sheet_109_title or _safe_string((meta or {}).get("sheet")) or SHEET_109_NAME
    _compat_global("_cleanup_109_legacy_duplicate_contract_change_row")(service, spreadsheet_id, resolved_sheet_title)
    updates = [
        {
            "range": str(item["range"]),
            "majorDimension": "ROWS",
            "values": [[str(item["formula"])]],
        }
        for item in plan
        if item.get("range") and item.get("formula")
    ]
    if not updates:
        return {
            "api_calls": 0,
            "updated_ranges": 0,
            "verify": {"matched": 0, "total": 0, "mismatches": []},
        }

    api_calls = 0
    retry_count = 0
    throttled_chunk_count = 0
    old_values: List[Dict[str, Any]] = []
    try:
        batch_get = service.spreadsheets().values().batchGet(
            spreadsheetId=spreadsheet_id,
            ranges=[item["range"] for item in updates],
            valueRenderOption="FORMULA",
        ).execute()
        for item, value_range in zip(updates, batch_get.get("valueRanges", [])):
            old_values.append(
                {
                    "range": item["range"],
                    "majorDimension": "ROWS",
                    "values": value_range.get("values", [[""]]),
                }
            )
    except Exception:
        old_values = [{"range": item["range"], "majorDimension": "ROWS", "values": [[""]]} for item in updates]

    try:
        for chunk in _chunked(updates, int(_compat_global("FORMULA_WRITE_CHUNK_SIZE") or 200)):
            body = {
                "valueInputOption": "USER_ENTERED",
                "data": list(chunk),
            }
            try:
                service.spreadsheets().values().batchUpdate(
                    spreadsheetId=spreadsheet_id,
                    body=body,
                ).execute()
            except Exception as exc:
                status = getattr(getattr(exc, "resp", None), "status", None)
                if status == 429 or "429" in str(exc):
                    retry_count += 1
                    throttled_chunk_count += 1
                    time.sleep(1)
                    service.spreadsheets().values().batchUpdate(
                        spreadsheetId=spreadsheet_id,
                        body=body,
                    ).execute()
                else:
                    raise
            api_calls += 1
    except Exception as exc:
        try:
            service.spreadsheets().values().batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={"valueInputOption": "USER_ENTERED", "data": old_values},
            ).execute()
        finally:
            raise RuntimeError("FORMULA_WRITEBACK_PARTIAL_ROLLBACK") from exc

    verify = _compat_global("_verify_formula_plan")(service, spreadsheet_id, plan)
    layout_109 = _compat_global("_apply_109_layout_controls")(service, spreadsheet_id)
    formula_locks = _compat_global("_apply_109_formula_lock_protection")(
        service=service,
        spreadsheet_id=spreadsheet_id,
        plan=plan,
        sheet_109_title=resolved_sheet_title,
    )
    external_controls = _compat_global("_apply_external_sheet_controls")(service, spreadsheet_id)
    return {
        "api_calls": api_calls,
        "updated_ranges": len(updates),
        "verify": verify,
        "109_layout": layout_109,
        "formula_locks": formula_locks,
        "external_controls": external_controls,
        "write_throttle": {
            "retry_count": retry_count,
            "throttled_chunk_count": throttled_chunk_count,
        },
    }


def clear_local_cloud_snapshot() -> None:
    CLOUD_SNAPSHOT_FILE.unlink(missing_ok=True)


__all__ = [name for name in globals() if not name.startswith("__")]
