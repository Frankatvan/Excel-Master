from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Sequence, Tuple

import pandas as pd
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

INTERNAL_COL_PREFIX = "__AIWB_"
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
DEFAULT_SERVICE_ACCOUNT_FILE = "credentials.json"

def _get_service_account_info() -> Dict[str, Any]:
    # 优先从环境变量读取完整的 JSON 字符串
    env_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    if env_json:
        try:
            return json.loads(env_json)
        except Exception as e:
            raise RuntimeError(f"解析 GOOGLE_CREDENTIALS_JSON 失败: {e}")

    # 其次尝试从文件读取
    fallback_file = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", DEFAULT_SERVICE_ACCOUNT_FILE)
    file_path = Path(fallback_file)
    if file_path.exists():
        return json.loads(file_path.read_text(encoding="utf-8"))

    # 最后尝试读取零散的环境变量
    keys = [
        "type", "project_id", "private_key_id", "private_key",
        "client_email", "client_id", "auth_uri", "token_uri",
        "auth_provider_x509_cert_url", "client_x509_cert_url", "universe_domain"
    ]
    info = {}
    for k in keys:
        val = os.getenv(f"GOOGLE_{k.upper()}")
        if val:
            # 处理 private_key 中的换行符
            if k == "private_key":
                val = val.replace("\\n", "\n")
            info[k] = val
    
    if all(k in info for k in ["project_id", "private_key", "client_email"]):
        return info

    raise RuntimeError(
        "未找到 Google Service Account 凭证。请设置 GOOGLE_CREDENTIALS_JSON 环境变量或提供 credentials.json 文件。"
    )

def get_sheets_service():
    info = _get_service_account_info()
    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)

def _to_plain_dict(obj: Any) -> Any:
    if isinstance(obj, Mapping):
        return {k: _to_plain_dict(v) for k, v in obj.items()}
    return obj

def _safe_secrets() -> Mapping[str, Any]:
    try:
        return _to_plain_dict(dict(st.secrets))
    except StreamlitSecretNotFoundError:
        return {}

def _get_secret(name: str, default: Any = None) -> Any:
    secrets = _safe_secrets()
    if name in secrets:
        return secrets[name]
    if "app" in secrets and name in secrets["app"]:
        return secrets["app"][name]
    return default

def _parse_options(value: Any, fallback: Sequence[str]) -> List[str]:
    if value is None:
        return list(fallback)
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, Sequence):
        return [str(item) for item in value]
    return list(fallback)

def _is_internal_col(col: str) -> bool:
    return str(col).startswith(INTERNAL_COL_PREFIX)

def _cloud_view(df: pd.DataFrame) -> pd.DataFrame:
    return df[[c for c in df.columns if not _is_internal_col(str(c))]].copy()

def _column_number_to_a1(index_1_based: int) -> str:
    if index_1_based < 1:
        raise ValueError("列号必须 >= 1")
    chars: List[str] = []
    value = index_1_based
    while value > 0:
        value, rem = divmod(value - 1, 26)
        chars.append(chr(ord("A") + rem))
    return "".join(reversed(chars))

def _quote_sheet_name(name: str) -> str:
    escaped = name.replace("'", "''")
    return f"'{escaped}'"

def _normalize_formula_range(a1: str) -> str:
    x = _safe_string(a1).replace("$", "")
    if "!" not in x:
        return x
    sheet, cell = x.split("!", 1)
    sheet = sheet.strip().strip("'")
    return f"{sheet}!{cell}"

def _normalize_formula_text_for_compare(formula: Any) -> str:
    text = _safe_string(formula)
    if not text:
        return ""

    out: List[str] = []
    in_quotes = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"':
            out.append(ch)
            if in_quotes and i + 1 < len(text) and text[i + 1] == '"':
                out.append('"')
                i += 2
                continue
            in_quotes = not in_quotes
            i += 1
            continue
        out.append(ch if in_quotes else ch.upper())
        i += 1
    return "".join(out)

