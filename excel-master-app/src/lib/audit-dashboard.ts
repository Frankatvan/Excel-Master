import { buildExternalReconSnapshotV2 } from "@/lib/audit-external-recon";
import { buildManualInputSnapshot, discoverYearAxis, findRowByLabelPath } from "@/lib/audit-manual-input";
import { buildFinalDetailCostNameLabel } from "@/lib/audit-external-recon";
import {
  isInternalCompanyVendor,
  normalizeInternalCompanyName,
  type InternalCompanyRegistryRow,
} from "@/lib/internal-company-registry";

export const DEFAULT_SPREADSHEET_ID = "1N6iQ3-7H-I_p0p_Pq_G9U8U5k5l-Mv1mKz_N7D_8_8";

export const RECON_STATES = ["Direct", "ROE", "Income", "Consulting"] as const;

export type SpreadsheetCell = string | number | null | undefined;
export type SpreadsheetRow = SpreadsheetCell[];

export interface HighlightCard {
  label: string;
  value: string;
  color: string;
}

export interface ReconDiscrepancy {
  state: string;
  payable: number;
  final: number;
  diff: number;
}

export type ExternalReconSnapshot = ReturnType<typeof buildExternalReconSnapshotV2>;

export interface ReclassAuditSnapshot {
  overview: {
    payable_amount: number;
    payable_count: number;
    final_detail_amount: number;
    final_detail_count: number;
    diff_count: number;
    old_total: number;
    new_total: number;
    diff_amount: number;
    diff_invoice_count: number;
  };
  table_summaries: Array<{
    source_table: "Payable" | "Final Detail";
    total_amount: number;
    total_count: number;
    changed_amount: number;
    changed_count: number;
    unchanged_amount: number;
    unchanged_count: number;
    before_rows: Array<{
      cost_state: string;
      amount: number;
      count: number;
    }>;
    after_rows: Array<{
      cost_state: string;
      amount: number;
      count: number;
    }>;
    transition_rows: Array<{
      old_cost_state: string;
      new_cost_state: string;
      amount: number;
      count: number;
    }>;
    internal_company_transition_rows: Array<{
      company_name: string;
      old_cost_state: string;
      new_cost_state: string;
      amount: number;
      count: number;
    }>;
  }>;
  category_rows: Array<{
    category: string;
    payable_amount: number;
    payable_count: number;
    final_detail_amount: number;
    final_detail_count: number;
    diff_count: number;
    old_total: number;
    new_total: number;
    diff_amount: number;
    diff_invoice_count: number;
  }>;
  rule_rows: Array<{
    rule_id: string;
    category: string;
    old_cost_states: string[];
    amount: number;
    diff_amount: number;
    invoice_count: number;
  }>;
  invoice_rows: Array<{
    source_table: "Payable" | "Final Detail";
    row_no: number;
    vendor: string;
    amount: number;
    incurred_date: string;
    unit_code: string;
    cost_code: string;
    cost_name: string;
    old_cost_state: string;
    new_category: string;
    rule_id: string;
    match_status?: string;
    present_in_final_detail?: boolean;
  }>;
  internal_company_category_matrix: Array<{
    company_name: string;
    category: string;
    payable_amount: number;
    final_detail_amount: number;
    diff_amount: number;
  }>;
  sankey: {
    nodes: Array<{ name: string }>;
    links: Array<{ source: number; target: number; value: number }>;
  };
}

export interface Compare109Snapshot {
  warnings: Array<{
    code: "MAPPING_AMBIGUITY" | "MAPPING_FALLBACK";
    message: string;
  }>;
  mapping_health?: {
    fallback_count: number;
    fallback_fields: string[];
    mapping_score: number;
    mapping_field_count: number;
  };
  metric_rows: Array<{
    label: string;
    year_rows: Array<{
      year_offset: number;
      year_label: string;
      company: number;
      audit: number;
      diff: number;
      has_value: boolean;
    }>;
  }>;
}

export interface ScopingLogicRow {
  group_number: string;
  group_name: string;
  statuses: {
    gmp: string;
    final_gmp: string;
    fee: string;
    wip: string;
    wtc: string;
    gc: string;
    tbd: string;
  };
  budget: number;
  incurred_amount: number;
}

export interface AuditSnapshot {
  project_name: string;
  highlights: HighlightCard[];
  workflow_stage: string;
  audit_tabs: {
    external_recon: ExternalReconSnapshot;
    manual_input: ReturnType<typeof buildManualInputSnapshot>;
    reclass_audit: ReclassAuditSnapshot;
    compare_109: Compare109Snapshot;
    scoping_logic: ScopingLogicRow[];
  };
}

function readCell(row: SpreadsheetRow | undefined, index: number, fallback = "-"): string {
  const value = row?.[index];
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value);
}

