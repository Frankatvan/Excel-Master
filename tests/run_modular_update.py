import os
import sys
import pandas as pd
from typing import Mapping, Callable, Dict, Any, Tuple, List

# Add root directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import finance_utils as utils
import finance_engine as engine
from finance_services import ClassificationService

# 1. Load SPREADSHEET_ID from secrets
SPREADSHEET_ID = "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw"

def fetch_sheet_mapping(service, spreadsheet_id: str):
    """Fetch basic sheet mapping (Payable, Scoping, Final Detail, Unit Budget)"""
    sheets_to_fetch = ["Payable", "Scoping", "Final Detail", "Unit Budget"]
    sheet_map = {}
    
    # We use a simple fetch logic similar to finance_ui.load_data
    ranges = [utils._quote_sheet_name(name) for name in sheets_to_fetch]
    resp = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id,
        ranges=ranges,
        valueRenderOption="FORMATTED_VALUE"
    ).execute()
    
    value_ranges = resp.get("valueRanges", [])
    for i, name in enumerate(sheets_to_fetch):
        matrix = value_ranges[i].get("values", []) if i < len(value_ranges) else []
        trimmed_display, _ = utils._trim_display_and_formula_matrices(matrix, [])
        df = utils._values_to_dataframe(trimmed_display)
        sheet_map[name] = df
        print(f"Fetched {name}: {len(df)} rows")
        
    return sheet_map

def main():
    # 2. Initialize get_sheets_service
    # We need to bypass st.secrets or provide them via environment
    os.environ["SPREADSHEET_ID"] = SPREADSHEET_ID
    # finance_utils.get_sheets_service uses _get_service_account_info which looks for credentials.json or secrets
    # Since credentials.json exists in the root, it should work.
    service = utils.get_sheets_service()
    
    # 3. Fetch basic sheet mapping
    print("Fetching sheet mapping...")
    sheet_map = fetch_sheet_mapping(service, SPREADSHEET_ID)
    
    # 4. Instantiate ClassificationService and run compute()
    print("Initializing ClassificationService...")
    deps = {
        "ensure_column_count": utils._ensure_column_count,
        "sheet_key": utils._sheet_key,
        "find_col_in_row": utils._find_col_in_row,
        "to_float": utils._to_float,
        "get_cell": utils._get_cell,
        "normalize_text_key": utils._normalize_text_key,
        "normalize_amount_key": utils._normalize_amount_key,
        "normalize_date_value": utils._normalize_date_value,
        "extract_tail_int": utils._extract_tail_int,
        "has_digits": utils._has_digits,
        "contains_general_condition": utils._contains_general_condition,
        "find_col_in_headers": utils._find_col_in_headers,
        "safe_string": utils._safe_string,
        "build_unit_budget_schedule_map": engine._build_unit_budget_schedule_map,
        "load_default_unit_budget_schedule_overrides": engine._load_default_unit_budget_schedule_overrides,
    }
    
    cls_service = ClassificationService(sheet_map, deps)
    print("Running compute()...")
    results = cls_service.compute()
    
    # 5. Call generate_109_formula_plan
    print("Calling generate_109_formula_plan...")
    # engine.generate_109_formula_plan(service, spreadsheet_id)
    plan_109, meta_109 = engine.generate_109_formula_plan(service, SPREADSHEET_ID)
    
    # 6. Print summary
    print("\n" + "="*40)
    print("MODULAR UPDATE SUMMARY")
    print("="*40)
    
    print("\nPayable Classification Counts:")
    p_counts = results["payable_extra"].get("classification_counts", {})
    for cat, count in sorted(p_counts.items()):
        print(f"  {cat}: {count}")
        
    print("\nFinal Detail Classification Counts:")
    f_counts = results["final_detail_extra"].get("classification_counts", {})
    for cat, count in sorted(f_counts.items()):
        print(f"  {cat}: {count}")
        
    print(f"\nRestore Hits: {results['restore_extra'].get('restore_hit_count', 0)}")
    
    print("\n109 Formula Plan Summary:")
    print(f"  Total Formulas: {len(plan_109)}")
    print(f"  Semantic Formulas: {meta_109.get('semantic_formula_count', 0)}")
    
    print("\nSample 109 Formulas (first 5):")
    for item in plan_109[:5]:
        print(f"  Range: {item.get('range')} -> Formula: {item.get('formula')}")
        
    print("\nRule ID counts (Payable):")
    rule_ids = results["payable_extra"].get("rule_ids", [])
    rule_counts = pd.Series(rule_ids).value_counts().to_dict()
    for rid, count in sorted(rule_counts.items()):
        print(f"  {rid}: {count}")

if __name__ == "__main__":
    main()
