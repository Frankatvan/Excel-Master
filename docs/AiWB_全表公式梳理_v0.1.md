# AiWB 全表公式梳理 v0.1

日期：`2026-04-17`  
范围：`Project Ledger_WBWT Sandy Cove_4.12.2026`（10个Sheet）

## 1. 本轮梳理口径
1. 以当前本地 `Docs/Project Ledger_WBWT Sandy Cove_4.12.2026.md` 为结构基准。
2. 以 `check_finance.py` 中已迁移的 Apps 逻辑为计算基准（`Unit Budget/Payable/Final Detail`）。
3. `109` 以“科目名锚点”定义公式链，避免行号漂移误差。

## 2. 全表总览（角色定位）
1. `Contract`：当前导出基本为空，占位表。
2. `109`：项目财务总控表（POC、收入、成本、毛利、WB Home分支、应收链）。
3. `Scoping`：科目主数据与预算底表（Group Number/Name、Budget、Incurred）。
4. `Unit Budget`：Unit维度预算与结算主表，含 Q 列后 Unit 透视区。
5. `Payable`：成本明细流水主表（供应商、日期、金额、科目码）。
6. `Final Detail`：Unit级明细与汇总桥接表（联动 Scoping + Unit Budget）。
7. `Draw request report`：Draw阶段进度与Unit事件明细。
8. `Draw Invoice List`：Draw发票台账（日期、Vendor、Invoice、Total）。
9. `Transfer Log`：科目间转账/重分类流水。
10. `Change Order Log`：变更单流水（Approved Change Orders / Potential Increase）。

## 3. 已固定的数据流主线
1. `Scoping` -> `Payable`：按 code 聚合回填核算列。
2. `Scoping` -> `Final Detail`：按 code 聚合形成明细映射。
3. `Unit Budget` + (`Payable`/`Final Detail`/`Draw request report`) -> `Unit Budget B列` Unit主清单。
4. `Unit Budget Q列后Unit列` -> `Unit Budget C/D`（两套条件汇总）。
5. `Payable` -> `109`：`Cost of Goods Sold-Company`、`WB Home Income` 等核心输入。

## 4. 109 表公式链（已确认版）
以下用科目名表达，不依赖固定行号。

1. `InitialDirectCost`  
来源：`Unit Budget!C1`（Day1 预算直接成本基值）。

2. `Budget Cost Change Order`  
定义：Owner 不确认的成本超支，当期列记录“当期变动额”，累计后进入分母。  
状态：取值源待后续落地（目前作为输入占位）。

3. `EAC_t`  
`EAC_t = InitialDirectCost + 累计(Budget Cost Change Order_<=t)`

4. `Cost of Goods Sold-Company`（COGS_company）
1. 年度列：当期发生额。
2. Total：累计额。
3. 取数规则：来自 `Payable`，当前规则为 `E=1`，金额取 `AB`，按期间归集；并扣除 `WB Home LLC` 影响。

5. `POC（Percentage of Completion）`
`POC_cum_t = 累计(COGS_company_<=t) / EAC_t`

6. `Completion Rate for the Period`
`CR_t = POC_cum_t - POC_cum_(t-1)`

7. `TP（Contract price）`
全周期固定，取合同金额（Day1），不随年份变化。

8. `General Conditions fee-Company`（当期收入口径）
`Revenue_t = POC_cum_t * TP - 累计(Revenue_<t)`

9. `Gross Profit-Company`
`GP_t = Revenue_t - COGS_company_t`

10. `WB Home` 分支
1. `WB Home Income`：来自 `Payable`，条件 `E=1 and C=WBH`，金额取 `AB`，按期间归集。
2. `WB Home COGS`：手工录入。
3. `Material Margin`：`WB Home Income - WB Home COGS`。

11. `WB Home Inventory` 分支
1. `WB Home Inventory Income`、`WB Home Inventory`：手工录入。
2. `Income-Reverse_t = - Income_(t-1)`（首年留空）。
3. `Inventory-Reverse_t = - Inventory_(t-1)`（首年留空）。
4. Margin/Total 行按汇总口径自动计算。