function parseNumber(value: SpreadsheetCell): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/[^0-9.-]/g, "");
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function hasNumericCell(value: SpreadsheetCell): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed || !/[0-9]/.test(trimmed)) {
    return false;
  }
  const parsed = Number.parseFloat(trimmed.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed);
}

function findHeaderRowIndex(rows: SpreadsheetRow[], needle: string): number {
  return rows.findIndex((row) => row.some((cell) => String(cell || "").trim() === needle));
}

function normalizeHeaderToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[()（）]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, "");
}

function findColumnByHeader(headerRow: SpreadsheetRow, aliases: string[], fallbackIndex: number): number {
  const normalizedAliases = new Set(aliases.map((alias) => normalizeHeaderToken(alias)));
  const matchedIndex = headerRow.findIndex((cell) => normalizedAliases.has(normalizeHeaderToken(cell)));
  return matchedIndex >= 0 ? matchedIndex : fallbackIndex;
}

function findOptionalColumnByHeader(headerRow: SpreadsheetRow, aliases: string[]): number | null {
  const normalizedAliases = new Set(aliases.map((alias) => normalizeHeaderToken(alias)));
  const matchedIndex = headerRow.findIndex((cell) => normalizedAliases.has(normalizeHeaderToken(cell)));
  return matchedIndex >= 0 ? matchedIndex : null;
}

function looksLikeHeaderRow(row: SpreadsheetRow | undefined, labels: string[]): boolean {
  if (!row?.length) {
    return false;
  }

  const normalizedLabels = new Set(labels.map((label) => label.trim().toLowerCase()));
  return row.some((cell) => normalizedLabels.has(String(cell || "").trim().toLowerCase()));
}

function stripHeaderRow(rows: SpreadsheetRow[], labels: string[]): SpreadsheetRow[] {
  if (!rows.length) {
    return rows;
  }

  return looksLikeHeaderRow(rows[0], labels) ? rows.slice(1) : rows;
}

function normalizeKeyPart(value: SpreadsheetCell): string {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) {
    return "";
  }
  const numeric = parseNumber(value);
  if (text === String(numeric) || /^[\d,.()-]+$/.test(text)) {
    return numeric.toFixed(2);
  }
  return text;
}

function buildInvoiceMatchKey(parts: SpreadsheetCell[]): string {
  return parts.map(normalizeKeyPart).filter(Boolean).join("|");
}

function readFirstNonEmpty(row: SpreadsheetRow, indexes: number[]): string {
  for (const index of indexes) {
    const value = readCell(row, index, "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function readOldCostState(row: SpreadsheetRow): string {
  return readCell(row, 42, "").trim();
}

function readPayableUnitCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [37, 36, 34]);
}

function readPayableCostCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [38, 37, 35]);
}

function readPayableVendor(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [14]);
}

function readPayableAmount(row: SpreadsheetRow): number {
  return parseNumber(row[20]);
}

function getPayableDataRows(rows: SpreadsheetRow[]): SpreadsheetRow[] {
  return stripHeaderRow(rows, ["Category", "Rule_ID", "Vendor", "Amount", "Cost State"]);
}

function getFinalDetailDataRows(rows: SpreadsheetRow[]): SpreadsheetRow[] {
  return stripHeaderRow(rows, ["Category", "Rule_ID", "Final Date", "Incurred Date", "Cost State", "Amount"]);
}

function readFinalDetailVendor(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [29, 28]);
}

function readFinalDetailAmount(row: SpreadsheetRow): number {
  return parseNumber(row[27]);
}

function readFinalDetailUnitCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [20, 21, 19]);
}

function readFinalDetailCostCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [25]);
}

function readFinalDetailActivityNo(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [22]);
}

function readFinalDetailActivity(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [23]);
}

function readFinalDetailRuleId(row: SpreadsheetRow): string {
  return readCell(row, 1, "").trim();
}

function readFinalDetailCategory(row: SpreadsheetRow): string {
  return readCell(row, 0, "").trim();
}

function readFinalDetailCostState(row: SpreadsheetRow): string {
  return readCell(row, 24, "").trim();
}

function normalizeReclassCategory(value: SpreadsheetCell): string {
  const text = String(value ?? "").trim();
  return text || "未分配";
}

function sortReclassState(left: string, right: string): number {
  if (left === "未分配") return 1;
  if (right === "未分配") return -1;
  return left.localeCompare(right);
}

function addAmountCount<T extends { amount: number; count: number }>(
  map: Map<string, T>,
  key: string,
  create: () => T,
  amount: number,
) {
  const entry = map.get(key) || create();
  entry.amount += amount;
  entry.count += 1;
  map.set(key, entry);
}

