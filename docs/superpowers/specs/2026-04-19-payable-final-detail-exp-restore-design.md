# Payable / Final Detail EXP Restore Design

日期：`2026-04-19`

## Goal
补充一条“`EXP` 后置还原”规则，修正由于项目录入的 `Final date` 晚于当前 `actual_settlement_date`，导致本应属于 `ACC / RACC` 的同组单据被误判成 `EXP` 的情况。

本设计只覆盖这条特殊还原逻辑，不重写现有主分类树。

## Confirmed Business Decisions
- 还原逻辑只处理当前初始分类为 `EXP` 的记录。
- 还原时必须 `Final Detail` 和 `Payable` 两边都存在同一张业务单据。
- 跨表匹配继续沿用现有近似键，不改成发票号：
  - `Vendor`
  - `Amount`
  - `Cost Code`
  - `Incurred date`
- 只有当匹配关系是一对一时才允许还原；一对多、多对一、重复键都跳过。
- 命中还原后，目标分类固定为：
  - `Final Detail = ACC`
  - `Payable = RACC`
- 本规则不覆盖 `TBD / GC / Income / Consulting / Direct / ROE` 等非 `EXP` 结果。

## Why A Restore Pass
现有主逻辑先按 `actual_settlement_date` 把记录分成“结算日前 / 结算日后”，再在“结算日后”进入 `ACC / RACC / TBD / EXP` 分支。

特殊问题在于：
- 某些项目目录录入的 `Final date` 晚于当前口径里的 `actual_settlement_date`
- 结果是：一组本应保留在 `ROE -> ACC/RACC` 语义链上的记录，被过早推入“结算日后”的 `EXP`

因此，这次不改主树，而是在初始分类之后增加一次 restore pass，更符合业务语义，也更容易控制影响范围。

## Trigger Conditions
某组跨表匹配记录只有在同时满足以下条件时才触发还原：

1. `Payable` 与 `Final Detail` 可按现有近似键匹配到同一组记录
2. 该匹配键在 `Payable` 侧唯一、在 `Final Detail` 侧也唯一
3. 两边记录的初始分类当前都等于 `EXP`
4. 对应 `Scoping` 状态命中 `1`（GMP）
5. `Payable.Incurred Date` 有值
6. `Final Detail.Final Date` 有值
7. `actual_settlement_date < Final Detail.Final Date`
8. 以这条 `Final Detail.Final Date` 作为业务分界线观察时，该组本来应落在 `ROE` 口径

第 8 条的落地解释已经确认：
- `Payable.Incurred Date <= Final Detail.Final Date`
- 并且该组命中 `GMP(1)`

## Classification Result
一旦命中 restore：
- `Payable` 该条从 `EXP` 改写为 `RACC`
- `Final Detail` 该条从 `EXP` 改写为 `ACC`

说明：
- restore 只改写命中的这两条记录
- 不继续派生额外的 `ACC / RACC` 配对关系
- 不反向覆盖主分类树中原本已经判成非 `EXP` 的记录

## Matching And Ambiguity Rules
restore 使用的跨表键继续复用现有实现：
- `Vendor`
- `Amount`
- `Cost Code`
- `Incurred date`

为避免误还原，以下情况一律跳过：
- `Payable` 某个键匹配到多条 `Final Detail`
- `Final Detail` 某个键匹配到多条 `Payable`
- 任一侧关键字段缺失，导致键无法稳定构造
- `Final Detail.Final Date` 为空
- `Payable.Incurred Date` 为空

这些跳过不会报错，只是不触发 restore。

## Implementation Shape
实现采用“先初判、后还原、再写回”的顺序：

1. 先沿用现有逻辑计算 `Payable` 初始分类
2. 先沿用现有逻辑计算 `Final Detail` 初始分类
3. 基于两边初始分类结果构造 restore 候选索引
4. 对命中的唯一配对执行改写：
   - `Payable -> RACC`
   - `Final Detail -> ACC`
5. 把最终分类写回各自 `A` 列

## Code Placement
建议在“计算分类列表”的阶段完成 restore，而不是把特殊逻辑直接塞回单行分类函数。

推荐位置：
- `Payable` 分类列表计算完成后，但写回 `Payable!A` 之前
- `Final Detail` 分类列表计算完成后，但写回 `Final Detail!A` 之前

更具体地说，应新增一层共享 restore helper，由：
- `_compute_payable_classifications(...)`
- `_compute_final_detail_classifications(...)`

共同消费，而不是让：
- `_classify_payable_record(...)`
- `_classify_final_detail_record(...)`

承担这条例外。

## Observability
为了便于人工核对，restore pass 应输出最少量的诊断信息：
- `restore_hit_count`
- 最多若干条 `restore_samples`

样本字段建议包含：
- `sheet`
- `row`
- `unit_code`
- `vendor`
- `cost_code`
- `amount`
- `incurred_date`
- `final_date`
- `from_category`
- `to_category`
- `restore_reason`

`restore_reason` 固定可写为：
- `exp_restored_by_final_date_window`

## Out Of Scope
本设计不覆盖：
- 改造现有 `ACC / RACC` 主配对模型
- 改成按发票号做跨表匹配
- 调整 `TBD` 判定逻辑
- 改写 `GC / Income / Consulting / Direct / ROE` 原有定义
- UI 展示或交互层改动

## Risks And Guardrails
- 近似匹配键不是业务主键，因此必须坚持“一对一才还原”，不能做模糊批量覆盖。
- restore 只覆盖双边都为 `EXP` 的记录，这是最重要的边界，避免污染已经稳定的非 `EXP` 分类。
- `Final Detail.Final Date` 被用作 restore 的业务窗口，而不是替换全局 `actual_settlement_date`；这是一条例外规则，不是新的总分界线。
- 若后续出现“同键多条且业务上确实该还原”的场景，应单独设计新的 disambiguation 规则，不在本轮偷做。
