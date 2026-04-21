import sys
import os

# 确保导入路径
sys.path.append(os.getcwd())

from check_finance import get_sheets_service, generate_109_formula_plan, _verify_formula_plan

def shadow_dry_run():
    spreadsheet_id = os.getenv("SPREADSHEET_ID")
    service = get_sheets_service()
    
    print("🚀 正在启动 109 表影子同步 dry-run...")
    
    # 1. 生成计划
    # 注意：generate_109_formula_plan 内部会尝试自动获取 spreadsheet_id，
    # 我们确保环境变量已设置
    plan, meta = generate_109_formula_plan(spreadsheet_id)
    print(f"✅ 已生成公式计划：包含 {meta['formula_count']} 条规则")
    
    # 2. 执行实读对账
    verify = _verify_formula_plan(service, spreadsheet_id, plan)
    
    matched = verify['matched']
    total = verify['total']
    mismatches = verify['mismatches']
    
    print("\n" + "="*50)
    print("📊 109 表数据一致性检查结果")
    print("="*50)
    
    if matched == total:
        print(f"\n🎉 完美匹配！代码逻辑与 Excel 现状 100% 重合 ({matched}/{total})。")
        print("💡 结论：重跑 109 表，数据将【完全不会改变】。")
    else:
        print(f"\n⚠️ 发现 {total - matched} 处差异。")
        print("如果现在执行同步，以下坐标的数据/公式将发生变化：")
        for m in mismatches[:10]:
            print(f"📍 {m['range']}:")
            print(f"   - Excel 实时公式: {m['actual']}")
            print(f"   - 代码生成的公式: {m['expected']}")
        if len(mismatches) > 10:
            print(f"... 还有 {len(mismatches) - 10} 处差异。")
            
    print("="*50)

if __name__ == "__main__":
    shadow_dry_run()