function buildReclassTableSummaries(
  invoiceRows: ReclassAuditSnapshot["invoice_rows"],
  internalCompanies: readonly InternalCompanyRegistryRow[],
): ReclassAuditSnapshot["table_summaries"] {
  return (["Payable", "Final Detail"] as const).map((sourceTable) => {
    const rows = invoiceRows.filter((row) => row.source_table === sourceTable);
    const beforeMap = new Map<string, { cost_state: string; amount: number; count: number }>();
    const afterMap = new Map<string, { cost_state: string; amount: number; count: number }>();
    const transitionMap = new Map<
      string,
      { old_cost_state: string; new_cost_state: string; amount: number; count: number }
    >();
    const internalTransitionMap = new Map<
      string,
      { company_name: string; old_cost_state: string; new_cost_state: string; amount: number; count: number }
    >();

    let totalAmount = 0;
    let changedAmount = 0;
    let changedCount = 0;

    rows.forEach((row) => {
      const oldCostState = normalizeReclassCategory(row.old_cost_state);
      const newCostState = normalizeReclassCategory(row.new_category);
      const amount = Number(row.amount || 0);

      totalAmount += amount;
      addAmountCount(beforeMap, oldCostState, () => ({ cost_state: oldCostState, amount: 0, count: 0 }), amount);
      addAmountCount(afterMap, newCostState, () => ({ cost_state: newCostState, amount: 0, count: 0 }), amount);
      addAmountCount(
        transitionMap,
        `${oldCostState}=>${newCostState}`,
        () => ({
          old_cost_state: oldCostState,
          new_cost_state: newCostState,
          amount: 0,
          count: 0,
        }),
        amount,
      );

      if (oldCostState !== newCostState) {
        changedAmount += amount;
        changedCount += 1;
      }

      if (row.vendor && isInternalCompanyVendor(row.vendor, internalCompanies)) {
        const normalizedVendor = normalizeInternalCompanyName(row.vendor);
        const companyName =
          internalCompanies.find((company) => company.normalized_name === normalizedVendor)?.company_name || row.vendor;
        addAmountCount(
          internalTransitionMap,
          `${companyName}::${oldCostState}=>${newCostState}`,
          () => ({
            company_name: companyName,
            old_cost_state: oldCostState,
            new_cost_state: newCostState,
            amount: 0,
            count: 0,
          }),
          amount,
        );
      }
    });

    const sortTransition = <
      T extends { old_cost_state: string; new_cost_state: string; company_name?: string; amount: number; count: number },
    >(
      left: T,
      right: T,
    ) => {
      if (left.company_name && right.company_name && left.company_name !== right.company_name) {
        return left.company_name.localeCompare(right.company_name);
      }
      const oldStateOrder = sortReclassState(left.old_cost_state, right.old_cost_state);
      return oldStateOrder !== 0 ? oldStateOrder : sortReclassState(left.new_cost_state, right.new_cost_state);
    };

    const totalCount = rows.length;
    const unchangedAmount = totalAmount - changedAmount;

    return {
      source_table: sourceTable,
      total_amount: Number(totalAmount.toFixed(2)),
      total_count: totalCount,
      changed_amount: Number(changedAmount.toFixed(2)),
      changed_count: changedCount,
      unchanged_amount: Number(unchangedAmount.toFixed(2)),
      unchanged_count: totalCount - changedCount,
      before_rows: [...beforeMap.values()]
        .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
        .sort((left, right) => sortReclassState(left.cost_state, right.cost_state)),
      after_rows: [...afterMap.values()]
        .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
        .sort((left, right) => sortReclassState(left.cost_state, right.cost_state)),
      transition_rows: [...transitionMap.values()]
        .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
        .sort(sortTransition),
      internal_company_transition_rows: [...internalTransitionMap.values()]
        .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
        .sort(sortTransition),
    };
  });
}

export function normalizeSpreadsheetId(spreadsheetId?: string | string[] | null): string {
  if (Array.isArray(spreadsheetId)) {
    return normalizeSpreadsheetId(spreadsheetId[0]);
  }

  if (!spreadsheetId || spreadsheetId === "MOCK_ID") {
    return DEFAULT_SPREADSHEET_ID;
  }

  return spreadsheetId;
}

export function buildHighlights(kpiRows: SpreadsheetRow[]): HighlightCard[] {
  return [
    { label: "Revenue", value: readCell(kpiRows[2], 6), color: "blue" },
    { label: "Actual Cost", value: readCell(kpiRows[3], 6), color: "indigo" },
    { label: "Gross Margin", value: readCell(kpiRows[4], 6), color: "emerald" },
    { label: "POC (%)", value: readCell(kpiRows[12], 4), color: "purple" },
  ];
}

