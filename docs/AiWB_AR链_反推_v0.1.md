# AiWB AR链反推 v0.1

日期：`2026-04-17`  
对象：`109` 中应收相关行

## 1. 覆盖范围
1. `Accounts Receivable-Incurred`
2. `Accounts Receivable-Audited`
3. `Accounts Receivable-Company`
4. `Accounts Receivable`
5. 参照行：`General Conditions fee-Company`

## 2. 快照级已验证关系
1. `Accounts Receivable-Incurred_t = - General Conditions fee-Company_t`（逐期一致）。
2. `Accounts Receivable-Company` 在有审计值的期间与 `Accounts Receivable-Audited` 一致（示例：2024）。
3. `Accounts Receivable` 表现为 `Accounts Receivable-Company` 的累计值（running total）。

## 3. 可执行候选公式
1. `AR_incurred_t = -Revenue_company_t`
2. `AR_company_t = IF(AR_audited_t 非空, AR_audited_t, AR_incurred_t)`
3. `AR_balance_t = CUMSUM(AR_company_<=t)`

## 4. 与 Draw/Payment 的关系
1. 当前快照中，`Draw Invoice` 与 `Accounts Receivable-Payment` 未形成稳定单步闭式关系。
2. 这两条更适合作为“对账辅助层”，先不硬编码进主链。

## 5. 实施建议
1. 主链先落 `AR_incurred -> AR_company -> AR_balance`。
2. `Draw/Payment` 先保留展示与审计，不参与自动覆盖。
3. 后续如拿到明确业务口径，再把 Draw/Payment 纳入主链。
