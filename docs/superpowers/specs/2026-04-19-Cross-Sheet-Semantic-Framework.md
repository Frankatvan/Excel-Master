# Spec: Cross-Sheet Semantic Framework

## 1. 目标
建立一套通用的、可复用的财务逻辑语义化框架，支持 109, BudgetCO, Project Ledger 等多表的平移治理。

## 2. 核心配置 (docs/finance_semantic_config.yaml)
```yaml
finance_sheets:
  "109":
    label_col_idx: 2  # C列
    data_start_col: "F"
    labels:
      eac: "Current Dynamic EAC (Total Cost)"
      poc: "Percentage of Completion (POC)"
      confirmed_cogs: "Confirmed COGS (Current Period)"
  "BudgetCO":
    label_col_idx: 1  # B列
    data_start_col: "G"
    labels:
      savings: "Total Savings Identified"
      contingency: "Owner Contingency"
      eac_summary: "Total Budget (EAC)"
```

## 3. 架构升级 (finance_mapping.py)
引入 `MapperFactory` 并增强 `ExcelSemanticMapper`：
- `scan_sheet` 支持自定义 `label_col_idx`。
- `MapperFactory` 负责读取 YAML 并返回配置好的 Mapper 实例。

## 4. 公式引擎平移 (finance_formulas.py)
增强 `FinanceFormulaGenerator`：
- 支持从配置中读取 `data_start_col`。
- 提供 `generate_generic_formula(label_key, col)` 接口，将 key 映射到 YAML 定义的真实标签。

## 5. 验收标准
- 运行 `tests/test_cross_sheet_factory.py` 验证不同 Sheet 名是否能返回正确的映射器。
- 验证 BudgetCO 的 G 列引用是否生成正确。