function buildReclassAuditSnapshot(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
  internalCompanies: readonly InternalCompanyRegistryRow[],
): ReclassAuditSnapshot {
  const overview = {
    payable_amount: 0,
    payable_count: 0,
    final_detail_amount: 0,
    final_detail_count: 0,
    diff_amount: 0,
    diff_count: 0,
    old_total: 0,
    new_total: 0,
    diff_invoice_count: 0,
  };
  const payableTotals: Record<string, number> = {};
  const payableCounts: Record<string, number> = {};
  const finalTotals: Record<string, number> = {};
  const finalCounts: Record<string, number> = {};
  const sankeyLinkTotals = new Map<string, number>();
  const internalCompanyCategoryTotals = new Map<
    string,
    {
      company_name: string;
      category: string;
      payable_amount: number;
      final_detail_amount: number;
    }
  >();
  const ruleMap = new Map<
    string,
    {
      rule_id: string;
      category: string;
      old_cost_states: Set<string>;
      amount: number;
      diff_amount: number;
      invoice_count: number;
    }
  >();
  const invoice_rows: ReclassAuditSnapshot["invoice_rows"] = [];

  getPayableDataRows(payableRows).forEach((row, index) => {
    const newCategory = normalizeReclassCategory(readCell(row, 0, "").trim());
    const ruleId = readCell(row, 1, "").trim();
    const oldCostState = normalizeReclassCategory(readOldCostState(row));
    const amount = readPayableAmount(row);
    const vendor = readPayableVendor(row);

    overview.payable_amount += amount;
    overview.payable_count += 1;
    payableTotals[newCategory] = (payableTotals[newCategory] || 0) + amount;
    payableCounts[newCategory] = (payableCounts[newCategory] || 0) + 1;
    const sankeyKey = `${oldCostState}=>${newCategory}`;
    sankeyLinkTotals.set(sankeyKey, (sankeyLinkTotals.get(sankeyKey) || 0) + amount);

    if (oldCostState !== newCategory) {
      overview.diff_amount += amount;
      overview.diff_count += 1;
    }

    if (vendor && isInternalCompanyVendor(vendor, internalCompanies)) {
      const normalizedVendor = normalizeInternalCompanyName(vendor);
      const companyName =
        internalCompanies.find((company) => company.normalized_name === normalizedVendor)?.company_name || vendor;
      const internalKey = `${companyName}::${newCategory}`;
      const internalEntry = internalCompanyCategoryTotals.get(internalKey) || {
        company_name: companyName,
        category: newCategory,
        payable_amount: 0,
        final_detail_amount: 0,
      };
      internalEntry.payable_amount += amount;
      internalCompanyCategoryTotals.set(internalKey, internalEntry);
    }

    invoice_rows.push({
      source_table: "Payable",
      row_no: index + 1,
      vendor,
      amount,
      incurred_date: readCell(row, 21, "").trim(),
      unit_code: readPayableUnitCode(row),
      cost_code: readPayableCostCode(row),
      cost_name: readCell(row, 39, ""),
      old_cost_state: oldCostState,
      new_category: newCategory,
      rule_id: ruleId,
      match_status: oldCostState === newCategory ? "matched" : "reclassed",
    });

    if (ruleId && ruleId !== "R000") {
      const ruleRow = ruleMap.get(ruleId) || {
        rule_id: ruleId,
        category: newCategory,
        old_cost_states: new Set<string>(),
        amount: 0,
        diff_amount: 0,
        invoice_count: 0,
      };
      ruleRow.old_cost_states.add(oldCostState);
      ruleRow.amount += amount;
      if (oldCostState !== newCategory) {
        ruleRow.diff_amount += amount;
      }
      ruleRow.invoice_count += 1;
      ruleMap.set(ruleId, ruleRow);
    }
  });

  getFinalDetailDataRows(finalDetailRows).forEach((row, index) => {
    const newCategory = normalizeReclassCategory(readFinalDetailCategory(row));
    const oldCostState = normalizeReclassCategory(readFinalDetailCostState(row));
    const amount = readFinalDetailAmount(row);
    const vendor = readFinalDetailVendor(row);

    overview.final_detail_amount += amount;
    overview.final_detail_count += 1;
    finalTotals[newCategory] = (finalTotals[newCategory] || 0) + amount;
    finalCounts[newCategory] = (finalCounts[newCategory] || 0) + 1;

    if (vendor && isInternalCompanyVendor(vendor, internalCompanies)) {
      const normalizedVendor = normalizeInternalCompanyName(vendor);
      const companyName =
        internalCompanies.find((company) => company.normalized_name === normalizedVendor)?.company_name || vendor;
      const internalKey = `${companyName}::${newCategory}`;
      const internalEntry = internalCompanyCategoryTotals.get(internalKey) || {
        company_name: companyName,
        category: newCategory,
        payable_amount: 0,
        final_detail_amount: 0,
      };
      internalEntry.final_detail_amount += amount;
      internalCompanyCategoryTotals.set(internalKey, internalEntry);
    }

    invoice_rows.push({
      source_table: "Final Detail",
      row_no: index + 1,
      vendor,
      amount,
      incurred_date: readCell(row, 19, "").trim(),
      unit_code: readFinalDetailUnitCode(row),
      cost_code: readFinalDetailCostCode(row),
      cost_name: buildFinalDetailCostNameLabel(readFinalDetailActivityNo(row), readFinalDetailActivity(row)),
      old_cost_state: oldCostState,
      new_category: newCategory,
      rule_id: readFinalDetailRuleId(row),
      match_status: oldCostState === newCategory ? "matched" : "reclassed",
      present_in_final_detail: true,
    });
  });

  const table_summaries = buildReclassTableSummaries(invoice_rows, internalCompanies);
  overview.old_total = Number(overview.payable_amount.toFixed(2));
  overview.new_total = Number(overview.final_detail_amount.toFixed(2));
  overview.diff_amount = Number(table_summaries.reduce((sum, row) => sum + row.changed_amount, 0).toFixed(2));
  overview.diff_count = table_summaries.reduce((sum, row) => sum + row.changed_count, 0);
  overview.diff_invoice_count = overview.diff_count;

  const categories = Array.from(new Set([...Object.keys(payableTotals), ...Object.keys(finalTotals)])).sort((a, b) => {
    if (a === "未分配") return 1;
    if (b === "未分配") return -1;
    return a.localeCompare(b);
  });
  const category_rows = categories.map((category) => {
    const payable_amount = Number((payableTotals[category] || 0).toFixed(2));
    const final_detail_amount = Number((finalTotals[category] || 0).toFixed(2));
    const payable_count = payableCounts[category] || 0;
    const final_detail_count = finalCounts[category] || 0;
    const diff_amount = Number((payable_amount - final_detail_amount).toFixed(2));
    const diff_count = payable_count - final_detail_count;

    return {
      category,
      payable_amount,
      payable_count,
      final_detail_amount,
      final_detail_count,
      diff_count,
      old_total: payable_amount,
      new_total: final_detail_amount,
      diff_amount,
      diff_invoice_count: Math.abs(diff_count),
    };
  });

  const rule_rows = [...ruleMap.values()]
    .map((row) => ({
      rule_id: row.rule_id,
      category: row.category,
      old_cost_states: [...row.old_cost_states].sort(),
      amount: Number(row.amount.toFixed(2)),
      diff_amount: Number(row.diff_amount.toFixed(2)),
      invoice_count: row.invoice_count,
    }))
    .sort((a, b) => a.rule_id.localeCompare(b.rule_id));

  const nodeIndex = new Map<string, number>();
  const nodes: Array<{ name: string }> = [];
  const getNodeIndex = (name: string) => {
    const existing = nodeIndex.get(name);
    if (existing !== undefined) {
      return existing;
    }

    const nextIndex = nodes.length;
    nodeIndex.set(name, nextIndex);
    nodes.push({ name });
    return nextIndex;
  };
  const links = [...sankeyLinkTotals.entries()].map(([key, value]) => {
    const [oldCostState, newCategory] = key.split("=>");
    return {
      source: getNodeIndex(`Old ${oldCostState}`),
      target: getNodeIndex(`New ${newCategory}`),
      value: Number(value.toFixed(2)),
    };
  });

  return {
    overview,
    table_summaries,
    category_rows,
    rule_rows,
    invoice_rows,
    internal_company_category_matrix: [...internalCompanyCategoryTotals.values()]
      .map((row) => ({
        ...row,
        payable_amount: Number(row.payable_amount.toFixed(2)),
        final_detail_amount: Number(row.final_detail_amount.toFixed(2)),
        diff_amount: Number((row.payable_amount - row.final_detail_amount).toFixed(2)),
      }))
      .sort((left, right) =>
        left.company_name === right.company_name
          ? left.category.localeCompare(right.category)
          : left.company_name.localeCompare(right.company_name),
      ),
    sankey: {
      nodes,
      links,
    },
  };
}

