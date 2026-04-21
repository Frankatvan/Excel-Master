# Payable / Final Detail Classification Design

日期：`2026-04-18`

## Goal
把 `Payable` 与 `Final Detail` 的成本分类规则正式固化，并为后续代码改造提供唯一口径来源。

本轮目标不是直接改所有下游报表，而是先把分类引擎设计清楚，并明确后续实现时要：
- 在 `Payable!A` 写入新的分类结果
- 在 `Final Detail!A` 写入新的分类结果
- 对无法分类、匹配不上、或结果明显异常的记录单独汇总并回报用户确认

## Scope
本设计覆盖：
- `Scoping` 状态定义
- `Unit Budget` 的 `实际结算日期` / `TBD Acceptance Date` 依赖
- `Payable` 分类规则
- `Final Detail` 分类规则
- `ACC / RACC` 的跨表匹配逻辑
- 实施后的异常确认流程

本轮不覆盖：
- `109` 公式口径进一步改造
- `Payable` 旧 `C:J` 输出的完整重做
- `Final Detail` 全量汇总逻辑重构
- UI 交互改版

## Confirmed Outputs
分类输出枚举扩展为：
- `Direct`
- `Income`
- `ROE`
- `Consulting`
- `GC`
- `EXP`
- `TBD`
- `ACC`
- `RACC`
- `""`（仅允许在无法安全判定时出现，且必须进入异常清单）

## Shared Definitions
### Scoping 状态列
`Scoping` 中同一个 `Group Number` 可以同时命中多个状态。状态列定义为：
- `E = 1 = GMP`
- `F = 2 = Fee`
- `G = 3 = WIP`
- `H = 4 = WTC`
- `I = 5 = GC`
- `J = 6 = TBD`

这里的“命中 1/2/3/4/5/6”都表示对应 `Group Number` 在这些列中被标记，而不是单选字段。

### Unit 类型
- `Unit Code` 含数字：视为数字 `Unit`
- 不含数字：统一视为 `Common`

### 实际结算日期
`Unit Budget` 已有：
- `结算年份`
- `C/O date`
- `实际结算日期`
- `实际结算年份`

分类逻辑里的“实际结算日前 / 后”，统一以 `Unit` 对应的 `实际结算日期` 为准。

新增确认：
- `docs/Sandy cove.xlsx` 是当前 `C/O date` / `TBD Acceptance Date` 的外部覆盖源
- 文件列结构为：`Project / UnitCode / C/O Date / TBD Acceptance Date`
- 实现时先用该文件覆盖 `Unit Budget` 对应数字 `Unit` 的日期字段，再计算 `实际结算日期`
- `实际结算日期 = C/O Date` 的下月最后一天
- 若数字 `Unit` 缺少 `C/O Date`，则该 `Unit` 视为“未结算”，`实际结算日期` 与 `实际结算年份` 保持空白，不得强行用旧 `结算年份` 补成“已结算”

### TBD Acceptance Date
后续实现中，在 `Unit Budget` 当前 `K` 后、`L` 前新增一列手工字段：`TBD Acceptance Date`。

规则：
- 数字 `Unit`：手工录入
- `Common`：自动取所有数字 `Unit` 中最后一个日期
- 当前阶段优先从 `docs/Sandy cove.xlsx` 覆盖已知数字 `Unit`
- 若数字 `Unit` 缺少 `TBD Acceptance Date`，分类逻辑不能因此留空；它只表示“尚未进入 TBD 阶段”

## Cross-Sheet Field Mapping
### Payable
- `Vendor = O列`
- `Amount = U列`
- `Incurred date = V列`
- `Unit Code = AL列`
- `Cost Code = AM列`
- `现有分类列 = AQ列`

### Final Detail
- `Final date = O列`
- `Incurred date = T列`
- `Unit Code = U列`
- `Activity No. = W列`
- `Cost Code = Z列`
- `Amount = AB列`
- `Vendor = AD列`

### Scoping
- `Group Number = C列`
- `Group Name = D列`
- 状态标记 = `E:J`

## Matching Model
### Group 归属
`Payable` 和 `Final Detail` 都先通过 `Cost Code` 末三位回到 `Scoping.Group Number`，再读取该 `Group Number` 的状态集合。

### ACC / RACC 匹配键
`Payable` 与 `Final Detail` 之间，同一张业务单据的匹配键为：
- `Vendor`
- `Amount`
- `Cost Code`
- `Incurred date`

`Final Detail` 内部同一组预提/冲回记录的配对键为：
- `Vendor`
- `Activity No.`
- `Amount`
- `Cost Code`

其中一组配对表现为：
- `ACC` 侧：`Final date` 有值，`Incurred date` 为空
- `RACC` 侧：`Incurred date` 有值，`Final date` 为空

`RACC` 不能只靠单边匹配成立，必须证明它与一条 `ACC` 记录属于同一组预提/冲回关系。

## Classification Decision Tree
### Rule 0: General Condition 文本优先
若 `Unit Code` 包含 `General Condition`，直接分类为 `GC`。

此规则优先于其余状态判断。

### Rule 1: 按实际结算日期分段
除 Rule 0 外，所有记录先按：
- `Incurred date < 实际结算日期`
- `Incurred date >= 实际结算日期`

分成“实际结算日前”与“实际结算日后”两段。

补充：
- 若 `实际结算日期` 缺失，则该 `Unit` 统一按“未结算”处理，直接走“实际结算日前”分支
- 缺少 `实际结算日期` 不再单独导致空分类

## Before Actual Settlement Date
### 命中 GMP(1) 的记录
如果 `Group` 命中 `1`：