12. 数值精度
1. 展示：金额2位小数、百分比8位小数。
2. 计算：内部全精度。

## 5. Apps 迁移逻辑（已在 Python 中实现）
来自 `check_finance.py` 的稳定逻辑：

1. `sync_unit_master`
1. 从 `Unit Budget` Q列后列头、`Payable`第38列、`Final Detail`第21列、`Draw request report`第8列收集 Unit。
2. 回写 `Unit Budget!B3:B`。

2. `calculate_unit_budget_c_d`
1. 对 `Unit Budget` 每个 Unit（B列）定位对应 Q列后 Unit列。
2. `C列`：汇总该Unit列中 `K=1` 的值。
3. `D列`：汇总该Unit列中 `M` 末位为 `"3"` 的值。

3. `process_payable`
1. Vendor实体映射写入 `C列`：`WBD/WPRED/WBH/WLM`。
2. 从 `AM` 抽末3位写 `D列` code。
3. 用 `Scoping` 按 code 聚合，回填 `E/F/G`。
4. 从 `V` 抽末4位写 `J` 年份键。

4. `process_final_detail`
1. 行级写 `B:K`：从 `Z` 抽 code、按 `Scoping`聚合、抽年份。
2. 汇总写 `E:H`：以 `Unit Budget B3:B` 为 Unit清单，聚合 `Final Detail` 明细。

## 6. 各表关键字段（便于后续编码映射）
1. `Scoping`：`Group Number`、`Group Name`、`Budget`、`Incurred amount`。
2. `Unit Budget`：`Unit Code(B)`、`预算金额(C)`、`WIP逻辑预算(D)`、`incurred Amount(E)`、`Group(J)`、`GMP(K)`、`Fee(L)`、`WIP(M)`、Q列后 Unit矩阵。
3. `Payable`：实体映射列(`C`)、筛选列(`E`)、年份键(`J`)、Vendor(`O`)、Incurred date(`V`)、金额(`AB`)、code源(`AM`)。
4. `Final Detail`：`Unit`、`code`、日期列、金额列、汇总桥字段(`U/V/T/P`相关)。
5. `Draw request report`：`Draw Date`、`Draw Invoice`、`Unit Code`、阶段/日期字段。
6. `Draw Invoice List`：`Draw Date`、`Vendor Name`、`Invoice #`、`Invoice Date`、`Total`。
7. `Transfer Log`：`Request Number`、`Draw Date`、`Code`、`Deduct/Credit/Total`。
8. `Change Order Log`：`Submitted/Approved Date`、`Code`、`Approved Change Orders`、`Potential Budget Increase`。

## 7. 当前未闭合但已定位的模块
1. `Budget Cost Change Order` 的最终自动取数逻辑（很可能与 `Change Order Log`/`Transfer Log`联动）。
2. `Accounts Receivable-Company` 与 `Draw Invoice`/`Payment`/`Audited` 的滚动链。
3. `General Conditions fee-Audited`、`COGS-Audited` 与 `M列后审计区` 的映射机制。
4. 年度键升级为月度键（上云阶段）时的分桶规则。

## 8. 下一步执行方式（不改逻辑、只推进成熟度）
1. 先补齐第7节的取数映射，形成 `109` 全链路公式字典 v2。
2. 再将字典映射到 Data Adapter（列映射 + 期间键 + 聚合口径）。
3. 最后再做“仅增量单元格回写 + 审计日志”联调。

## 9. 已做的反推校验（当前快照）
1. `Completion Rate for the Period` 与 `POC` 年度差分关系成立（观测年段一致）。
2. `POC Total` 与 `累计COGS / EAC_total` 在当前快照近似一致（小数误差级别）。
3. `WB Home` 分支中 `Material Margin = Income - COGS` 口径与样本值一致。
4. 个别年度行存在“人工调整/审计回填”迹象（并非纯公式推导），因此后续代码实现应保留“手工覆盖优先级”机制。