const COMPARE_109_ROWS = [
  {
    label: "收入",
    companyLabels: [["General Conditions fee-Company"]],
    auditLabels: [["General Conditions fee-Audited"]],
  },
  {
    label: "成本",
    companyLabels: [["Cost of Goods Sold-Company"]],
    auditLabels: [["Cost of Goods Sold-Audited"], ["Audit Adjustment (Current Period)"]],
  },
  {
    label: "毛利",
    companyLabels: [["Gross Profit-Company"]],
    auditLabels: [["Gross Profit-Audit"], ["Gross Profit-Audited"]],
  },
] as const;

type YearAxisColumn = {
  column_index: number;
  year_label: string;
  normalized_year: string;
};

type YearAxisPair = {
  company_columns: YearAxisColumn[];
  audit_columns: YearAxisColumn[];
  warnings: Compare109Snapshot["warnings"];
};

const LEGACY_COMPANY_YEAR_START_COLUMN = 5;
const LEGACY_AUDIT_YEAR_START_COLUMN = 12;
const LEGACY_YEAR_COLUMN_COUNT = 6;

function normalizeYearLabel(value: SpreadsheetCell): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const yearMatch = text.match(/(?:19|20)\d{2}/);
  if (yearMatch) {
    return yearMatch[0];
  }
  if (/^Y\d+$/i.test(text)) {
    return text.toUpperCase();
  }
  return text.toUpperCase();
}

