# Finance Rule ID Audit Design

日期：`2026-04-19`

## Goal
把当前 `Payable / Final Detail` 的分类引擎从“黑盒判断”升级为“可审计判断”。

第一版目标不是重写全部财务逻辑，而是在不破坏现有分类结果的前提下，为每一条最终分类结果补充可追溯的 `Rule_ID`，并建立一份中英对照的审计手册，使审计员能够通过 `Category + Rule_ID` 快速回溯该行的业务判断依据。

为避免继续放大 `check_finance.py` 的维护成本，本轮在进入 `Rule_ID` 审计层之前，先执行一次**轻量预拆分**：把财务分类核心抽离到独立模块，再在新模块中继续实现审计能力。

## Confirmed Scope
本轮确认实现以下内容：
- 先执行一次轻量预拆分，把财务分类核心迁移到独立模块
- 分类函数返回结构化判定结果，而不再只返回裸分类字符串
- `Payable` 与 `Final Detail` 结果表增加 `Rule_ID` 辅助列
- `Payable` 与 `Final Detail` 共用一套 `Rule_ID`
- 建立一份中英对照审计手册
- 第一版仅覆盖最小可用的 `12` 条规则

本轮明确不做：
- 不把 `Reason / Evidence` 直接写入 Google Sheet
- 不一次性给所有 warning / 缺失字段异常做完整编号体系
- 不把规则中心外置为 YAML / CSV / 数据库配置
- 不全面重构现有整套数据输入输出架构
- 不同步扩展 UI 层展示
- 不在本轮继续拆分 `109` 引擎、Google Sheets 同步层或 Streamlit UI

## Output Contract
### Sheet 输出
结果表第一版只新增两列：
- `A = Category`
- `B = Rule_ID`

适用表：
- `Payable`
- `Final Detail`

不直接落表的字段：
- `Reason`
- `Evidence`

### Audit Manual 输出
审计手册中必须对每个 `Rule_ID` 给出中英对照说明。

手册应至少包含：
- `Rule_ID`
- `Category`
- `Sheet Scope`
- `中文判定依据`
- `English Reason`
- `中文证据说明`
- `English Evidence`
- `典型字段 / Key Fields`

建议文件位置：
- `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md`

## Architecture
### 0. Light Pre-Split
在实现 `Rule_ID` 审计层之前，先做一次低风险的模块边界整理。

新增模块：
- `finance_classification.py`

第一步迁出的内容仅限于财务分类核心：
- `ClassificationDecision`
- `RULE_REGISTRY`
- `_decision`
- `_build_scoping_status_map`
- `_classify_before_actual_settlement`
- `_classify_payable_record`
- `_classify_final_detail_record`
- `_build_final_detail_classification_index`
- `_apply_exp_restore_overrides`
- `_compute_cross_sheet_classifications`

继续留在 `check_finance.py` 的内容：
- Streamlit UI
- Google Sheets 读写与同步
- 本地 draft / audit / commit bundle
- `109` 公式与格式逻辑
- `_process_payable_py`
- `_process_final_detail_py`

这样做的目的：
- 后续 `Rule_ID`、双语规则表、审计手册都归拢到分类核心模块
- 不把本轮审计能力继续堆到 4600+ 行的单文件里
- 避免把 UI / 同步 / 109 一起卷入本轮改造

### 1. Rule Registry
在代码中维护一份统一的规则注册表，作为 `Rule_ID` 与审计说明的唯一来源。

每条规则至少包含：
- `rule_id`
- `category`
- `sheet_scope`
- `reason_zh`
- `reason_en`
- `manual_evidence_zh`
- `manual_evidence_en`

设计原则：
- 一个最终判定路径只对应一个 `Rule_ID`
- 一个 `Rule_ID` 只对应一条主判定路径
- 手册与代码中的规则说明必须同源，避免漂移

### 2. Decision Object
分类函数统一返回结构化判定结果，而不是只返回分类字符串。

建议结构：

```python
@dataclass(frozen=True)
class ClassificationDecision:
    category: str
    rule_id: str
    reason_zh: str
    reason_en: str
    evidence: Mapping[str, Any]
    warnings: tuple[str, ...] = ()
```

字段含义：
- `category`：最终分类结果，写入 `A列`
- `rule_id`：规则编号，写入 `B列`
- `reason_zh / reason_en`：供审计手册与调试使用，不直接落表
- `evidence`：供审计追溯和逻辑穿透使用，不直接落表
- `warnings`：保留当前异常统计和 issue sample 汇总能力

### 3. Decision Builder
在分类分支中通过统一 helper 构造 `ClassificationDecision`。

建议形式：

```python
def _decision(
    rule_id: str,
    evidence: Mapping[str, Any],
    warnings: Sequence[str] = (),
) -> ClassificationDecision:
    ...
```

作用：
- 分类分支只关心“命中了哪条规则”
- 中英文原因说明由规则注册表统一提供
- 审计口径集中维护，不散落在条件分支里

### 4. Sheet Writer
写回层只消费最终 `ClassificationDecision` 列表，并拆出：
- `category -> A列`
- `rule_id -> B列`

不在本轮写回：
- `reason`
- `evidence`

