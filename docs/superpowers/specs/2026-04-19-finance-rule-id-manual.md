# Finance Rule ID Audit Manual

## R000

- Category: `Excluded`
- Sheet Scope: `Final Detail`
- 中文判定依据：Type 为 Sharing 的记录（仅限 Final Detail）排除在成本重分类之外
- English Reason: Rows with Type='Sharing' (Final Detail only) are excluded from cost reclassification
- 典型字段 / Key Fields: `Type`

## R101

- Category: `GC`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：Unit Code 包含 General Condition 关键字
- English Reason: Unit Code contains 'General Condition' keyword
- 典型字段 / Key Fields: `unit_code`

## R102

- Category: `Consulting`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：WTC (4) + 供应商为 WB Texas Consulting LLC
- English Reason: Before Settlement: WTC (4) + Vendor is WB Texas Consulting LLC
- 典型字段 / Key Fields: `statuses`, `vendor`

## R103

- Category: `GC2`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：WTC (4) + 供应商非关联咨询商
- English Reason: Before Settlement: WTC (4) + Non-associated consulting vendor
- 典型字段 / Key Fields: `statuses`, `vendor`

## R104

- Category: `GC Income`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：Final GMP (1) + GC (5) + 供应商为 Wan Pacific
- English Reason: Before Settlement: Final GMP (1) + GC (5) + Vendor is Wan Pacific
- 典型字段 / Key Fields: `statuses`, `vendor`

## R105

- Category: `GC`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：Final GMP (1) + GC (5) + 供应商非 Wan Pacific
- English Reason: Before Settlement: Final GMP (1) + GC (5) + Vendor is not Wan Pacific
- 典型字段 / Key Fields: `statuses`, `vendor`

## R106

- Category: `Income`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：Final GMP (1) + Fee (2) + 供应商为 Wan Pacific
- English Reason: Before Settlement: Final GMP (1) + Fee (2) + Vendor is Wan Pacific
- 典型字段 / Key Fields: `statuses`, `vendor`

## R107

- Category: `ROE`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：标准 ROE 特征 (Final GMP/Fee)
- English Reason: Before Settlement: Standard ROE features (Final GMP/Fee)
- 典型字段 / Key Fields: `statuses`

## R108

- Category: `Direct`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算前：未命中任何 Scoping 标识（非 GMP 成本兜底）
- English Reason: Before Settlement: No Scoping status matched (Direct fallback)
- 典型字段 / Key Fields: `statuses`

## R201

- Category: `ACC`
- Sheet Scope: `Final Detail`
- 中文判定依据：结算后：仅有 Final Date 且无 Incurred Date
- English Reason: After Settlement: Only Final Date present with no Incurred Date
- 典型字段 / Key Fields: `final_date`, `incurred_date`

## R202

- Category: `RACC`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算后：命中跨表或成对的 RACC 配对键
- English Reason: After Settlement: Matched cross-sheet or paired RACC key
- 典型字段 / Key Fields: `payable_racc_keys`, `paired_racc_keys`

## R203

- Category: `TBD`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算后：(有效日期 > TBD Acceptance Date) 且 (Scoping J列 = 6)
- English Reason: After Settlement: (Date > TBD Acceptance Date) AND (Scoping Column J = 6)
- 典型字段 / Key Fields: `event_dt`, `tbd_acceptance_date`, `statuses` (Status 6)

## R204

- Category: `RACC2`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算后：发生日 <= 保修到期日，且符合 Final GMP/Fee ROE 特征
- English Reason: After Settlement: Date <= Warranty Expiry AND matches Final GMP/Fee ROE features
- 典型字段 / Key Fields: `event_dt`, `warranty_expiry_date`, `statuses`

## R205

- Category: `EXP`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算后支出兜底
- English Reason: After Settlement: General expense fallback
- 典型字段 / Key Fields: `event_dt`

## R301

- Category: `RACC`
- Sheet Scope: `Payable`
- 中文判定依据：Restore: 结算前后窗口修正（Payable 端，独立判定）
- English Reason: Restore: Settlement-window correction for Payable side (standalone)
- 典型字段 / Key Fields: `payable_key`, `payable_incurred_date`, `restore_match_status`

## R302

- Category: `ACC`
- Sheet Scope: `Final Detail`
- 中文判定依据：Restore: 结算前后窗口修正（Final Detail 端，独立判定）
- English Reason: Restore: Settlement-window correction for Final Detail side (standalone)
- 典型字段 / Key Fields: `payable_key`, `final_date`, `restore_match_status`