def _column_a1_to_number(label: str) -> int:
    value = 0
    for ch in _safe_string(label).upper():
        if not ("A" <= ch <= "Z"):
            raise ValueError(f"非法列标: {label}")
        value = value * 26 + (ord(ch) - ord("A") + 1)
    if value < 1:
        raise ValueError(f"非法列标: {label}")
    return value

def _normalize_headers(headers: Sequence[str]) -> List[str]:
    seen: Dict[str, int] = {}
    normalized: List[str] = []
    for i, header in enumerate(headers):
        base = str(header).strip() or f"Unnamed_{i + 1}"
        seen[base] = seen.get(base, 0) + 1
        if seen[base] == 1:
            normalized.append(base)
        else:
            normalized.append(f"{base}_{seen[base]}")
    return normalized

def _parse_cell_value(cell: Dict[str, Any]) -> Any:
    if "formattedValue" in cell:
        return cell["formattedValue"]

    entered = cell.get("userEnteredValue", {})
    for key in ("stringValue", "numberValue", "boolValue"):
        if key in entered:
            return entered[key]
    return ""

def _parse_formula_value(cell: Dict[str, Any]) -> str:
    entered = cell.get("userEnteredValue", {})
    formula = entered.get("formulaValue", "")
    return str(formula) if formula else ""

def _trim_matrix(matrix: List[List[Any]]) -> List[List[Any]]:
    while matrix and all(str(item).strip() == "" for item in matrix[-1]):
        matrix.pop()
    if not matrix:
        return []

    max_cols = max(len(row) for row in matrix)
    padded = [row + [""] * (max_cols - len(row)) for row in matrix]
    keep_cols = [
        idx for idx in range(max_cols) if any(str(row[idx]).strip() != "" for row in padded)
    ]
    if not keep_cols:
        return []
    return [[row[idx] for idx in keep_cols] for row in padded]

def _trim_display_and_formula_matrices(
    display_matrix: List[List[Any]],
    formula_matrix: List[List[str]],
) -> Tuple[List[List[Any]], List[List[str]]]:
    while display_matrix and all(str(item).strip() == "" for item in display_matrix[-1]):
        display_matrix.pop()
        if formula_matrix:
            formula_matrix.pop()

    if not display_matrix:
        return [], []

    max_cols = max(len(row) for row in display_matrix)
    padded_display = [row + [""] * (max_cols - len(row)) for row in display_matrix]
    padded_formula = []
    for idx, row in enumerate(formula_matrix):
        padded_formula.append(row + [""] * (max_cols - len(row)))
    if len(padded_formula) < len(padded_display):
        padded_formula.extend([[""] * max_cols for _ in range(len(padded_display) - len(padded_formula))])

    keep_cols = [
        idx
        for idx in range(max_cols)
        if any(str(row[idx]).strip() != "" for row in padded_display)
    ]
    if not keep_cols:
        return [], []

    trimmed_display = [[row[idx] for idx in keep_cols] for row in padded_display]
    trimmed_formula = [[row[idx] for idx in keep_cols] for row in padded_formula]
    return trimmed_display, trimmed_formula

def _build_formula_lookup(
    trimmed_display: List[List[Any]],
    trimmed_formula: List[List[str]],
) -> Dict[Tuple[int, str], str]:
    if not trimmed_display:
        return {}

    headers = _normalize_headers(trimmed_display[0])
    lookup: Dict[Tuple[int, str], str] = {}

    for data_row_idx, row in enumerate(trimmed_formula[1:]):
        padded = row[: len(headers)] + [""] * max(0, len(headers) - len(row))
        for col_idx, formula in enumerate(padded):
            formula_text = str(formula).strip()
            if formula_text.startswith("="):
                lookup[(data_row_idx, headers[col_idx])] = formula_text

    return lookup

