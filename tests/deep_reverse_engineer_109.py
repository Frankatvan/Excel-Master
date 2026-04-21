import sys
import os
import re
from typing import Dict, List, Tuple

# 确保导入路径
sys.path.append(os.getcwd())

from finance_mapping import ExcelSemanticMapper
from check_finance import get_sheets_service, SHEET_109_NAME, _build_109_formula_plan_from_grid

def deep_reverse_engineer():
    service = get_sheets_service()
    spreadsheet_id = os.getenv("SPREADSHEET_ID")
    
    # 1. 获取全量数据和公式
    # 读取 A:ZZ 以覆盖所有可能的引用
    resp = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=f"{SHEET_109_NAME}!A:ZZ", 
        valueRenderOption="FORMULA").execute()
    rows = resp.get('values', [])
    
    # 2. 建立语义映射
    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(rows) # 这里 rows 包含了公式，scan_sheet 会处理
    
    row_to_raw_label = {}
    for idx, row in enumerate(rows):
        label = ""
        if len(row) > 2 and row[2]: label = row[2]
        elif len(row) > 0 and row[0]: label = row[0]
        row_to_raw_label[idx+1] = label

    # 3. 获取代码库的“理论计划”
    # 我们模拟 check_finance.py 内部生成的 plan
    code_plan_list, _ = _build_109_formula_plan_from_grid(rows)
    # 转为字典以便比对： {(cell): formula}
    code_plan = {item['cell']: item['formula'] for item in code_plan_list}

    print("\n" + "="*60)
    print("🔍 109 表深度逆向工程：Excel 手动修改项 vs 代码逻辑")
    print("="*60 + "\n")

    diff_count = 0
    
    # 扫描 E, F, G 列 (Index 4, 5, 6)
    for col_idx in [4, 5, 6]:
        col_char = chr(ord('A') + col_idx)
        for row_idx, row_data in enumerate(rows):
            row_num = row_idx + 1
            if len(row_data) <= col_idx: continue
            
            excel_formula = str(row_data[col_idx])
            cell_ref = f"{col_char}{row_num}"
            
            # 只对比含有公式或代码预期有公式的地方
            expected_formula = code_plan.get(cell_ref)
            
            # 标准化比对 (去空格)
            if expected_formula and excel_formula.replace(" ","") != expected_formula.replace(" ",""):
                diff_count += 1
                
                # 语义化解析 Excel 里的公式
                def cell_replacer(match):
                    r_col = match.group(1)
                    r_row = int(match.group(2))
                    label = row_to_raw_label.get(r_row, f"Row{r_row}")
                    return f"[{label}]"
                
                semantic_excel = re.sub(r"([A-Z]+)(\d+)", cell_replacer, excel_formula)
                
                print(f"📍 发现变动：单元格 {cell_ref} ({row_to_raw_label.get(row_num, '未知')})")
                print(f"   - Excel 实时公式: {excel_formula}")
                print(f"   - 语义化解析:     {semantic_excel}")
                print(f"   - 代码库预期逻辑: {expected_formula}")
                print("-" * 40)

    if diff_count == 0:
        print("✅ 未发现逻辑差异。")
    else:
        print(f"\n📢 扫描完毕：共检测到 {diff_count} 处手动修改。")

if __name__ == "__main__":
    deep_reverse_engineer()