function isContiguousColumns(columns: YearAxisColumn[]): boolean {
  if (columns.length <= 1) {
    return true;
  }
  return columns.every((column, index) =>
    index === 0 ? true : columns[index - 1].column_index + 1 === column.column_index,
  );
}

function duplicateYearLabels(columns: YearAxisColumn[]): string[] {
  const counts = new Map<string, number>();
  columns.forEach((column) => {
    const normalized = column.normalized_year;
    if (!normalized) {
      return;
    }
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  });
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([year]) => year);
}

function buildLegacyYearAxisPair(rows109: SpreadsheetRow[], warnings: Compare109Snapshot["warnings"]): YearAxisPair {
  const company_columns = Array.from({ length: LEGACY_YEAR_COLUMN_COUNT }, (_, idx) => {
    const column_index = LEGACY_COMPANY_YEAR_START_COLUMN + idx;
    const year_label = readCell(rows109[9], column_index, `Y${idx + 1}`);
    return {
      column_index,
      year_label,
      normalized_year: normalizeYearLabel(year_label),
    };
  });

  const audit_columns = Array.from({ length: LEGACY_YEAR_COLUMN_COUNT }, (_, idx) => {
    const column_index = LEGACY_AUDIT_YEAR_START_COLUMN + idx;
    const year_label = readCell(rows109[9], column_index, company_columns[idx]?.year_label || `Y${idx + 1}`);
    return {
      column_index,
      year_label,
      normalized_year: normalizeYearLabel(year_label),
    };
  });

  warnings.push({
    code: "MAPPING_FALLBACK",
    message: "主表年度轴未识别，已使用兼容模式。",
  });

  return { company_columns, audit_columns, warnings };
}

function discoverCompare109YearAxis(rows109: SpreadsheetRow[]): YearAxisPair {
  const warnings: Compare109Snapshot["warnings"] = [];
  const warningSet = new Set<string>();
  const addWarning = (code: "MAPPING_AMBIGUITY" | "MAPPING_FALLBACK", message: string) => {
    const key = `${code}:${message}`;
    if (warningSet.has(key)) {
      return;
    }
    warningSet.add(key);
    warnings.push({ code, message });
  };

  const discovered = discoverYearAxis(rows109);
  if (!discovered) {
    return buildLegacyYearAxisPair(rows109, warnings);
  }

  const axisLength = discovered.endColumnIndex - discovered.startColumnIndex + 1;
  const headerRow = rows109[discovered.rowIndex] || [];
  const company_columns = Array.from({ length: axisLength }, (_, idx) => {
    const column_index = discovered.startColumnIndex + idx;
    const year_label = readCell(headerRow, column_index, `${discovered.years[idx] ?? `Y${idx + 1}`}`);
    return {
      column_index,
      year_label,
      normalized_year: normalizeYearLabel(year_label),
    };
  });

  if (!isContiguousColumns(company_columns)) {
    addWarning("MAPPING_AMBIGUITY", "Company 年度列不连续，请检查主表表头。");
  }
  const companyDuplicateYears = duplicateYearLabels(company_columns);
  if (companyDuplicateYears.length > 0) {
    addWarning(
      "MAPPING_AMBIGUITY",
      `Company 年度列存在重复标签：${companyDuplicateYears.join(", ")}`,
    );
  }

  const audit_columns = company_columns.map((companyColumn, idx) => {
    const matchedColumns: number[] = [];

    for (let colIndex = companyColumn.column_index + 1; colIndex < headerRow.length; colIndex += 1) {
      if (normalizeYearLabel(headerRow[colIndex]) === companyColumn.normalized_year) {
        matchedColumns.push(colIndex);
      }
    }

    if (matchedColumns.length > 1) {
      addWarning(
        "MAPPING_AMBIGUITY",
        `Audit 年度列存在重复候选：${companyColumn.year_label}（第 ${idx + 1} 年）。`,
      );
    }

    if (matchedColumns.length === 0) {
      addWarning(
        "MAPPING_AMBIGUITY",
        `Audit 年度列缺失：${companyColumn.year_label}，将按 Company 列回退读取。`,
      );
    }

    const column_index = matchedColumns[0] ?? companyColumn.column_index;

    const year_label = readCell(headerRow, column_index, companyColumn.year_label);
    return {
      column_index,
      year_label,
      normalized_year: normalizeYearLabel(year_label),
    };
  });

  if (!isContiguousColumns(audit_columns)) {
    addWarning("MAPPING_AMBIGUITY", "Audit 年度列不连续，请检查主表表头。");
  }
  const auditDuplicateYears = duplicateYearLabels(audit_columns);
  if (auditDuplicateYears.length > 0) {
    addWarning(
      "MAPPING_AMBIGUITY",
      `Audit 年度列存在重复标签：${auditDuplicateYears.join(", ")}`,
    );
  }

  if (audit_columns.length !== company_columns.length) {
    addWarning("MAPPING_AMBIGUITY", "Company 与 Audit 年度列长度不一致。");
  }

  return { company_columns, audit_columns, warnings };
}

