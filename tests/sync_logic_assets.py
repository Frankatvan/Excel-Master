import sys
import os
import re

# 确保导入路径
sys.path.append(os.getcwd())

from check_finance import SHEET_109_NAME

def batch_update_check_finance():
    path = "check_finance.py"
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. 同步 E 列汇总 (SUM)
    content = content.replace('f\'=IFERROR(SUM(F{row_contract_amount}:K{row_contract_amount}),"")\'', 'f\'=SUM(F{row_contract_amount}:K{row_contract_amount})\'')
    content = content.replace('f\'=IFERROR(SUM(F{row_contract_change}:K{row_contract_change}),"")\'', 'f\'=SUM(F{row_contract_change}:K{row_contract_change})\'')
    content = content.replace('f\'=IFERROR(SUM(F{row_cogs_calc}:K{row_cogs_calc}),"")\'', 'f\'=SUM(F{row_cogs_calc}:K{row_cogs_calc})\'')
    content = content.replace('f\'=IFERROR(SUM(F{row_revenue_company}:K{row_revenue_company}),"")\'', 'f\'=SUM(F{row_revenue_company}:K{row_revenue_company})\'')
    content = content.replace('f\'=IFERROR(SUM(F{row_revenue_aud}:K{row_revenue_aud}),"")\'', 'f\'=SUM(F{row_revenue_aud}:K{row_revenue_aud})\'')
    content = content.replace('f\'=IFERROR(SUM(F{row_revenue}:K{row_revenue}),"")\'', 'f\'=SUM(F{row_revenue}:K{row_revenue})\'')
    content = content.replace('f\'=IFERROR(SUM(F{row_wbh_income}:K{row_wbh_income}),"")\'', 'f\'=SUM(F{row_wbh_income}:K{row_wbh_income})\'')

    # 2. 同步函数名大小写 (YEAR -> Year, ROUND -> round)
    content = content.replace('YEAR($K$2)', 'Year($K$2)')
    content = content.replace('ROUND(', 'round(')

    # 3. 同步核心逻辑公式 (POC, Gross Profit, Material Margin)
    content = content.replace('f"=IFERROR(ROUND(SUM(\$F\${row_cogs}:{col}{row_cogs})/{col}{row_budget},8),\\"\\")"', 'f\'=IFERROR(round({col}{row_cum_direct_cost}/{col}{row_budget},8),"")\'')
    content = content.replace('f"=IFERROR({col}{row_revenue_company}-{col}{row_cogs},\\"\\")"', 'f\'=IFERROR({col}{row_revenue_company}+{col}{row_cogs_calc},"")\'')
    content = content.replace('f"=IFERROR({col}{row_wbh_income}+{col}{row_wbh_cogs},\\"\\")"', 'f\'=IFERROR({col}{row_wbh_income}+{col}{row_wbh_cogs},"")\'')
    
    # 4. 同步 30 行 SUM (lowercase)
    content = content.replace('IFERROR(SUM($F${row_cogs_calc}:{col}{row_cogs_calc})-SUM($F${row_cogs}:{prev_col}{row_cogs}),"")', 'IFERROR(sum($F{row_cogs_calc}:{col}{row_cogs_calc})-SUM($F{row_cogs}:{prev_col}{row_cogs}),"")')

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("✅ check_finance.py 逻辑资产同步完成。")

if __name__ == "__main__":
    batch_update_check_finance()
