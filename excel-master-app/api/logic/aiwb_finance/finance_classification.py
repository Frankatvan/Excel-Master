from __future__ import annotations

from typing import Any, Dict, List, Mapping, Tuple

import pandas as pd
from .finance_services import ClassificationService, RULE_REGISTRY, ClassificationDecision
from . import finance_engine as fe
from . import finance_utils as fu

def _get_classification_service(sheet_map: Mapping[str, pd.DataFrame]) -> ClassificationService:
    dependencies = {
        "_build_unit_budget_schedule_map": fe._build_unit_budget_schedule_map,
        "_contains_general_condition": fu._contains_general_condition,
        "_ensure_column_count": fu._ensure_column_count,
        "_extract_tail_int": fu._extract_tail_int,
        "_find_col_in_headers": fu._find_col_in_headers,
        "_find_col_in_row": fu._find_col_in_row,
        "_get_cell": fu._get_cell,
        "_has_digits": fu._has_digits,
        "_load_default_unit_budget_schedule_overrides": fe._load_default_unit_budget_schedule_overrides,
        "_normalize_amount_key": fu._normalize_amount_key,
        "_normalize_date_value": fu._normalize_date_value,
        "_normalize_text_key": fu._normalize_text_key,
        "_safe_string": fu._safe_string,
        "_sheet_key": fu._sheet_key,
        "_to_float": fu._to_float,
    }
    return ClassificationService(sheet_map, dependencies)

def compute_payable_classifications(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[List[str], Dict[str, Any]]:
    service = _get_classification_service(sheet_map)
    results = service.compute()
    return results["payable_categories"], results["payable_extra"]

def compute_final_detail_classifications(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[List[str], Dict[str, Any]]:
    service = _get_classification_service(sheet_map)
    results = service.compute()
    return results["final_detail_categories"], results["final_detail_extra"]
