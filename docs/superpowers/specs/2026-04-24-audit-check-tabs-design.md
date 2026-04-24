# 审计核对页签增强设计

## 背景

审计工作台目前已有 `总览 / 外部核对 / 成本重分类 / 109 对比` 等基础视图，但后续审计需要把“外部数据、手工录入、成本重分类、项目利润表”拆成更明确的核对项，并让金额差异、录入异常和内部公司交易可以直接追溯到明细行。

本设计只定义需求、数据口径和展示结构，不进入代码实现。

## 目标

- 将总览之后的核对项调整为四个明确页签：`外部数据核对 / 手工录入核对 / 成本重分类 / 项目利润表对比`
- 扩展后端审计快照，使前端可以只读快照完成汇总展示和金额明细筛选
- 将内部公司列表从 Excel 导入数据库，作为 Vendor 匹配的统一真源
- 明确 Unit/Common、Cost State、重分类类别、人工录入、Scoping、Unit Master 日期链等所有核对口径
- 点击金额时展示可追溯明细，不再实时读取 Google Sheet

## 非目标

- 不改变现有 `项目利润表对比` 的计算口径，只将现有 `109 对比` 改名
- 不做 Vendor 模糊匹配、简称匹配或公司后缀智能清洗
- 不在前端点击金额时重新拉取 Google Sheet
- 不在本轮设计里重构工作台整体视觉系统

## 页签结构

审计工作台保留 `总览`，后续页签调整为：

1. `外部数据核对`
2. `手工录入核对`
3. `成本重分类`
4. `项目利润表对比`

`项目利润表对比` 由现有 `109 对比` 改名，当前功能和展示口径保持不变。

## 数据刷新与快照原则

同步数据、成本重分类等动作完成后，由后端生成扩展版 `audit snapshot`。前端页面只读取该快照。

金额点击详情也从同一份快照中的明细池筛选，不实时查询 Google Sheet。这样可以保证：

- 同一次核对使用同一份数据
- 页面响应更快
- 核对结果可追溯
- 后续导出和审计留痕可以复用同一份快照

## 内部公司库

内部公司列表来自用户提供的 `CompanyInfowithCapital_Report.xlsx`。

导入规则：

- 读取工作表中的 `Company` 列
- 去重后存入数据库
- Vendor 匹配时按标准化后的公司名完全一致判断

标准化规则：

- 去掉首尾空格
- 连续空格合并为单个空格
- 大小写不敏感

不做以下处理：

- 不做包含匹配
- 不自动去掉 `LLC`、`Inc` 等公司后缀
- 不使用 EIN、Texas Taxpayer Number 或 Address 做本轮匹配

## 外部数据核对

外部数据核对包含三块：`Unit/Common 个数`、`Cost State 金额矩阵`、`Payable 内部公司矩阵`。

### Unit/Common 个数

参与表：

- `Unit Budget`
- `Payable`
- `Final Detail`
- `Draw Request report`

`Unit Budget` 的 Unit 数量口径：

- 从 `U1` 开始向右按列统计
- 每个非空表头算一个 Unit
- 遇到第一个空列即停止

其他三张表的 Unit 数量口径：

- 按 `Unit Code` 去重统计
- 同一个 `Unit Code` 只算一个 Unit

Common 口径：

- 按具体 Common 名称或类别逐项列举数量
- 不只显示一个 Common 总数

兜底口径：

- 如果某行既不能识别为 Unit，也没有 Common 标识，归入 `未分配`

### Cost State 金额矩阵

参与表：

- `Payable`
- `Final Detail`
- `Draw Request report`

`Unit Budget` 不参与 Cost State 金额矩阵，因为它没有 Cost State 概念。

展示口径：

- 行：原始 `Cost State`
- 列：`Payable 金额 / Final Detail 金额 / Draw Request report 金额`
- 空 `Cost State` 统一显示为 `未分配`
- 某张表在某个 Cost State 下没有金额时显示 `0`

合计口径：

- `Cost State 汇总合计`：由上方各 Cost State 行加总得出
- `原始 Amount 合计`：直接从各原始表的 Amount 数据取得
- 如果两种合计不一致，对应金额标红

金额点击后进入外部数据核对明细。

### Payable 内部公司矩阵

数据源：

- 仅 `Payable`

匹配口径：

- Vendor 标准化后与内部公司库完全一致

展示口径：

- 行：内部公司名
- 列：原始 `Cost State`
- 值：金额
- 空 `Cost State` 显示为 `未分配`
- 没有金额显示为 `0`

金额点击后进入外部数据核对明细。

## 手工录入核对

手工录入核对包含四块：`项目利润表录入金额`、`错误数据`、`Scoping`、`Unit Master 日期链`。

### 项目利润表录入金额

原 `109` 表在页面文案中建议改为 `项目利润表`。

展示口径：

- 只展示有录入金额的字段
- 排除项目名
- 排除项目 Owner
- 不展示编辑人、编辑时间、锁定状态

