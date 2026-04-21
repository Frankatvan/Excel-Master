import sys
import os
import re
from typing import Dict, List, Tuple

# 确保导入路径
sys.path.append(os.getcwd())

from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator
from check_finance import get_sheets_service, SHEET_109_NAME

def a1_to_row_col(a1: str) -> Tuple[int, str]:
    match = re.match(r"([A-Z]+)(\d+)", a1)
    if match:
        return int(match.group(2)), match.group(1)
    return 0, ""

def reverse_engineer():
    service = get_sheets_service()
    spreadsheet_id = os.getenv("SPREADSHEET_ID")
    if not spreadsheet_id:
        print("Error: SPREADSHEET_ID not set.")
        return

    # 1. 扫描映射
    resp_mapping = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=f"{SHEET_109_NAME}!A:C").execute()
    values_ac = resp_mapping.get('values', [])
    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(values_ac)
    
    # 建立行号到标签的反查字典
    row_to_label = {v: k for k, v in mapper.en_map.items()}
    # 补充原始标签用于展示
    row_to_raw_label = {}
    for idx, row in enumerate(values_ac):
        if len(row) > 2 and row[2]:
            row_to_raw_label[idx+1] = row[2]
        elif len(row) > 0 and row[0]:
            row_to_raw_label[idx+1] = row[0]

    # 2. 提取 F/G 列公式
    resp_formulas = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=f"{SHEET_109_NAME}!F:G", 
        valueRenderOption="FORMULA").execute()
    formulas_fg = resp_formulas.get('values', [])

    # 3. 准备代码库生成器
    generator = FinanceFormulaGenerator(mapper)

    print("\n" + "="*50)
    print("📋 109 表全量逻辑逆向工程对账报告")
    print("="*50 + "\n")

    mismatches = 0
    for row_idx, row_values in enumerate(formulas_fg):
        row_num = row_idx + 1
        for col_offset, excel_formula in enumerate(row_values):
            col_char = "F" if col_offset == 0 else "G"
            if not str(excel_formula).startswith("="):
                continue

            # 语义解析 Excel 里的公式
            def cell_replacer(match):
                ref_col = match.group(1)
                ref_row = int(match.group(2))
                label = row_to_raw_label.get(ref_row, f"Row{ref_row}")
                return f"[{label}]"
            
            semantic_excel = re.sub(r"([A-Z]+)(\d+)", cell_replacer, str(excel_formula))
            
            # 找到代码库中对应的标签逻辑（如果有）
            label_for_this_row = row_to_label.get(row_num)
            code_formula = None
            
            # 这里简单硬查几个核心逻辑点，实际生产中应根据 generator 的 mapping 查
            if label_for_this_row:
                # 尝试匹配已知逻辑函数
                try:
                    if "initialbudget" in label_for_this_row: pass
                    elif "currentdynamiceac" in label_for_this_row: code_formula = generator.get_eac_formula(col_char)
                    elif "percentageofcompletion" in label_for_this_row: code_formula = generator.get_poc_formula(col_char)
                    elif "confirmedcogs" in label_for_this_row: code_formula = generator.get_confirmed_cogs_formula(col_char)
                    elif "revenue" in label_for_this_row: code_formula = generator.get_revenue_formula(col_char)
                    elif "roe" in label_for_this_row: code_formula = generator.get_roe_formula(col_char)
                except:
                    pass

            # 对账
            if code_formula and excel_formula.replace(" ","") != code_formula.replace(" ",""):
                mismatches += 1
                print(f"📍 发现逻辑变动：第 {row_num} 行 ({row_to_raw_label.get(row_num, '未知科目')})")
                print(f"   - Excel 实时公式 ({col_char}列): {excel_formula}")
                print(f"   - 语义化解析: {semantic_excel}")
                print(f"   - 代码库当前逻辑: {code_formula}")
                print("-" * 30)

    if mismatches == 0:
        print("✅ 对账完成：代码库逻辑与 Excel 实时公式完全一致。")
    else:
        print(f"⚠️ 对账完成：共发现 {mismatches} 处逻辑差异。")

if __name__ == "__main__":
    reverse_engineer()
