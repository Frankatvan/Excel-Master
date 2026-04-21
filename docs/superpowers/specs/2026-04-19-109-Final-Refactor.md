# Spec: 109 Final Refactor (Semantic Completeness)

## 1. 目标 (Goal)
实现 109 表计算与格式逻辑的 100% 语义化。消除所有剩余的硬编码行号，将 ROE, Revenue 等业务逻辑及 Formatting 样式全部绑定至 `ExcelSemanticMapper`，并为跨表治理（BudgetCO / Project Ledger）建立通用适配层。

## 2. 逻辑全覆盖：FinanceFormulaGenerator (finance_formulas.py)
在 `FinanceFormulaGenerator` 中新增方法，覆盖 Revenue 与 ROE 等逻辑：

```python
    def get_revenue_formula(self, col: str):
        """
        Revenue = POC * Total Revenue - Previous Revenue
        """
        ref_poc = self.mapper.get_ref("Percentage of Completion (POC)", col)
        ref_total_rev = self.mapper.get_ref("Total Estimated Revenue", col)
        ref_prev_rev = self.mapper.get_ref("Cumulative Revenue Recognized (Prior Period)", col)
        
        return f"=N({ref_poc}) * N({ref_total_rev}) - N({ref_prev_rev})"

    def get_roe_formula(self, col: str):
        """
        ROE = Revenue - Confirmed COGS
        """
        ref_rev = self.mapper.get_ref("Revenue Recognized (Current Period)", col)
        ref_cogs = self.mapper.get_ref("Confirmed COGS (Current Period)", col)
        
        return f"=N({ref_rev}) - N({ref_cogs})"
```
*(同时集成其他必要的成本层级计算，统一在 `generate_column_range` 批量输出中挂载。)*

## 3. 格式自动化：SemanticFormattingEngine (finance_formatting.py)
创建一个全新的独立模块 `finance_formatting.py`，专门处理基于语义标签的格式化请求，取代原先硬编码的 GridRange。

```python
from finance_mapping import ExcelSemanticMapper

class SemanticFormattingEngine:
    def __init__(self, mapper: ExcelSemanticMapper, sheet_id: int):
        self.mapper = mapper
        self.sheet_id = sheet_id
        
    def build_bold_row_request(self, label: str, start_col_idx: int = 4, end_col_idx: int = 25):
        """
        动态定位特定标签行，为其添加加粗样式。
        GSheets API 的列索引也是 0-based，E=4, Z=25
        """
        try:
            row_idx = self.mapper.get_row(label) - 1 # API row index is 0-based
        except KeyError:
            return None
            
        return {
            "repeatCell": {
                "range": {
                    "sheetId": self.sheet_id,
                    "startRowIndex": row_idx,
                    "endRowIndex": row_idx + 1,
                    "startColumnIndex": start_col_idx,
                    "endColumnIndex": end_col_idx
                },
                "cell": {
                    "userEnteredFormat": {
                        "textFormat": {"bold": True}
                    }
                },
                "fields": "userEnteredFormat.textFormat.bold"
            }
        }
```

## 4. 跨表治理通用接口层 (Cross-Sheet Governance)
`ExcelSemanticMapper` 已具备高度通用性，我们只需制定平移策略：
- **配置文件化**：将硬编码的英文字符串（"Current Dynamic EAC" 等）从代码中抽离，写入 `docs/AiWB_跨表字段映射_v0.1.yaml`，按表名区分 `[109, BudgetCO, ProjectLedger]`。
- **工厂模式**：引入 `MapperFactory.create_for_sheet("BudgetCO", values)`，基于对应配置表的关键词自动构建专用的语义映射上下文。

## 5. 交付验收
- 运行原有的单元测试，确保不退化。
- 增加格式化引擎的影子测试（提取 Request 判断其是否随标签漂移）。
