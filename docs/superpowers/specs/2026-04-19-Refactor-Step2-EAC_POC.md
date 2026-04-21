# Spec: EAC & POC Dynamic Linkage (Refactor Step 2)

## 1. 目标
实现基于语义标签的财务公式自动生成器。解决 EAC (Estimate at Completion) 与 POC (Percentage of Completion) 在跨列计算时的公式漂移问题。

## 2. 逻辑组件 (finance_formulas.py)

```python
from finance_mapping import ExcelSemanticMapper

class FinanceFormulaGenerator:
    """
    财务公式生成器：将语义逻辑转化为 Excel/GSheets 公式。
    """
    def __init__(self, mapper: ExcelSemanticMapper):
        self.mapper = mapper

    def get_eac_formula(self, col: str):
        """
        生成 EAC 公式：EAC = Initial Budget - Savings + Overrun
        """
        ref_initial = self.mapper.get_ref("Initial Budget (Original Contract Sum)", col)
        ref_savings = self.mapper.get_ref("Cumulative Savings (Target vs Actual)", col)
        ref_overrun = self.mapper.get_ref("Owner-unapproved Overrun", col)
        
        # 安全处理：使用 N() 函数确保空值转为 0，防止数学运算报错
        return f"=N({ref_initial}) - N({ref_savings}) + N({ref_overrun})"

    def get_poc_formula(self, col: str):
        """
        生成 POC 公式：POC = Confirmed COGS / EAC
        """
        ref_cogs = self.mapper.get_ref("Confirmed COGS (Current Period)", col)
        ref_eac  = self.mapper.get_ref("Current Dynamic EAC (Total Cost)", col)
        
        # 嵌套 IFERROR 处理除以零或空值
        return f"=IFERROR(N({ref_cogs}) / NULLIFZERO({ref_eac}), 0)"
        
        # 注：NULLIFZERO 是逻辑表达，实际生成如下：
        return f"=IFERROR(IF(N({ref_eac})=0, 0, N({ref_cogs}) / N({ref_eac})), 0)"

    def generate_column_range(self, start_col_char: str, end_col_char: str):
        """
        批量生成指定列范围的更新计划。
        """
        columns = self._get_column_range(start_col_char, end_col_char)
        plan = {}
        
        for col in columns:
            plan[col] = {
                "EAC": self.get_eac_formula(col),
                "POC": self.get_poc_formula(col)
            }
        return plan

    def _get_column_range(self, start, end):
        """生成 A-Z 范围内的列字母列表"""
        return [chr(i) for i in range(ord(start), ord(end) + 1)]
```

## 3. 验证方案 (tests/test_formula_generator.py)

```python
import pytest
from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator

def test_formula_generation_logic():
    # 1. 准备 Mock Mapper
    mock_values = [[""] * 5 for _ in range(50)]
    mock_values[22][2] = "Initial Budget (Original Contract Sum)" # Row 23
    mock_values[23][2] = "Cumulative Savings (Target vs Actual)" # Row 24
    mock_values[24][2] = "Owner-unapproved Overrun"             # Row 25
    mock_values[29][2] = "Current Dynamic EAC (Total Cost)"      # Row 30
    mock_values[39][2] = "Confirmed COGS (Current Period)"       # Row 40
    
    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(mock_values)
    
    gen = FinanceFormulaGenerator(mapper)
    
    # 2. 验证 EAC 公式 (F列)
    eac_f = gen.get_eac_formula("F")
    assert "F23" in eac_f
    assert "F24" in eac_f
    assert "F25" in eac_f
    
    # 3. 验证 POC 公式 (G列)
    poc_g = gen.get_poc_formula("G")
    assert "G40" in poc_g
    assert "G30" in poc_g
    assert "IFERROR" in poc_g
    
    # 4. 验证批量生成
    range_plan = gen.generate_column_range("F", "H")
    assert len(range_plan) == 3
    assert "H" in range_plan
    
    print("\n✅ Formula Logic Verification Passed.")
```

## 4. 交付协议
1. Codex 创建 `finance_formulas.py`。
2. Codex 创建 `tests/test_formula_generator.py`。
3. CLI 运行测试验证公式字符串的准确性。
