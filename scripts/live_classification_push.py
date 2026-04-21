import os
import sys
import pandas as pd
import time
import argparse
from typing import Mapping, Callable, Dict, Any, List, Tuple
from datetime import datetime
from googleapiclient.errors import HttpError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import finance_utils as utils
import finance_engine as engine
from finance_services import ClassificationService, ClassificationDecision

SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw")

def setup():
    """通用设置：获取 Google Sheets 服务和依赖项"""
    print("Setting up services and dependencies...")
    service = utils.get_sheets_service()
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
    return service, deps

def fetch_sheet_mapping(service, spreadsheet_id: str, sheets_to_fetch: List[str]):
    sheet_map = {}
    print(f"Fetching {', '.join(sheets_to_fetch)}...")
    ranges = [utils._quote_sheet_name(name) for name in sheets_to_fetch]
    resp = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id, ranges=ranges, valueRenderOption="FORMATTED_VALUE"
    ).execute()
    
    value_ranges = resp.get("valueRanges", [])
    for i, name in enumerate(sheets_to_fetch):
        matrix = value_ranges[i].get("values", []) if i < len(value_ranges) else []
        df = utils._values_to_dataframe(utils._trim_display_and_formula_matrices(matrix, [])[0])
        sheet_map[name] = df
        print(f"  - Fetched {name}: {len(df)} rows")
    return sheet_map

def step_reclassify(service, deps):
    """步骤 2：成本重分类"""
    print("\n--- Running Step: Reclassify ---")
    sheets_to_fetch = ["Payable", "Scoping", "Final Detail", "Unit Budget", "Unit Master"]
    sheet_map = fetch_sheet_mapping(service, SPREADSHEET_ID, sheets_to_fetch)
    
    cls_service = ClassificationService(sheet_map, deps)
    print("Computing classifications...")
    results = cls_service.compute()
    
    # 准备更新
    payable_updates = [{"range": f"Payable!A{i+2}:B{i+2}", "values": [[str(dec.category or 'N/A'), str(dec.rule_id or 'N/A')]]} for i, dec in enumerate(results["payable_decisions"])]
    final_detail_updates = [{"range": f"'Final Detail'!A{i+2}:B{i+2}", "values": [[str(dec.category or 'N/A'), str(dec.rule_id or 'N/A')]]} for i, dec in enumerate(results["final_detail_decisions"])]
    
    all_updates = payable_updates + final_detail_updates
    _execute_batch_update(service, all_updates)
    
    # 打印统计
    print("\n" + "="*40 + "\nRULE ID DISTRIBUTION\n" + "="*40)
    for sheet_name, decisions in [("Payable", results["payable_decisions"]), ("Final Detail", results["final_detail_decisions"])]:
        print(f"\n--- {sheet_name} ---")
        counts = pd.Series([d.rule_id for d in decisions]).value_counts().sort_index()
        print(pd.DataFrame({"Rule ID": counts.index, "Count": counts.values}).to_string(index=False))

def step_formula_sync(service, deps):
    """步骤 3：109 表公式注入"""
    print("\n--- Running Step: Formula Sync ---")
    try:
        plan_109, meta_109 = engine.generate_109_formula_plan(service, SPREADSHEET_ID)
        results_109 = engine.execute_109_formula_plan(service, SPREADSHEET_ID, plan_109)
        verify = results_109.get("verify", {})
        print(f"109 Formula sync complete: {results_109.get('updated_ranges', 0)} formulas updated.")
        print(f"  Verification: {verify.get('matched', 0)}/{verify.get('total', 0)} formulas verified.")
        if verify.get("mismatches"):
            print(f"  WARNING: {len(verify['mismatches'])} mismatches detected in verification.")
    except Exception as e:
        print(f"109 Formula sync failed: {e}")

def _execute_batch_update(service, updates):
    total_chunks = (len(updates) + 399) // 400
    print(f"Pushing {len(updates)} cell updates to Google Sheets in {total_chunks} chunks...")
    
    for i in range(0, len(updates), 400):
        chunk = updates[i:i + 400]
        # ... (包含重试逻辑的 batchUpdate 调用)
        service.spreadsheets().values().batchUpdate(
            spreadsheetId=SPREADSHEET_ID,
            body={"valueInputOption": "USER_ENTERED", "data": chunk}
        ).execute()
        time.sleep(1)
    print("Batch update complete.")


def main():
    parser = argparse.ArgumentParser(description="分步执行 AiWB 数据同步与核算任务。")
    parser.add_argument("--step", choices=['reclassify', 'formula'], required=True, help="要执行的步骤：'reclassify' (成本重分类) 或 'formula' (109表公式注入)。")
    args = parser.parse_args()

    print(f"Starting AiWB job for Spreadsheet ID: {SPREADSHEET_ID}")
    service, deps = setup()

    if args.step == 'reclassify':
        step_reclassify(service, deps)
    elif args.step == 'formula':
        step_formula_sync(service, deps)

if __name__ == "__main__":
    main()