## Shared Rule ID System
`Payable` 与 `Final Detail` 共用同一套编号体系。

编号分段：
- `R1xx`：结算日前规则
- `R2xx`：结算日后规则
- `R25x`：`EXP restore` 特殊还原规则

这样设计的原因：
- 审计手册只维护一份
- 同类业务逻辑在两张表之间不需要重复定义
- 后续新增规则时不必拆成两套编号体系

## Phase 1 Minimal Rule Set
第一版只落地以下 `12` 条规则：

### Before Settlement (`R1xx`)
- `R101`
  - Category: `ROE`
  - Logic: Before Settlement + GMP
- `R102`
  - Category: `Income`
  - Logic: Before Settlement + GMP + Fee + `Wan Pacific Real Estate Development LLC`
- `R103`
  - Category: `GC`
  - Logic: Before Settlement + GMP + GC Flag
- `R104`
  - Category: `Consulting`
  - Logic: Before Settlement + WTC + `WB Texas Consulting LLC`
- `R105`
  - Category: `Direct`
  - Logic: Before Settlement + Non-GMP fallback
- `R106`
  - Category: `GC`
  - Logic: `Unit Code` text hits `General Condition`

### After Settlement (`R2xx`)
- `R201`
  - Category: `ACC`
  - Logic: After Settlement + ACC matched
- `R202`
  - Category: `RACC`
  - Logic: After Settlement + RACC matched
- `R203`
  - Category: `TBD`
  - Logic: After Settlement + TBD hit
- `R204`
  - Category: `EXP`
  - Logic: After Settlement + fallback to EXP
- `R205`
  - Category: `EXP`
  - Logic: After Settlement + missing TBD acceptance date

### EXP Restore (`R25x`)
- `R251`
  - Category: `RACC / ACC`
  - Logic: `EXP` restored by Final Date window exception

说明：
- `R251` 是同一组双边业务事件的共享规则
- 当 `Payable` 命中 `R251` 时，最终类别为 `RACC`
- 当 `Final Detail` 命中 `R251` 时，最终类别为 `ACC`

## Rule Mapping To Existing Logic
### Existing Classification Functions
后续实现应先把以下函数迁移到 `finance_classification.py`，再在新模块中改造：
- `check_finance.py::_classify_payable_record`
- `check_finance.py::_classify_final_detail_record`

它们从当前的“分类字符串 + issues”返回模式，升级为返回 `ClassificationDecision`。

### Existing Cross-Sheet Restore
后续实现应先把以下函数迁移到 `finance_classification.py`，再在新模块中改造：
- `check_finance.py::_apply_exp_restore_overrides`
- `check_finance.py::_compute_cross_sheet_classifications`

要求：
- restore pass 不再只覆盖裸字符串分类
- 命中还原时，必须生成 `rule_id = R251` 的最终判定结果
- `evidence` 中需保留跨表匹配证据

## Evidence Tracing Requirements
虽然第一版不把 `Evidence` 写入 Sheet，但代码内必须保留 Evidence Tracing 能力，尤其是：
- `ACC`
- `RACC`
- `R251`

至少记录以下关键信息中的合理子集：
- `Activity No.`
- `Amount`
- `Cost Code`
- `Incurred Date`
- `Final Date`
- `Unit Code`
- 跨表匹配键（如 Payable Key）

设计目的：
- 审计员追问 `RACC` 是否有跨表依据时，系统能给出穿透证据
- 后续生成审计手册或调试日志时，无需反向阅读全部 Python 条件分支

## Audit Manual Shape
手册采用中英对照，建议每条规则按以下固定格式书写：

```markdown
## R204

- Category: `EXP`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算日后，未命中 ACC / RACC / TBD，回落为 EXP
- English Reason: After settlement, no ACC / RACC / TBD match, fallback to EXP
- 中文证据说明：检查实际结算日、事件日期、Group 状态，以及 ACC/RACC/TBD 命中结果
- English Evidence: Check actual settlement date, event date, group flags, and ACC/RACC/TBD matching result
- 典型字段 / Key Fields: `Unit Code`, `Cost Code`, `Incurred Date`, `Final Date`, `statuses`
```

## Success Criteria
当本轮设计被实现后，以下条件必须同时成立：
- 财务分类核心已从 `check_finance.py` 轻量抽离到独立模块，且对外行为不变
- 任意一行 `Payable` 或 `Final Detail` 都能输出 `Category + Rule_ID`
- `Rule_ID` 能在审计手册中唯一查到中英对照解释
- `ACC / RACC / R251` 具备明确的 Evidence Tracing 能力
- 当前已通过的分类逻辑测试仍然通过
- 分类引擎主逻辑不因审计字段扩展而失真

## Risks And Guardrails
- 轻量预拆分只针对分类核心，不得顺手扩大为全面架构重构
- `Rule_ID` 是审计索引，不应和 warning / debug message 混用
- 第一版不要把异常编号体系做得过深，避免维护成本失控
- 规则注册表必须是唯一来源；不要在多个文件重复维护同一条规则的中英文解释
- `R251` 必须明确标记为“特殊还原规则”，不能和常规 `R201/R202` 混淆
- 即使结果表只写两列，代码内仍应保存 `reason/evidence`，否则后续手册和证据链会失真
