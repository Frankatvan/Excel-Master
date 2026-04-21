import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator

def test_cogs_layering_logic():
    # 1. 准备 Mock Mapper
    # 模拟一个 60 行的数据表，并在特定行设置标签
    mock_values = [[""] * 5 for _ in range(60)]
    # Row 45 (index 44)
    mock_values[44][2] = "Audit Adjustment (Current Period)"
    # Row 50 (index 49)
    mock_values[49][2] = "Cumulative Total Cost (Actual)"
    # Row 55 (index 54)
    mock_values[54][2] = "Cumulative Confirmed COGS (Prior Period)"
    
    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(mock_values)
    gen = FinanceFormulaGenerator(mapper)
    
    # 2. 验证 F 列公式生成
    f_formula = gen.get_confirmed_cogs_formula("F")
    
    # 断言 1：必须包含 IF 判断，检查引用的行号是否正确 (45)
    assert 'IF(F45<>""' in f_formula
    # 断言 2：必须包含审计值引用 F45
    assert 'F45' in f_formula
    # 断言 3：计算部分必须正确减法且带 N()，检查引用的行号 (50 和 55)
    assert 'N(F50) - N(F55)' in f_formula
    
    print(f"\nGenerated Formula: {f_formula}")
    print("✅ COGS Audit Priority Logic Verification Passed.")

if __name__ == "__main__":
    test_cogs_layering_logic()
