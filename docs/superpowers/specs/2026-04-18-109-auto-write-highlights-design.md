# 109 Auto-Write And Highlight Design

日期：`2026-04-18`

## Goal
把 `109` 公式更新流程改成“生成后直接回写 Google Sheet”，不再要求用户二次确认；同时在 `109` 中用颜色区分“手工输入区”和“本次实际发生变更的公式区”，并在工作簿里追加可追溯日志。

## Scope
仅作用于 `109`。

本轮包含：
- 清空 `109` 现有填充色
- 将已确认的手工输入单元格标成浅红
- 每次 109 公式回写前清掉旧的黄色变更高亮
- 回写后只把本次实际改动过的 109 公式单元格标成浅黄
- 在工作簿中新建或复用 `AiWB_109_Log` 记录每次更新

本轮不包含：
- 其他 Sheet 的颜色体系
- 其他 Sheet 的自动回写策略
- 未明确确认的“手工输入”定义

## Confirmed Manual Input Scope
依据现有字典与公式梳理文档，当前只将以下 `109` 行的 `F:K` 视为手工输入区：
- `WB Home COGS`
- `WB Home Inventory Income`
- `WB Home Inventory`
- `Budget Cost Change Order`

像 `Accounts Receivable-Audited`、`General Conditions fee-Audited`、`Cost of Goods Sold-Audited` 当前只视为对照层，不在本轮标成浅红。

## User Flow
1. 用户点击 `生成109公式清单（预览）`
2. 程序生成 109 公式计划
3. 程序自动对比 Google Sheet 当前 109 公式
4. 如果完全一致：
   - 不重复写入公式
   - 仍然重置 109 的颜色层
   - 重画浅红手工区
   - 重新标记本次目标公式区为浅黄
   - 写入一条日志，状态为 `noop_rehighlight`
5. 如果存在差异：
   - 批量写回差异公式
   - 清理旧黄标
   - 重画浅红手工区
   - 把本次实际变更的公式格标浅黄
   - 写入一条日志，状态为 `updated`

## Coloring Rules
`109` 颜色规则分两层：
- 基础层：手工输入区，浅红
- 更新层：本次公式变更区，浅黄

更新顺序：
1. 清空 `109` 全表背景色
2. 画浅红手工输入区
3. 画浅黄变更区

这样可以保证黄色优先显示在真正变更过的公式格上。

## Logging
日志页名：`AiWB_109_Log`

每次追加一行，至少记录：
- timestamp
- operator
- mode
- formula_count
- changed_count
- changed_cells
- verify_matched
- verify_total
- note

## Implementation Shape
保留现有 `generate_109_formula_plan` 与 `execute_109_formula_plan` 主结构，在 `check_finance.py` 内补充：
- 109 行定位与手工区 A1 范围构造
- 109 公式差异提取
- 109 着色 batchUpdate
- 109 日志页 ensure + append
- UI 从“预览 + 手工确认写入”改成“预览后可直接同步”

## Risks
- `109` 行锚点若漂移，手工区定位会失效，因此仍使用科目名锚点，不写死行号。
- 清空整张 `109` 背景色会抹掉这张表内既有人工颜色；这是本轮已确认行为。
- 如果颜色与日志写入成功、公式本身无变化，用户仍需要刷新 Google Sheet 才能看到最新状态。