1. 若同时命中 `2`，且 `Vendor = Wan Pacific Real Estate Development LLC`
   - 分类为 `Income`

2. 否则若同时命中 `5`
   - 分类为 `GC`

3. 其他
   - 分类为 `ROE`

说明：
- 这里不要求“只命中 1”
- `1` 可以与 `2/5/6` 等同时存在
- 在“实际结算日前”完全不考虑 `6`

### 非 GMP(1) 记录
如果未命中 `1`：

1. 若命中 `4`，且 `Vendor = WB Texas Consulting LLC`
   - 分类为 `Consulting`

2. 若 `Scoping E:J` 全空
   - 分类为 `Direct`

3. 其他混合状态
   - 统一分类为 `Direct`

## After Actual Settlement Date
优先级固定为：
1. `ACC`
2. `RACC`
3. `TBD`
4. `EXP`

### ACC
满足以下条件时分类为 `ACC`：
- `Group` 命中 `1`
- 在 `Final Detail` 中存在匹配记录，且：
  - `Final date` 有值
  - `Incurred date` 为空

### RACC
满足以下条件时分类为 `RACC`：
- `Group` 命中 `1`
- 可在 `Final Detail` 中找到对应“`Incurred date` 有值、`Final date` 为空”的记录
- 并且该记录能够和某条 `ACC` 记录证明属于同一组预提/冲回关系

### TBD
满足以下条件时分类为 `TBD`：
- 当前记录日期在该 `Unit` 的 `TBD Acceptance Date` 之后
- `Group` 命中 `6`

若 `TBD Acceptance Date` 缺失：
- 不能判成 `TBD`
- 但也不能因此留空，应继续落到 `EXP`

### EXP
不满足 `ACC / RACC / TBD` 的其余记录，统一分类为 `EXP`。

说明：
- `Consulting` 在“实际结算日后”不再保留，统一进入 `ACC / RACC / TBD / EXP`
- `6(TBD)` 仅在 `TBD Acceptance Date` 之后才有意义

## Final Detail Classification Shape
`Final Detail!A` 使用与 `Payable!A` 同一套分类枚举，但其判定更依赖本表自身字段：
- `ACC`：直接基于 `Final date` 有值、`Incurred date` 为空、且 `Group` 命中 `1`
- `RACC`：直接基于 `Incurred date` 有值、`Final date` 为空、且可证明存在对应 `ACC` 配对
- 其他类别沿用同一套“结算日前/后 + Scoping 状态 + Vendor”规则

## Implementation Shape
后续代码改造采用“先算分类，再写回，再做异常确认”的顺序：

1. 新增共享分类辅助层
- 解析 `Scoping` 状态集合
- 解析 `Unit -> 实际结算日期`
- 解析 `Unit -> TBD Acceptance Date`
- 统一构造 `Group` 状态判断函数

2. 新增 `Payable` 分类函数
- 输入：单行 `Payable` 记录 + Scoping 状态 + Unit 日期口径 + Final Detail 索引
- 输出：分类值、命中规则、异常原因

3. 新增 `Final Detail` 分类函数
- 输入：单行 `Final Detail` 记录 + Scoping 状态 + Unit 日期口径 + 配对索引
- 输出：分类值、命中规则、异常原因

4. 写回位置
- `Payable!A`
- `Final Detail!A`

5. 保留旧列，不直接覆盖旧辅助逻辑
- 先把新分类结果独立写到 `A列`
- 其余旧 `C:J` / `B:K` 逻辑先不在同一轮强改

## Validation And User Confirmation
后续实现时，每次计算完成后必须额外生成一份异常汇总，先给用户确认：

### 必报异常
- 分类结果为空
- `ACC` 候选找不到对应记录
- `RACC` 候选无法证明与 `ACC` 成对
- `Unit` 缺少 `实际结算日期`
- 数字 `Unit` 缺少 `TBD Acceptance Date`
- `Group` 无法回到 `Scoping`
- `Vendor / Amount / Cost Code / Incurred date` 组合键冲突或重复过多

补充收口：
- “缺少 `实际结算日期` / `TBD Acceptance Date`”属于非阻断异常，要继续给出分类结果
- 仅当记录本身既没有 `Incurred date` 也没有 `Final date`，导致连事件日期都不存在时，才允许输出空分类

### 回报内容
至少按以下维度汇总：
- 每个分类的数量与金额
- 空分类数量与样本
- `ACC / RACC` 未配对数量与样本
- 缺少 `TBD Acceptance Date` 的 `Unit` 列表
- 规则命中后看起来异常的样本行

用户要求的执行方式是：
- 先把结果写到 `Payable!A` 和 `Final Detail!A`
- 再把疑似逻辑不对和空值单独回报确认

## Risks
- `ACC / RACC` 依赖跨表配对，若历史数据存在金额重复、同日重复、同 Vendor 重复，会出现一对多歧义。
- `Common` 的 `TBD Acceptance Date` 自动取最后日期，若数字 `Unit` 数据不全，会放大错误。
- `Unit Code` / `Cost Code` 文本格式可能不统一，末三位提取要做标准化。
- `Final Detail` 与 `Payable` 的日期字段存在空值和格式差异，必须先标准化为日期类型后再比较。

## Recommended Implementation Order
1. 先加 `Unit Budget` 的 `TBD Acceptance Date`
2. 再做 `Scoping` 状态解析器
3. 再做 `Final Detail` 的 `ACC / RACC` 配对索引
4. 再算 `Payable!A`
5. 再算 `Final Detail!A`
6. 最后输出异常清单供用户确认
