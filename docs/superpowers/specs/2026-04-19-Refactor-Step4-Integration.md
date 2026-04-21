# Spec: Final Integration (Refactor Step 4)

## 1. 目标
将 `ExcelSemanticMapper` 与 `FinanceFormulaGenerator` 正式注入 `check_finance.py`，替换原有的硬编码行号逻辑，实现 109 表的动态公式更新。

## 2. 修改逻辑 (check_finance.py)

### 2.1 模块导入
在 `check_finance.py` 头部导入新模块：
```python
from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator
```

### 2.2 逻辑注入点 (建议新增一个高层协调函数)
我们将新增一个 `update_109_semantic_logic` 函数，它将执行以下工作：

1. **获取数据**：调用 `service.spreadsheets().values().get` 获取 109 表 A:C 列的数据。
2. **初始化引擎**：
   ```python
   mapper = ExcelSemanticMapper()
   mapper.scan_sheet(values)
   gen = FinanceFormulaGenerator(mapper)
   ```
3. **批量公式生成**：调用 `gen.generate_column_range("F", "V")` (假设 V 是当前列边界)。
4. **构造更新请求**：将生成的 EAC, POC, Confirmed COGS 转化为 `ValueRange` 对象。

### 2.3 关键函数替换清单
* **替换 `_find_material_margin_rows_109`**：该函数目前可能在手动查找行号，应改为使用 `mapper.get_row()`。
* **重构逻辑流**：在主流程中，确保先运行 `Mapper.scan` 之后再处理任何涉及公式生成的步骤。

## 3. 安全验收方案
集成后，由于 `check_finance.py` 过于庞大，我们采用**影子测试 (Shadow Run)**：
1. 运行 `check_finance.py` 并打印生成的 `Update Requests`。
2. 随机抽取 3 个坐标（如 F23, G30, H45），检查其公式是否与我们单元测试中的“精确断言”一致。

## 4. 交付协议
1. Codex 在 `check_finance.py` 中**顶部导入**新类。
2. Codex 在适当位置（通常在 L2100 附近的逻辑入口）插入 `Mapper` 初始化代码。
3. Codex 将原有的硬编码变量替换为动态获取的值。
