# Spec: COGS Layering & Audit Priority (Refactor Step 3)

## 1. 目标
实现具有“审计优先级”的成本确认逻辑。确保当期确认成本（Confirmed COGS）在“审计手动调整”与“系统计算值”之间自动切换，并保持审计链条完整。

## 2. 逻辑组件 (finance_formulas.py 扩展)

我们需要在 `FinanceFormulaGenerator` 类中增加以下核心方法：

```python
    def get_confirmed_cogs_formula(self, col: str):
        """
        生成 Confirmed COGS 公式：
        逻辑：IF(审计调整不为空, 取审计调整, 累计总成本 - 以前年度确认总和)
        """
        ref_audit      = self.mapper.get_ref("Audit Adjustment (Current Period)", col)
        ref_cumulative = self.mapper.get_ref("Cumulative Total Cost (Actual)", col)
        ref_prev_sum   = self.mapper.get_ref("Cumulative Confirmed COGS (Prior Period)", col)
        
        # 核心逻辑：IF(Audit<>"", Audit, Cumulative - Prev)
        # 加上 N() 保护，防止空值导致的 #VALUE!
        calc_part = f"N({ref_cumulative}) - N({ref_prev_sum})"
        return f'=IF({ref_audit}<>"", {ref_audit}, {calc_part})'

    def get_cogs_audit_summary(self, col: str):
        """
        生成成本三层归集摘要：用于校验 Calc + Audit = Confirmed
        (可选，用于辅助审计页签)
        """
        pass 
```

## 3. 验证方案 (tests/test_cogs_logic.py)

```python
import pytest
from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator

def test_cogs_layering_logic():
    # 1. 准备 Mock Mapper
    mock_values = [[""] * 5 for _ in range(60)]
    mock_values[44][2] = "Audit Adjustment (Current Period)"          # Row 45
    mock_values[49][2] = "Cumulative Total Cost (Actual)"             # Row 50
    mock_values[54][2] = "Cumulative Confirmed COGS (Prior Period)"  # Row 55
    
    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(mock_values)
    gen = FinanceFormulaGenerator(mapper)
    
    # 2. 验证 F 列公式生成
    f_formula = gen.get_confirmed_cogs_formula("F")
    
    # 断言 1：必须包含 IF 判断
    assert 'IF(F45<>""' in f_formula
    # 断言 2：必须包含审计值引用
    assert 'F45' in f_formula.split(',')[-2] # 简单检查逻辑位置
    # 断言 3：计算部分必须正确减法且带 N()
    assert 'N(F50) - N(F55)' in f_formula
    
    print("\n✅ COGS Audit Priority Logic Verification Passed.")
```

## 4. 交付协议
1. Codex 在 `finance_formulas.py` 中**增量插入** `get_confirmed_cogs_formula` 方法。
2. Codex 创建 `tests/test_cogs_logic.py`。
3. CLI 运行测试验证 IF 嵌套逻辑的准确性。