export function build109CompareSnapshot(
  rows109: SpreadsheetRow[],
  mappingHealth?: {
    fallback_count?: number;
    fallback_fields?: string[];
    mapping_score?: number;
    mapping_field_count?: number;
  },
): Compare109Snapshot {
  const axis = discoverCompare109YearAxis(rows109);
  const resolveMetricRow = (labels: readonly (readonly string[])[]) => {
    for (const labelPath of labels) {
      const rowIndex = findRowByLabelPath(rows109, [...labelPath]);
      if (rowIndex !== null) {
        return rowIndex;
      }
    }
    return null;
  };

  const namedMetricMap = COMPARE_109_ROWS.reduce(
    (accumulator, { companyLabels, auditLabels, label }) => {
      const companyRowIndex = resolveMetricRow(companyLabels);
      const auditRowIndex = resolveMetricRow(auditLabels);
      const yearMap = axis.company_columns.reduce<
        Record<string, { company: number; audit: number; diff: number; has_value: boolean }>
      >(
        (yearAccumulator, yearColumn, idx) => {
          const auditColumn = axis.audit_columns[idx] || yearColumn;
          const companyCell =
            companyRowIndex === null ? undefined : rows109[companyRowIndex]?.[yearColumn.column_index];
          const auditCell = auditRowIndex === null ? undefined : rows109[auditRowIndex]?.[auditColumn.column_index];
          const company = parseNumber(companyCell);
          const audit = parseNumber(auditCell);
          const yearKey = `${yearColumn.year_label || `Y${idx + 1}`}::${idx}`;
          yearAccumulator[yearKey] = {
            company,
            audit,
            diff: Number((company - audit).toFixed(2)),
            has_value: hasNumericCell(companyCell) || hasNumericCell(auditCell),
          };
          return yearAccumulator;
        },
        {},
      );
      accumulator[label] = yearMap;
      return accumulator;
    },
    {} as Record<string, Record<string, { company: number; audit: number; diff: number; has_value: boolean }>>,
  );

  return {
    warnings: axis.warnings,
    mapping_health: mappingHealth
      ? {
          fallback_count: Number(mappingHealth.fallback_count || 0),
          fallback_fields: Array.isArray(mappingHealth.fallback_fields)
            ? mappingHealth.fallback_fields.map((field) => String(field))
            : [],
          mapping_score: Number(mappingHealth.mapping_score || 0),
          mapping_field_count: Number(mappingHealth.mapping_field_count || 0),
        }
      : undefined,
    metric_rows: COMPARE_109_ROWS.map(({ label }) => ({
      label,
      year_rows: axis.company_columns.map((yearColumn, idx) => {
        const yearKey = `${yearColumn.year_label || `Y${idx + 1}`}::${idx}`;
        const metric = namedMetricMap[label]?.[yearKey] || {
          company: 0,
          audit: 0,
          diff: 0,
          has_value: false,
        };

        return {
          year_offset: idx,
          year_label: yearColumn.year_label || `Y${idx + 1}`,
          company: metric.company,
          audit: metric.audit,
          diff: metric.diff,
          has_value: metric.has_value,
        };
      }),
    })),
  };
}