def _build_formula_lookup_by_headers(
    headers: Sequence[str],
    formula_matrix: Sequence[Sequence[Any]],
) -> Dict[Tuple[int, str], str]:
    if not headers or not formula_matrix:
        return {}

    norm_headers = _normalize_headers([str(h) for h in headers])
    lookup: Dict[Tuple[int, str], str] = {}
    for data_row_idx, row in enumerate(formula_matrix[1:]):
        padded = list(row)[: len(norm_headers)] + [""] * max(0, len(norm_headers) - len(row))
        for col_idx, formula in enumerate(padded):
            formula_text = _safe_string(formula)
            if formula_text.startswith("="):
                lookup[(data_row_idx, norm_headers[col_idx])] = formula_text
    return lookup

def _values_to_dataframe(values: List[List[Any]]) -> pd.DataFrame:
    if not values:
        return pd.DataFrame()

    headers = _normalize_headers(values[0])
    width = len(headers)
    rows: List[List[Any]] = []
    for row in values[1:]:
        normalized_row = row[:width] + [""] * max(0, width - len(row))
        rows.append(normalized_row)
    return pd.DataFrame(rows, columns=headers)

def _serialize_for_api(value: Any) -> Any:
    if pd.isna(value):
        return ""
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, (int, float, bool, str)):
        return value
    return str(value)

def _dataframe_to_values(df: pd.DataFrame) -> List[List[Any]]:
    headers = [str(col) for col in df.columns.tolist()]
    body = (
        df.applymap(_serialize_for_api)
        .replace({pd.NA: "", None: ""})
        .values.tolist()
    )
    return [headers] + body

def _df_signature(df: pd.DataFrame) -> str:
    cloud_df = _cloud_view(df)
    cols = [str(col) for col in cloud_df.columns.tolist()]
    normalized = cloud_df.astype("string").fillna("")
    payload = "|".join(cols) + "\n" + normalized.to_csv(index=False)
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()

def _safe_string(value: Any) -> str:
    if pd.isna(value):
        return ""
    return str(value).strip()

def _safe_number(value: Any) -> float:
    num = _to_float(value)
    return num if num is not None else 0.0

def _to_float(value: Any) -> float | None:
    if pd.isna(value):
        return None
    if isinstance(value, str) and value.strip().startswith("="):
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except Exception:
        return None

def _extract_tail_int(value: Any, digits: int) -> int | None:
    text = _safe_string(value)
    if not text:
        return None
    if len(text) < digits:
        if text.isdigit():
            return int(text)
        return None
    tail = text[-digits:]
    if tail.isdigit():
        return int(tail)
    return None

def _extract_tail_str(value: Any, digits: int) -> str:
    text = _safe_string(value)
    if not text:
        return ""
    return text[-digits:] if len(text) >= digits else text

@lru_cache(maxsize=8192)
def _extract_year_text_cached(text: str) -> int | str:
    if not text:
        return ""

    year_only_match = re.fullmatch(r"(19|20)\d{2}", text)
    if year_only_match:
        return int(text)

    leading_year_match = re.match(r"^\s*((19|20)\d{2})(?=[^\d]|$)", text)
    if leading_year_match:
        return int(leading_year_match.group(1))

    trailing_year_match = re.search(r"(?<!\d)((19|20)\d{2})(?!\d)", text)
    if trailing_year_match and len(text) <= 10:
        return int(trailing_year_match.group(1))

    dt = pd.to_datetime(text, errors="coerce")
    if pd.notna(dt):
        return int(dt.year)

    if trailing_year_match:
        return int(trailing_year_match.group(1))

    return ""

def _extract_year(value: Any) -> int | str:
    if isinstance(value, pd.Timestamp):
        if pd.isna(value):
            return ""
        return int(value.year)
    if isinstance(value, datetime):
        return int(value.year)
    if isinstance(value, date):
        return int(value.year)
    if isinstance(value, int):
        return value if 1900 <= value <= 2100 else ""
    if isinstance(value, float):
        if pd.isna(value):
            return ""
        if value.is_integer():
            year = int(value)
            return year if 1900 <= year <= 2100 else ""
        return ""
    if pd.isna(value):
        return ""

    text = _safe_string(value)
    if not text:
        return ""
    return _extract_year_text_cached(text)

