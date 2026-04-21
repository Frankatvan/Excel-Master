# Spec: Project Ledger Semantic Refactor

## 1. 目标
将 Project Ledger 表的对账与汇总逻辑接入通用语义框架。解决支出流水行增减导致的汇总值（Total Actuals, Accrual Adjustments）引用错误。

## 2. 配置扩展 (docs/finance_semantic_config.yaml)
```yaml
  "Project Ledger":
    label_col_idx: 0  # 假设 Ledger 的标签在 A 列
    data_start_col: "H"
    labels:
      total_actuals: "Total Actual Expenditure"
      accrual_adj: "Accrual Adjustments"
```

## 3. 逻辑注入 (check_finance.py)
- 在 `process_project_ledger` (或同类函数) 中初始化 `MapperFactory.create("Project Ledger", ledger_values)`。
- 替换所有物理行引用。
- 建立“对账公式”：`Ledger_Total == 109_Cumulative_Cost` (影子校验逻辑)。

## 4. 交付验收
- 运行 `tests/test_ledger_integration.py` 验证 Ledger 的 A 列标签识别。
- 确认三表（109, BudgetCO, Ledger）现在共享同一套工厂模式。
