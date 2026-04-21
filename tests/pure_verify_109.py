import sys
import os

# 确保导入路径
sys.path.append(os.getcwd())

from check_finance import get_sheets_service, SHEET_109_NAME, _build_109_formula_plan_from_grid, _verify_formula_plan

def pure_verify():
    sid = os.getenv("SPREADSHEET_ID")
    service = get_sheets_service()
    
    # 使用正确的参数名: spreadsheetId
    resp = service.spreadsheets().values().get(
        spreadsheetId=sid, 
        range=f"{SHEET_109_NAME}!A:ZZ",
        valueRenderOption="FORMULA"
    ).execute()
    rows = resp.get('values', [])
    
    plan, _ = _build_109_formula_plan_from_grid(rows)
    verify = _verify_formula_plan(service, sid, plan)
    
    print(f"\n📊 109 表逻辑对账结果: {verify['matched']}/{verify['total']} 匹配")
    
    if verify['mismatches']:
        print("\n❌ 发现差异 (前 5 处):")
        for m in verify['mismatches'][:5]:
            print(f"📍 {m['range']}: Excel[{m['actual']}] vs Code[{m['expected']}]")
    else:
        print("\n🎉 100% 匹配！数据不会发生任何变化。")

if __name__ == "__main__":
    pure_verify()