def _co_date_to_actual_settlement_date(co_date: Any) -> str:
    text = _safe_string(co_date)
    if not text:
        return ""

    dt = pd.to_datetime(text, errors="coerce")
    if pd.isna(dt):
        return ""

    actual = dt + pd.offsets.MonthBegin(1) + pd.offsets.MonthEnd(1)
    return actual.strftime("%Y-%m-%d")

def _format_iso_date_or_blank(value: Any) -> str:
    dt = _normalize_date_value(value)
    return dt.strftime("%Y-%m-%d") if dt is not None else ""

@lru_cache(maxsize=8192)
def _normalize_date_text_cached(text: str) -> pd.Timestamp | None:
    if not text:
        return None
    dt = pd.to_datetime(text, errors="coerce")
    if pd.isna(dt):
        return None
    return pd.Timestamp(dt).normalize()

def _normalize_date_value(value: Any) -> pd.Timestamp | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.normalize()
    if isinstance(value, datetime):
        return pd.Timestamp(value).normalize()
    if isinstance(value, date):
        return pd.Timestamp(value).normalize()
    return _normalize_date_text_cached(_safe_string(value))

def _normalize_amount_key(value: Any) -> float:
    return round(_safe_number(value), 2)

def _normalize_text_key(value: Any) -> str:
    return _safe_string(value).upper()

def _has_digits(value: Any) -> bool:
    return any(ch.isdigit() for ch in _safe_string(value))

def _contains_general_condition(value: Any) -> bool:
    return "GENERAL CONDITION" in _normalize_text_key(value)

def _normalize_header_token(value: Any) -> str:
    text = _safe_string(value).upper()
    return re.sub(r"[^A-Z0-9\u4e00-\u9fff]+", "", text)

def _find_col_in_headers(df: pd.DataFrame, *candidates: str) -> int | None:
    wanted = {_normalize_header_token(item) for item in candidates}
    for idx, col in enumerate(df.columns, start=1):
        if _normalize_header_token(col) in wanted:
            return idx
    return None

def _find_col_in_row(df: pd.DataFrame, row_idx_0: int, *candidates: str) -> int | None:
    wanted = {_normalize_header_token(item) for item in candidates}
    for idx in range(1, len(df.columns) + 1):
        if _normalize_header_token(_get_cell(df, row_idx_0, idx)) in wanted:
            return idx
    return None

def _sheet_key(sheet_map: Mapping[str, pd.DataFrame], target: str) -> str:
    if target in sheet_map:
        return target
    lower = target.strip().lower()
    for key in sheet_map.keys():
        if key.strip().lower() == lower:
            return key
    raise KeyError(f"缺少工作表: {target}")

def _ensure_column_count(df: pd.DataFrame, min_cols: int) -> pd.DataFrame:
    out = df.copy()
    while len(out.columns) < min_cols:
        base = f"Unnamed_{len(out.columns) + 1}"
        name = base
        n = 2
        while name in out.columns:
            name = f"{base}_{n}"
            n += 1
        out[name] = ""
    return out

def _ensure_row_count(df: pd.DataFrame, min_rows: int) -> pd.DataFrame:
    out = df.copy()
    if len(out) >= min_rows:
        return out
    add_n = min_rows - len(out)
    fill = pd.DataFrame([{col: "" for col in out.columns}] * add_n)
    out = pd.concat([out, fill], ignore_index=True)
    return out

def _get_cell(df: pd.DataFrame, row_idx_0: int, col_idx_1: int) -> Any:
    col_idx_0 = col_idx_1 - 1
    if row_idx_0 < 0 or row_idx_0 >= len(df):
        return ""
    if col_idx_0 < 0 or col_idx_0 >= len(df.columns):
        return ""
    return df.iat[row_idx_0, col_idx_0]