function buildScopingLogicSnapshot(scopingRows: SpreadsheetRow[]): ScopingLogicRow[] {
  const headerIndex = findHeaderRowIndex(scopingRows, "Group Number");
  const headerRow = headerIndex >= 0 ? scopingRows[headerIndex] || [] : [];
  const dataRows = headerIndex >= 0 ? scopingRows.slice(headerIndex + 1) : scopingRows.slice(1);
  const finalGmpColumn = findOptionalColumnByHeader(headerRow, ["Final GMP"]);
  const hasFinalGmpColumn = finalGmpColumn !== null;
  const groupNumberColumn = findColumnByHeader(headerRow, ["Group Number"], 2);
  const groupNameColumn = findColumnByHeader(headerRow, ["Group Name"], 3);
  const gmpColumn = findColumnByHeader(headerRow, ["GMP"], 4);
  const feeColumn = findColumnByHeader(headerRow, ["Fee"], hasFinalGmpColumn ? 6 : 5);
  const wipColumn = findColumnByHeader(headerRow, ["WIP"], hasFinalGmpColumn ? 7 : 6);
  const wtcColumn = findColumnByHeader(headerRow, ["WTC"], hasFinalGmpColumn ? 8 : 7);
  const gcColumn = findColumnByHeader(headerRow, ["GC"], hasFinalGmpColumn ? 9 : 8);
  const tbdColumn = findColumnByHeader(headerRow, ["TBD"], hasFinalGmpColumn ? 10 : 9);
  const budgetColumn = findColumnByHeader(headerRow, ["Budget amount", "Budget"], hasFinalGmpColumn ? 13 : 12);
  const incurredAmountColumn = findColumnByHeader(headerRow, ["Incurred amount", "Incurred Amount"], hasFinalGmpColumn ? 14 : 13);

  return dataRows
    .map((row) => ({
      group_number: readCell(row, groupNumberColumn, "").trim(),
      group_name: readCell(row, groupNameColumn, "").trim(),
      statuses: {
        gmp: readCell(row, gmpColumn, "").trim(),
        final_gmp: readCell(row, finalGmpColumn ?? -1, "").trim(),
        fee: readCell(row, feeColumn, "").trim(),
        wip: readCell(row, wipColumn, "").trim(),
        wtc: readCell(row, wtcColumn, "").trim(),
        gc: readCell(row, gcColumn, "").trim(),
        tbd: readCell(row, tbdColumn, "").trim(),
      },
      budget: parseNumber(row[budgetColumn]),
      incurred_amount: parseNumber(row[incurredAmountColumn]),
    }))
    .filter((row) => row.group_number && (row.budget !== 0 || row.incurred_amount !== 0));
}

function inferWorkflowStage(
  externalRecon: ExternalReconSnapshot,
  reclassAudit: ReclassAuditSnapshot,
  compare109: Compare109Snapshot,
  scopingLogic: ScopingLogicRow[],
): string {
  if (reclassAudit.overview.diff_invoice_count > 0) {
    return "Reclass Audit";
  }

  const has109Diff = compare109.metric_rows.some((metric) => metric.year_rows.some((row) => Math.abs(row.diff) > 1));
  if (has109Diff) {
    return "Main Sheet Compare";
  }

  const hasExternalData =
    externalRecon.discrepancies.some((row) => Math.abs(row.payable) > 0 || Math.abs(row.final) > 0) ||
    externalRecon.unit_budget_variances.length > 0 ||
    externalRecon.invoice_match_overview.payable_total_invoices > 0;
  if (hasExternalData) {
    return "External Recon";
  }

  if (scopingLogic.length > 0) {
    return "Scoping Setup";
  }

  return "Project Setup";
}

export function buildAuditSnapshot({
  projectName,
  kpiRows,
  payableRows,
  finalDetailRows,
  drawRequestRows = [],
  unitBudgetRows = [],
  unitMasterRows = [],
  scopingRows = [],
  rows109 = [],
  internalCompanies = [],
  mappingHealth,
}: {
  projectName: string;
  kpiRows: SpreadsheetRow[];
  payableRows: SpreadsheetRow[];
  finalDetailRows: SpreadsheetRow[];
  drawRequestRows?: SpreadsheetRow[];
  unitBudgetRows?: SpreadsheetRow[];
  unitMasterRows?: SpreadsheetRow[];
  scopingRows?: SpreadsheetRow[];
  rows109?: SpreadsheetRow[];
  internalCompanies?: Array<{
    company_name: string;
    normalized_name: string;
  }>;
  mappingHealth?: {
    fallback_count?: number;
    fallback_fields?: string[];
    mapping_score?: number;
    mapping_field_count?: number;
  };
}): AuditSnapshot {
  const externalRecon = buildExternalReconSnapshotV2({
    unitBudgetRows: unitBudgetRows.length ? unitBudgetRows : unitMasterRows,
    unitMasterRows,
    payableRows,
    finalDetailRows,
    drawRequestRows,
    internalCompanies,
  });
  const reclassAudit = buildReclassAuditSnapshot(payableRows, finalDetailRows, internalCompanies);
  const compare109 = build109CompareSnapshot(rows109, mappingHealth);
  const scopingLogic = buildScopingLogicSnapshot(scopingRows);
  const manualInput = buildManualInputSnapshot({
    rows109,
    scopingRows,
    unitMasterRows,
  });

  return {
    project_name: projectName || "Unnamed Project",
    highlights: buildHighlights(kpiRows),
    workflow_stage: inferWorkflowStage(externalRecon, reclassAudit, compare109, scopingLogic),
    audit_tabs: {
      external_recon: externalRecon,
      manual_input: manualInput,
      reclass_audit: reclassAudit,
      compare_109: compare109,
      scoping_logic: scopingLogic,
    },
  };
}
