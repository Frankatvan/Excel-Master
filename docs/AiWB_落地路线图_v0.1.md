# AiWB 落地路线图 v0.1

日期：`2026-04-17`

## Phase A：规则冻结（当前进行中）
1. 完成 `109` 主链规则冻结（已完成）。
2. 完成 `WB Home` 分支冻结（已完成）。
3. 完成 `AR` 链候选冻结（已完成，待最终验收）。
4. 完成 `Budget Cost Change Order` 自动源冻结（进行中）。

## Phase B：代码落地（下一步）
1. 把 [AiWB_公式字典_109_v1.yaml](/Users/frank/Documents/My Documents/00 Frank‘ Lab/Excel Master/Docs/AiWB_公式字典_109_v1.yaml) 接入 `check_finance.py`。
2. 建立“自动计算 + 手工覆盖优先”的执行器。
3. 建立“按年/按月”双模式期间分桶函数。
4. 在不覆盖同事输入列的前提下，生成 `delta` 回写包。

## Phase C：一致性与审计
1. 每次同步前输出“自动值 vs 手工值 vs 审计值”三向对比。
2. 对关键行（POC/Revenue/GP/AR）输出逐期误差明细。
3. 回写后写入 `aiwb_audit.log`（操作人、时间、影响字段、差异摘要）。

## Phase D：上云预留
1. 抽象 Data Adapter（Google -> 可替换云数据库）。
2. 公式引擎保持纯 Python（UI 无关）。
3. 增加 `project_id` 上下文，支持多项目并行。