def _column_values_1based(df: pd.DataFrame, col_idx_1: int) -> List[Any]:
    if len(df) == 0:
        return []
    col_idx_0 = col_idx_1 - 1
    if col_idx_0 < 0 or col_idx_0 >= len(df.columns):
        return [""] * len(df)
    return df.iloc[:, col_idx_0].tolist()

def _set_cell(df: pd.DataFrame, row_idx_0: int, col_idx_1: int, value: Any) -> pd.DataFrame:
    out = _ensure_column_count(df, col_idx_1)
    out = _ensure_row_count(out, row_idx_0 + 1)
    col_name = out.columns[col_idx_1 - 1]
    if str(out[col_name].dtype) != "object":
        out[col_name] = out[col_name].astype(object)
    out.iat[row_idx_0, col_idx_1 - 1] = value
    return out

def _sheet_delta_stats(before_df: pd.DataFrame, after_df: pd.DataFrame) -> Dict[str, int]:
    before = _cloud_view(before_df)
    after = _cloud_view(after_df)
    all_cols = list(dict.fromkeys(list(before.columns) + list(after.columns)))

    before_n = before.reindex(columns=all_cols).astype("string").fillna("")
    after_n = after.reindex(columns=all_cols).astype("string").fillna("")

    max_rows = max(len(before_n), len(after_n))
    before_n = before_n.reindex(range(max_rows), fill_value="")
    after_n = after_n.reindex(range(max_rows), fill_value="")

    diff_mask = before_n.ne(after_n)
    return {
        "changed_rows": int(diff_mask.any(axis=1).sum()),
        "changed_cells": int(diff_mask.sum().sum()),
    }

def _values_equal(left: Any, right: Any, tol: float = 1e-9) -> bool:
    ln = _to_float(left)
    rn = _to_float(right)
    if ln is not None and rn is not None:
        return abs(ln - rn) <= tol
    return _safe_string(left) == _safe_string(right)

def _chunked(items: Sequence[dict], size: int) -> Iterable[Sequence[dict]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]

def _contiguous_segments(indices: List[int]) -> List[Tuple[int, int]]:
    if not indices:
        return []
    sorted_idx = sorted(set(indices))
    segments: List[Tuple[int, int]] = []
    start = sorted_idx[0]
    prev = sorted_idx[0]
    for idx in sorted_idx[1:]:
        if idx == prev + 1:
            prev = idx
            continue
        segments.append((start, prev))
        start = idx
        prev = idx
    segments.append((start, prev))
    return segments

def _slugify_sheet_name(sheet: str) -> str:
    out = []
    for ch in sheet:
        if ch.isalnum() or ch in ("-", "_"):
            out.append(ch)
        else:
            out.append("_")
    return "".join(out)[:80] or "sheet"

def _normalize_label(text: Any) -> str:
    return re.sub(r"\s+", " ", _safe_string(text)).strip().lower()

def _grid_cell(rows: Sequence[Sequence[Any]], row_1: int, col_1: int) -> str:
    if row_1 < 1 or row_1 > len(rows):
        return ""
    row = rows[row_1 - 1]
    if col_1 < 1 or col_1 > len(row):
        return ""
    return _safe_string(row[col_1 - 1])

def _find_first_row(rows: Sequence[Sequence[Any]], predicate) -> int | None:
    for i, row in enumerate(rows, start=1):
        if predicate(i, row):
            return i
    return None

def _find_rows_by_item_label(
    rows: Sequence[Sequence[Any]],
    item_col_1: int = 3,
) -> Dict[str, List[int]]:
    out: Dict[str, List[int]] = {}
    for row_i in range(1, len(rows) + 1):
        label = _normalize_label(_grid_cell(rows, row_i, item_col_1))
        if not label:
            continue
        out.setdefault(label, []).append(row_i)
    return out
