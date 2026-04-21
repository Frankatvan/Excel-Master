# Spec: BudgetCO Semantic Refactor

## 1. 目标
将 BudgetCO 表的逻辑完全接入 Cross-Sheet Semantic Framework。解决该表因频繁增删分包行导致的汇总坐标（Savings, Contingency, EAC）失效问题。

## 2. 逻辑注入 (check_finance.py)

### 2.1 变量替换清单
在 `process_budgetco_summary` (或同类函数) 中：
- 替换硬编码行号：
  - `row_savings` -> `mapper.get_row("Total Savings Identified")`
  - `row_contingency` -> `mapper.get_row("Owner Contingency")`
  - `row_total_eac` -> `mapper.get_row("Total Budget (EAC)")`

### 2.2 跨列逻辑
- 使用 `FinanceFormulaGenerator` 基于 `G` 列起始列生成汇总公式。
- 公式定义：`EAC = Sum(Subcontract_Lines) - Savings + Contingency` (根据业务标签动态构建)。

## 3. 验收方案 (tests/test_budgetco_integration.py)
```python
import unittest
from finance_mapping import MapperFactory

class BudgetCOIntegrationTest(unittest.TestCase):
    def test_budgetco_row_discovery(self):
        mock_values = [[""] * 5 for _ in range(100)]
        # B列 (Index 1) 注入标签
        mock_values[34][1] = "Total Savings Identified"
        mock_values[39][1] = "Owner Contingency"
        
        mapper = MapperFactory.create("BudgetCO", mock_values)
        self.assertEqual(mapper.get_row("Total Savings Identified"), 35)
        self.assertEqual(mapper.get_row("Owner Contingency"), 40)
```

## 4. 交付协议
1. Codex 在 `check_finance.py` 中定位 `BudgetCO` 处理逻辑。
2. 注入 `MapperFactory` 初始化代码。
3. 替换所有 `row_xxx = int` 的硬编码赋值。
4. 运行 `tests/test_budgetco_integration.py`。
