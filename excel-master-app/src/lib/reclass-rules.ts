export interface ReclassRule {
  rule_id: string;
  category: string;
  sheet_scope: string[];
  reason_zh: string;
  reason_en: string;
}

export const RECLASS_RULES: ReclassRule[] = [
  {
    rule_id: "R000",
    category: "Excluded",
    sheet_scope: ["Final Detail"],
    reason_zh: "Type 为 Sharing 的记录（仅限 Final Detail）排除在成本重分类之外",
    reason_en: "Rows with Type='Sharing' (Final Detail only) are excluded from cost reclassification",
  },
  {
    rule_id: "R101",
    category: "GC",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "Unit Code 包含 General Condition 关键字",
    reason_en: "Unit Code contains 'General Condition' keyword",
  },
  {
    rule_id: "R102",
    category: "Consulting",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：WTC (4) + 供应商为 WB Texas Consulting LLC",
    reason_en: "Before Settlement: WTC (4) + Vendor is WB Texas Consulting LLC",
  },
  {
    rule_id: "R103",
    category: "GC2",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：WTC (4) + 供应商非关联咨询商",
    reason_en: "Before Settlement: WTC (4) + Non-associated consulting vendor",
  },
  {
    rule_id: "R104",
    category: "GC Income",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：Final GMP (1) + GC (5) + 供应商为 Wan Pacific",
    reason_en: "Before Settlement: Final GMP (1) + GC (5) + Vendor is Wan Pacific",
  },
  {
    rule_id: "R105",
    category: "GC",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：Final GMP (1) + GC (5) + 供应商非 Wan Pacific",
    reason_en: "Before Settlement: Final GMP (1) + GC (5) + Vendor is not Wan Pacific",
  },
  {
    rule_id: "R106",
    category: "Income",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：Final GMP (1) + Fee (2) + 供应商为 Wan Pacific",
    reason_en: "Before Settlement: Final GMP (1) + Fee (2) + Vendor is Wan Pacific",
  },
  {
    rule_id: "R107",
    category: "ROE",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：标准 ROE 特征 (Final GMP/Fee)",
    reason_en: "Before Settlement: Standard ROE features (Final GMP/Fee)",
  },
  {
    rule_id: "R108",
    category: "Direct",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算前：未命中任何 Scoping 标识（非 GMP 成本兜底）",
    reason_en: "Before Settlement: No Scoping status matched (Direct fallback)",
  },
  {
    rule_id: "R201",
    category: "ACC",
    sheet_scope: ["Final Detail"],
    reason_zh: "结算后：仅有 Final Date 且无 Incurred Date",
    reason_en: "After Settlement: Only Final Date present with no Incurred Date",
  },
  {
    rule_id: "R202",
    category: "RACC",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算后：命中跨表或成对的 RACC 配对键",
    reason_en: "After Settlement: Matched cross-sheet or paired RACC key",
  },
  {
    rule_id: "R203",
    category: "TBD",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算后：(有效日期 > TBD Acceptance Date) 且 (Scoping J列 = 6)",
    reason_en: "After Settlement: (Date > TBD Acceptance Date) AND (Scoping Column J = 6)",
  },
  {
    rule_id: "R204",
    category: "RACC2",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算后：发生日 <= 保修到期日，且符合 Final GMP/Fee ROE 特征",
    reason_en: "After Settlement: Date <= Warranty Expiry AND matches Final GMP/Fee ROE features",
  },
  {
    rule_id: "R205",
    category: "EXP",
    sheet_scope: ["Payable", "Final Detail"],
    reason_zh: "结算后支出兜底",
    reason_en: "After Settlement: General expense fallback",
  },
  {
    rule_id: "R301",
    category: "RACC",
    sheet_scope: ["Payable"],
    reason_zh: "Restore: 结算前后窗口修正（Payable 端，独立判定）",
    reason_en: "Restore: Settlement-window correction for Payable side (standalone)",
  },
  {
    rule_id: "R302",
    category: "ACC",
    sheet_scope: ["Final Detail"],
    reason_zh: "Restore: 结算前后窗口修正（Final Detail 端，独立判定）",
    reason_en: "Restore: Settlement-window correction for Final Detail side (standalone)",
  },
];