字段：

- `单元格位置`
- `字段名`
- `金额`

### 错误数据

只展示不一致或异常的数据；一致则不显示。

规则：

- `E12 累积完工比例` 不等于 `E13 当期完工比例`
- `E12 累积完工比例` 大于 `100%`
- 当 `E12 累积完工比例 = 100%` 时，`E16 合同变动金额` 不等于 `E17 当期计算收入`
- `E32 ROE成本 - WB Home` 不等于 `-E41 WB Home收入`

### Scoping

每个 group 展示一行。

字段：

- `Group`
- `E`
- `F`
- `G`
- `H`
- `I`
- `J`
- `保修月数`
- `保修到期日`
- `Budget amount`
- `Incurred amount`
- `状态`

状态规则：

- 如果 `Budget amount` 或 `Incurred amount` 有金额，但需要指定的字段为空，状态显示 `未录入数值`
- 否则状态为空或显示正常状态

### Unit Master 日期链

展示顺序：

`C/O date -> Final Date -> 实际结算日期 -> TBD Acceptance Date`

异常规则：

- 日期链应从左到右不早于前一项
- 如果右侧日期小于左侧日期，则右侧日期标红

日期显示：

- 所有日期显示为 `MM/DD/YYYY`

## 成本重分类

成本重分类包含两块：`重分类后对比`、`内部公司重分类矩阵`。

### 重分类后对比

展示口径：

- 行：重分类后的类别
- 空重分类类别显示为 `未分配`

字段：

- `重分类类别`
- `Payable 金额`
- `Payable 数量`
- `Final Detail 金额`
- `Final Detail 数量`
- `差异金额`
- `差异数量`

异常标识：

- `差异金额` 非 0 时标红
- `差异数量` 非 0 时标红

金额点击后进入成本重分类明细。

### 内部公司重分类矩阵

参与表：

- `Payable`
- `Final Detail`

匹配口径：

- Vendor 标准化后与内部公司库完全一致

展示口径：

- 行：内部公司名
- 列：重分类类别
- 值：金额
- 空重分类类别显示为 `未分配`
- 没有金额显示为 `0`

金额点击后进入成本重分类明细。

## 金额明细

金额明细从后端快照中的明细池筛选得到。

### 外部数据核对明细

字段：

- `来源表`
- `Row No.`
- `Unit Code`
- `Vendor`
- `Cost State 原值`
- `Cost Name`
- `Amount`

外部数据核对明细不显示 `重分类类别`。

### 成本重分类明细

字段：

- `来源表`
- `Row No.`
- `Unit Code`
- `Vendor`
- `Cost State 原值`
- `重分类类别`
- `Cost Name`
- `Amount`

### Cost Name 显示规则

`Cost Name` 必须包含前三位数字。

规则：

- 如果原 `Cost Name` 已经以三位数字开头，直接显示原值
- 如果原 `Cost Name` 没有三位数字前缀，则从 `Cost Code` 提取末尾三位数字，拼成 `<三位数字> <原 Cost Name>`
- 如果 `Cost Code` 也取不到三位数字，则显示原 `Cost Name`

示例：

- `Cost Code = 1SF116`
- `Cost Name = Permit`
- 显示为 `116 Permit`

## 项目利润表对比

`109 对比` 改名为 `项目利润表对比`。

本轮保持现有功能与数据口径，不新增计算规则。

## 后端快照建议结构

扩展 `audit snapshot` 时建议包含以下逻辑结构：

- `external_recon.unit_common_counts`
- `external_recon.cost_state_matrix`
- `external_recon.internal_company_cost_state_matrix`
- `manual_input.profit_statement_entries`
- `manual_input.validation_errors`
- `manual_input.scoping_groups`
- `manual_input.unit_master_dates`
- `reclass_audit.category_comparison`
- `reclass_audit.internal_company_category_matrix`
- `detail_rows.external_recon`
- `detail_rows.reclass_audit`

字段名可按现有代码风格调整，但业务结构应保持清晰分层。

## 测试范围

应覆盖以下测试：

- 内部公司 Excel 去重导入与 Vendor 完全匹配
- `Unit Budget` 从 `U1` 往右遇空停止的 Unit 计数
- `Payable / Final Detail / Draw Request report` 按 Unit Code 去重计数
- Common 逐项列举与 `未分配` 兜底
- Cost State 空值显示为 `未分配`
- Cost State 汇总合计与原始 Amount 合计不一致标红
- 手工录入错误规则四条
- Scoping 有金额但缺少指定字段时显示 `未录入数值`
- Unit Master 日期链中右侧日期小于左侧日期时标红
- 成本重分类差异金额和差异数量标红
- 外部数据核对明细不显示重分类类别
- 成本重分类明细显示重分类类别
- Cost Name 自动补前三位数字
- `109 对比` 文案改为 `项目利润表对比` 且原功能保持不变
