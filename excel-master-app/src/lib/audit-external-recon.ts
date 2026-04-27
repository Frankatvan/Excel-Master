import type { SpreadsheetRow } from "@/lib/audit-dashboard";
import {
  isInternalCompanyVendor,
  normalizeInternalCompanyName,
  type InternalCompanyRegistryRow,
} from "@/lib/internal-company-registry";

export interface ExternalReconDetailRow {
  source_table: "Payable" | "Final Detail" | "Draw Request report";
  row_no: number;
  unit_code: string;
  vendor: string;
  old_cost_state: string;
  cost_name: string;
  amount: number;
}

export interface ExternalReconComparisonRow {
  comparison_key: string;
  invoice_label: string;
  vendor: string;
  unit_code: string;
  cost_code: string;
  amount: number;
  payable_cost_states: string[];
  final_detail_cost_states: string[];
  draw_request_cost_states: string[];
  is_fully_aligned: boolean;
}

export interface ExternalReconSnapshotV2 {
  summary: string;
  discrepancies: Array<{
    state: string;
    payable: number;
    final: number;
    diff: number;
  }>;
  recon_by_cost_state: Array<{
    state: string;
    payable: number;
    final: number;
    diff: number;
  }>;
  unit_budget_variances: Array<{
    unit_code: string;
    total_budget: number;
    wip_budget: number;
    diff: number;
  }>;
  invoice_match_overview: {
    payable_total_invoices: number;
    final_total_invoices: number;
    draw_total_invoices: number;
    matched_to_final: number;
    matched_to_draw: number;
    matched_to_both: number;
    payable_unmatched: number;
    final_only: number;
    draw_only: number;
  };
  unit_common_counts: Array<{
    table_name: string;
    unit_count: number;
    common_count: number;
  }>;
  cost_state_matrix: Array<{
    cost_state: string;
    payable_amount: number;
    final_detail_amount: number;
    draw_request_amount: number;
    draw_request_diff_count: number;
  }>;
  cost_state_totals: {
    payable: {
      grouped_total: number;
      raw_total: number;
      mismatch: boolean;
    };
    final_detail: {
      grouped_total: number;
      raw_total: number;
      mismatch: boolean;
    };
    draw_request: {
      grouped_total: number;
      raw_total: number;
      mismatch: boolean;
    };
  };
  internal_company_cost_state_matrix: Array<{
    company_name: string;
    cost_state: string;
    amount: number;
  }>;
  detail_rows: ExternalReconDetailRow[];
  comparison_rows: ExternalReconComparisonRow[];
}

function readCell(row: SpreadsheetRow | undefined, index: number, fallback = ""): string {
  const value = row?.[index];
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return String(value).trim();
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function normalizeCostState(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "未分配";
}

function readFirstNonEmpty(row: SpreadsheetRow, indexes: number[]): string {
  for (const index of indexes) {
    const value = readCell(row, index);
    if (value) {
      return value;
    }
  }

  return "";
}

function looksLikeHeaderRow(row: SpreadsheetRow | undefined, labels: string[]): boolean {
  if (!row?.length) {
    return false;
  }

  const normalizedLabels = new Set(labels.map((label) => label.trim().toLowerCase()));
  return row.some((cell) => normalizedLabels.has(String(cell ?? "").trim().toLowerCase()));
}

function stripHeaderRow(rows: SpreadsheetRow[], labels: string[]): SpreadsheetRow[] {
  if (!rows.length) {
    return rows;
  }

  return looksLikeHeaderRow(rows[0], labels) ? rows.slice(1) : rows;
}

function readPayableUnitCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [37, 36, 34]);
}

function readPayableCostCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [38, 37, 35]);
}

function readPayableCostState(row: SpreadsheetRow): string {
  return normalizeCostState(readFirstNonEmpty(row, [42, 43]) || readCell(row, 16) || readCell(row, 0));
}

function readFinalDetailUnitCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [20, 21, 19]);
}

function readFinalDetailCostCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [25]);
}

function readFinalDetailCostState(row: SpreadsheetRow): string {
  return normalizeCostState(readCell(row, 24) || readCell(row, 0));
}

function readFinalDetailVendor(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [29, 28]);
}

function readDrawRequestUnitCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [7, 8]);
}

function readDrawRequestVendor(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [24]);
}

function readDrawRequestCostState(row: SpreadsheetRow): string {
  return normalizeCostState(readCell(row, 0) || readCell(row, 8));
}

function readDrawRequestCostCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [19]);
}

function readDrawRequestAmount(row: SpreadsheetRow): number {
  return parseNumber(row[25]);
}

function buildInvoiceMatchKey(parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => {
      if (typeof part === "number") {
        return Number.isFinite(part) ? part.toFixed(2) : "";
      }

      const text = String(part ?? "").trim();
      if (!text) {
        return "";
      }

      const normalized = text.replace(/[$,\s]/g, "");
      if (/^-?\(?\d+(?:\.\d+)?\)?$/.test(normalized)) {
        const numeric = Number.parseFloat(normalized.replace(/[()]/g, ""));
        return Number.isFinite(numeric) ? numeric.toFixed(2) : text.toUpperCase();
      }

      return text.toUpperCase();
    })
    .filter(Boolean)
    .join("|");
}

type ColumnAliasMap = Record<string, readonly string[]>;

type PreparedPayableRow = {
  row: SpreadsheetRow;
  vendor: string;
  amount: number;
  unitCode: string;
  costCode: string;
  costName: string;
  costState: string;
  invoiceNo: string;
  incurredDate: string;
};

type PreparedFinalDetailRow = {
  row: SpreadsheetRow;
  vendor: string;
  amount: number;
  unitCode: string;
  costCode: string;
  activityNo: string;
  costName: string;
  costState: string;
  incurredDate: string;
};

type PreparedDrawRequestRow = {
  row: SpreadsheetRow;
  vendor: string;
  amount: number;
  unitCode: string;
  costCode: string;
  costName: string;
  costState: string;
  invoiceNo: string;
  drawInvoice: string;
  incurredDate: string;
};

type ResolvedSheet<TColumns extends string> = {
  columns: Record<TColumns, number>;
  dataRows: SpreadsheetRow[];
  hasHeaderRow: boolean;
};

function normalizeHeaderLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function findHeaderRowIndex(rows: SpreadsheetRow[], aliases: ColumnAliasMap): number {
  const normalizedAliases = Object.values(aliases).map((group) => group.map((label) => normalizeHeaderLabel(label)));

  let bestIndex = -1;
  let bestScore = 0;

  rows.forEach((row, index) => {
    const normalizedCells = row.map((cell) => normalizeHeaderLabel(cell));
    const score = normalizedAliases.reduce((total, group) => {
      return total + (group.some((label) => normalizedCells.includes(label)) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= Math.min(3, normalizedAliases.length) ? bestIndex : -1;
}

function resolveSheet<TColumns extends string>(
  rows: SpreadsheetRow[],
  aliases: Record<TColumns, readonly string[]>,
  fallbacks: Record<TColumns, number>,
): ResolvedSheet<TColumns> {
  const headerRowIndex = findHeaderRowIndex(rows, aliases);
  const headerRow = headerRowIndex >= 0 ? rows[headerRowIndex] : undefined;
  const columns = {} as Record<TColumns, number>;

  (Object.keys(aliases) as TColumns[]).forEach((key) => {
    const fallbackIndex = fallbacks[key];
    const headerIndex =
      headerRow?.findIndex((cell) =>
        aliases[key].some((label) => normalizeHeaderLabel(label) === normalizeHeaderLabel(cell)),
      ) ?? -1;
    columns[key] = headerIndex >= 0 ? headerIndex : fallbackIndex;
  });

  return {
    columns,
    dataRows: headerRowIndex >= 0 ? rows.slice(headerRowIndex + 1) : rows,
    hasHeaderRow: headerRowIndex >= 0,
  };
}

const PAYABLE_ALIASES = {
  vendor: ["Vendor"],
  invoiceNo: ["Invoice No", "Invoice #"],
  amount: ["Amount"],
  incurredDate: ["Incurred Date"],
  unitCode: ["Unit Code"],
  costCode: ["Cost Code"],
  costName: ["Cost Name"],
  costState: ["Cost State"],
} as const;

const PAYABLE_FALLBACKS = {
  vendor: 14,
  invoiceNo: 17,
  amount: 20,
  incurredDate: 21,
  unitCode: 37,
  costCode: 38,
  costName: 39,
  costState: 42,
} as const;

const FINAL_DETAIL_ALIASES = {
  vendor: ["Vendor"],
  amount: ["Amount"],
  incurredDate: ["Incurred Date", "Posting Date 1"],
  unitCode: ["Unit Code", "Unit"],
  costCode: ["Cost Code"],
  activityNo: ["Activity No.", "Activity No"],
  costName: ["Activity", "Cost Name"],
  costState: ["Cost State"],
  type: ["Type"],
} as const;

const FINAL_DETAIL_FALLBACKS = {
  vendor: 29,
  amount: 27,
  incurredDate: 19,
  unitCode: 20,
  costCode: 25,
  activityNo: 22,
  costName: 23,
  costState: 24,
  type: 21,
} as const;

const DRAW_REQUEST_ALIASES = {
  drawInvoice: ["Draw Invoice"],
  unitCode: ["Unit Code"],
  incurredDate: ["Incurred Date"],
  invoiceNo: ["Invoiced No", "Invoice No", "Invoice #", "Invoice"],
  costCode: ["Cost Code"],
  vendor: ["Vendor"],
  amount: ["Amount"],
  activity: ["Activity"],
} as const;

const DRAW_REQUEST_FALLBACKS = {
  drawInvoice: 6,
  unitCode: 10,
  incurredDate: 12,
  invoiceNo: 16,
  costCode: 19,
  vendor: 24,
  amount: 28,
  activity: 18,
} as const;

function rowHasMeaningfulValue(row: SpreadsheetRow, indexes: number[]): boolean {
  return indexes.some((index) => readCell(row, index));
}

function preparePayableRows(rows: SpreadsheetRow[]): PreparedPayableRow[] {
  const sheet = resolveSheet(rows, PAYABLE_ALIASES, PAYABLE_FALLBACKS);

  return sheet.dataRows
    .filter((row) =>
      rowHasMeaningfulValue(row, [
        sheet.columns.vendor,
        sheet.columns.amount,
        sheet.columns.invoiceNo,
        sheet.columns.unitCode,
        sheet.columns.costCode,
      ]),
    )
    .map((row) => ({
      row,
      vendor: readCell(row, sheet.columns.vendor),
      amount: parseNumber(row[sheet.columns.amount]),
      invoiceNo: readCell(row, sheet.columns.invoiceNo),
      incurredDate: readCell(row, sheet.columns.incurredDate),
      unitCode: readCell(row, sheet.columns.unitCode),
      costCode: readCell(row, sheet.columns.costCode),
      costName: readCell(row, sheet.columns.costName),
      costState: normalizeCostState(readCell(row, sheet.columns.costState)),
    }));
}

function prepareFinalDetailRows(rows: SpreadsheetRow[]): PreparedFinalDetailRow[] {
  const sheet = resolveSheet(rows, FINAL_DETAIL_ALIASES, FINAL_DETAIL_FALLBACKS);

  return sheet.dataRows
    .filter((row) => readCell(row, sheet.columns.type).toLowerCase() !== "sharing")
    .filter((row) =>
      rowHasMeaningfulValue(row, [
        sheet.columns.vendor,
        sheet.columns.amount,
        sheet.columns.unitCode,
        sheet.columns.costCode,
      ]),
    )
    .map((row) => ({
      row,
      vendor: readCell(row, sheet.columns.vendor),
      amount: parseNumber(row[sheet.columns.amount]),
      incurredDate: readCell(row, sheet.columns.incurredDate),
      unitCode: readCell(row, sheet.columns.unitCode),
      costCode: readCell(row, sheet.columns.costCode),
      activityNo: readCell(row, sheet.columns.activityNo),
      costName: readCell(row, sheet.columns.costName),
      costState: normalizeCostState(readCell(row, sheet.columns.costState)),
    }));
}

function prepareDrawRequestRows(
  rows: SpreadsheetRow[],
): PreparedDrawRequestRow[] {
  const sheet = resolveSheet(rows, DRAW_REQUEST_ALIASES, DRAW_REQUEST_FALLBACKS);

  return sheet.dataRows
    .filter((row) =>
      rowHasMeaningfulValue(row, [
        sheet.columns.unitCode,
        sheet.columns.amount,
        sheet.columns.invoiceNo,
        sheet.columns.vendor,
        sheet.columns.costCode,
      ]),
    )
    .map((row) => {
      const unitCode = sheet.hasHeaderRow
        ? readCell(row, sheet.columns.unitCode)
        : readFirstNonEmpty(row, [sheet.columns.unitCode, 10, 7, 8]);
      const invoiceNo = sheet.hasHeaderRow
        ? readCell(row, sheet.columns.invoiceNo)
        : readFirstNonEmpty(row, [sheet.columns.invoiceNo, 16, 30]);
      const costCode = sheet.hasHeaderRow ? readCell(row, sheet.columns.costCode) : readFirstNonEmpty(row, [sheet.columns.costCode, 19]);
      const amount = sheet.hasHeaderRow
        ? parseNumber(row[sheet.columns.amount])
        : parseNumber(readFirstNonEmpty(row, [sheet.columns.amount, 28, 25]));
      const vendor = sheet.hasHeaderRow
        ? readCell(row, sheet.columns.vendor)
        : readFirstNonEmpty(row, [sheet.columns.vendor, 24]);
      const drawInvoice = sheet.hasHeaderRow
        ? readCell(row, sheet.columns.drawInvoice)
        : readFirstNonEmpty(row, [sheet.columns.drawInvoice, 6, 9]);
      const incurredDate = sheet.hasHeaderRow
        ? readCell(row, sheet.columns.incurredDate)
        : readFirstNonEmpty(row, [sheet.columns.incurredDate, 12, 13]);

      return {
        row,
        vendor,
        amount,
        unitCode,
        invoiceNo,
        drawInvoice,
        incurredDate,
        costCode,
        costName: sheet.hasHeaderRow ? readCell(row, sheet.columns.activity) : readFirstNonEmpty(row, [sheet.columns.activity, 21]),
        costState: normalizeCostState(readCell(row, 2)),
      };
    });
}

function buildComparisonKey(parts: Array<string | number | null | undefined>): string {
  return buildInvoiceMatchKey(parts);
}

function normalizeVendorForKey(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function normalizeStateList(states: Set<string>) {
  return [...states].sort((left, right) => {
    if (left === "未分配") return 1;
    if (right === "未分配") return -1;
    return left.localeCompare(right);
  });
}

function collectComparisonStates(row: Pick<
  ExternalReconComparisonRow,
  "payable_cost_states" | "final_detail_cost_states" | "draw_request_cost_states"
>): string[] {
  const states = new Set<string>([
    ...row.payable_cost_states,
    ...row.final_detail_cost_states,
    ...row.draw_request_cost_states,
  ]);

  if (states.size === 0) {
    return ["未分配"];
  }

  return normalizeStateList(states);
}

function buildComparisonRows(
  payableRows: PreparedPayableRow[],
  finalDetailRows: PreparedFinalDetailRow[],
  drawRequestRows: PreparedDrawRequestRow[],
): ExternalReconComparisonRow[] {
  const groups = new Map<
    string,
    {
      invoiceLabel: string;
      vendor: string;
      unitCode: string;
      costCode: string;
      amount: number;
      payableStates: Set<string>;
      finalDetailStates: Set<string>;
      drawRequestStates: Set<string>;
    }
  >();

  const ensureGroup = (
    key: string,
    row: {
      invoiceLabel?: string;
      vendor: string;
      unitCode: string;
      costCode: string;
      amount: number;
    },
  ) => {
    const existing = groups.get(key);
    if (existing) {
      if (!existing.invoiceLabel && row.invoiceLabel) existing.invoiceLabel = row.invoiceLabel;
      if (!existing.vendor && row.vendor) existing.vendor = row.vendor;
      if (!existing.unitCode && row.unitCode) existing.unitCode = row.unitCode;
      if (!existing.costCode && row.costCode) existing.costCode = row.costCode;
      if (!existing.amount && row.amount) existing.amount = row.amount;
      return existing;
    }

    const created = {
      invoiceLabel: row.invoiceLabel || "",
      vendor: row.vendor,
      unitCode: row.unitCode,
      costCode: row.costCode,
      amount: row.amount,
      payableStates: new Set<string>(),
      finalDetailStates: new Set<string>(),
      drawRequestStates: new Set<string>(),
    };
    groups.set(key, created);
    return created;
  };

  payableRows.forEach((row) => {
    const key = buildComparisonKey([
      normalizeVendorForKey(row.vendor),
      row.amount,
      row.unitCode,
      row.costCode,
    ]);
    const group = ensureGroup(key, {
      invoiceLabel: row.invoiceNo,
      vendor: row.vendor,
      unitCode: row.unitCode,
      costCode: row.costCode,
      amount: row.amount,
    });
    group.payableStates.add(row.costState);
  });

  finalDetailRows.forEach((row) => {
    const key = buildComparisonKey([
      normalizeVendorForKey(row.vendor),
      row.amount,
      row.unitCode,
      row.costCode,
    ]);
    const group = ensureGroup(key, {
      vendor: row.vendor,
      unitCode: row.unitCode,
      costCode: row.costCode,
      amount: row.amount,
    });
    group.finalDetailStates.add(row.costState);
  });

  drawRequestRows.forEach((row) => {
    const key = buildComparisonKey([
      normalizeVendorForKey(row.vendor),
      row.amount,
      row.unitCode,
      row.costCode,
    ]);
    const group = ensureGroup(key, {
      invoiceLabel: row.invoiceNo || row.drawInvoice,
      vendor: row.vendor,
      unitCode: row.unitCode,
      costCode: row.costCode,
      amount: row.amount,
    });
    group.drawRequestStates.add(row.costState);
  });

  return [...groups.entries()]
    .map(([comparison_key, group]) => {
      const payable_cost_states = normalizeStateList(group.payableStates);
      const final_detail_cost_states = normalizeStateList(group.finalDetailStates);
      const draw_request_cost_states = normalizeStateList(group.drawRequestStates);
      const allStates = new Set([
        ...payable_cost_states,
        ...final_detail_cost_states,
        ...draw_request_cost_states,
      ]);
      const is_fully_aligned =
        payable_cost_states.length > 0 &&
        final_detail_cost_states.length > 0 &&
        draw_request_cost_states.length > 0 &&
        allStates.size === 1;

      return {
        comparison_key,
        invoice_label: group.invoiceLabel,
        vendor: group.vendor,
        unit_code: group.unitCode,
        cost_code: group.costCode,
        amount: Number(group.amount.toFixed(2)),
        payable_cost_states,
        final_detail_cost_states,
        draw_request_cost_states,
        is_fully_aligned,
      };
    })
    .sort((left, right) => {
      if (left.invoice_label && right.invoice_label) {
        return left.invoice_label.localeCompare(right.invoice_label);
      }
      if (left.invoice_label) return -1;
      if (right.invoice_label) return 1;
      return left.comparison_key.localeCompare(right.comparison_key);
    });
}

function buildInvoiceMatchOverview(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
  drawRequestRows: SpreadsheetRow[],
): ExternalReconSnapshotV2["invoice_match_overview"] {
  const preparedPayableRows = preparePayableRows(payableRows);
  const preparedFinalDetailRows = prepareFinalDetailRows(finalDetailRows);
  const preparedDrawRequestRows = prepareDrawRequestRows(drawRequestRows);

  const finalKeys = new Set(
    preparedFinalDetailRows.map((row) =>
      buildInvoiceMatchKey([row.vendor, row.amount, row.incurredDate, row.unitCode, row.costCode]),
    ),
  );
  const drawKeys = new Set(
    preparedDrawRequestRows.map((row) =>
      buildInvoiceMatchKey([row.vendor, row.amount, row.invoiceNo, row.unitCode, row.costCode]),
    ),
  );

  let matchedToFinal = 0;
  let matchedToDraw = 0;
  let matchedToBoth = 0;
  let payableUnmatched = 0;

  for (const row of preparedPayableRows) {
    const key = buildInvoiceMatchKey([row.vendor, row.amount, row.incurredDate, row.unitCode, row.costCode]);
    const hasFinal = finalKeys.has(key);
    const hasDraw = drawKeys.has(key);
    if (hasFinal) matchedToFinal += 1;
    if (hasDraw) matchedToDraw += 1;
    if (hasFinal && hasDraw) matchedToBoth += 1;
    if (!hasFinal && !hasDraw) payableUnmatched += 1;
  }

  return {
    payable_total_invoices: preparedPayableRows.length,
    final_total_invoices: preparedFinalDetailRows.length,
    draw_total_invoices: preparedDrawRequestRows.length,
    matched_to_final: matchedToFinal,
    matched_to_draw: matchedToDraw,
    matched_to_both: matchedToBoth,
    payable_unmatched: payableUnmatched,
    final_only: Math.max(preparedFinalDetailRows.length - matchedToFinal, 0),
    draw_only: Math.max(preparedDrawRequestRows.length - matchedToDraw, 0),
  };
}

export function buildCostNameLabel(costCode: string, costName: string) {
  if (/^\d{3}\s/.test(costName)) return costName.trim();
  const suffix = String(costCode || "").match(/(\d{3})$/)?.[1];
  return suffix ? `${suffix} ${String(costName || "").trim()}`.trim() : String(costName || "").trim();
}

export function buildFinalDetailCostNameLabel(activityNo: string, activity: string) {
  const normalizedActivity = String(activity || "").trim();
  const prefix = String(activityNo || "").trim().match(/\d{3}/)?.[0] || "";
  if (!prefix) return normalizedActivity;
  if (new RegExp(`^${prefix}\\s`).test(normalizedActivity)) return normalizedActivity;
  return `${prefix} ${normalizedActivity}`.trim();
}

function countUnitBudgetColumns(row: SpreadsheetRow | undefined): number {
  if (!row) return 0;

  let count = 0;
  for (let index = 20; index < row.length; index += 1) {
    const value = readCell(row, index);
    if (!value) {
      break;
    }
    if (/\d/.test(value)) {
      count += 1;
    }
  }

  return count;
}

function countUnitBudgetCommonColumns(row: SpreadsheetRow | undefined): number {
  if (!row) return 0;

  const commonLabels = new Set<string>();
  for (let index = 20; index < row.length; index += 1) {
    const value = readCell(row, index);
    if (!value) {
      break;
    }
    if (!/\d/.test(value)) {
      commonLabels.add(normalizeHeaderLabel(value));
    }
  }

  return commonLabels.size;
}

function isUnitCode(value: string): boolean {
  return /\d/.test(String(value || "").trim());
}

function buildUnitCommonCountRows(
  tableName: string,
  rows: Array<{ unitCode: string; commonLabels: string[] }>,
): ExternalReconSnapshotV2["unit_common_counts"][number] {
  const unitCodes = new Set<string>();
  const commonLabels = new Set<string>();
  let unlabeledCommonCount = 0;

  for (const row of rows) {
    const normalizedUnitCode = String(row.unitCode || "").trim();
    if (isUnitCode(normalizedUnitCode)) {
      unitCodes.add(normalizedUnitCode);
      continue;
    }

    const commonLabel = row.commonLabels
      .map((value) => String(value || "").trim())
      .find(Boolean);

    if (commonLabel) {
      commonLabels.add(normalizeHeaderLabel(commonLabel));
      continue;
    }

    unlabeledCommonCount += 1;
  }

  return {
    table_name: tableName,
    unit_count: unitCodes.size,
    common_count: commonLabels.size + unlabeledCommonCount,
  };
}

function buildCostStateMatrixRows(
  payableRows: PreparedPayableRow[],
  finalDetailRows: PreparedFinalDetailRow[],
  drawRequestRows: PreparedDrawRequestRow[],
  comparisonRows: ExternalReconComparisonRow[],
) {
  const costStates = new Set<string>();
  const rows = {
    payable: new Map<string, number>(),
    finalDetail: new Map<string, number>(),
    drawRequest: new Map<string, number>(),
  };

  for (const row of payableRows) {
    costStates.add(row.costState);
    rows.payable.set(row.costState, (rows.payable.get(row.costState) || 0) + row.amount);
  }

  for (const row of finalDetailRows) {
    costStates.add(row.costState);
    rows.finalDetail.set(row.costState, (rows.finalDetail.get(row.costState) || 0) + row.amount);
  }

  for (const row of drawRequestRows) {
    costStates.add(row.costState);
    rows.drawRequest.set(row.costState, (rows.drawRequest.get(row.costState) || 0) + row.amount);
  }

  const orderedStates = [...costStates].sort((left, right) => {
    if (left === "未分配") return 1;
    if (right === "未分配") return -1;
    return left.localeCompare(right);
  });

  return orderedStates.map((cost_state) => {
    const payable_amount = Number((rows.payable.get(cost_state) || 0).toFixed(2));
    const final_detail_amount = Number((rows.finalDetail.get(cost_state) || 0).toFixed(2));
    const draw_request_amount = Number((rows.drawRequest.get(cost_state) || 0).toFixed(2));
    const totalsAligned =
      Math.abs(payable_amount - final_detail_amount) <= 0.01 &&
      Math.abs(payable_amount - draw_request_amount) <= 0.01;

    return {
      cost_state,
      payable_amount,
      final_detail_amount,
      draw_request_amount,
      draw_request_diff_count: totalsAligned
        ? 0
        : comparisonRows.filter(
            (row) => !row.is_fully_aligned && collectComparisonStates(row).includes(cost_state),
          ).length,
    };
  });
}

function buildCostStateTotals(
  costStateMatrix: ExternalReconSnapshotV2["cost_state_matrix"],
  payableRows: PreparedPayableRow[],
  finalDetailRows: PreparedFinalDetailRow[],
  drawRequestRows: PreparedDrawRequestRow[],
): ExternalReconSnapshotV2["cost_state_totals"] {
  const grouped = costStateMatrix.reduce(
    (totals, row) => {
      totals.payable += row.payable_amount;
      totals.final_detail += row.final_detail_amount;
      totals.draw_request += row.draw_request_amount;
      return totals;
    },
    { payable: 0, final_detail: 0, draw_request: 0 },
  );

  const raw = {
    payable: payableRows.reduce((sum, row) => sum + row.amount, 0),
    final_detail: finalDetailRows.reduce((sum, row) => sum + row.amount, 0),
    draw_request: drawRequestRows.reduce((sum, row) => sum + row.amount, 0),
  };

  return {
    payable: {
      grouped_total: Number(grouped.payable.toFixed(2)),
      raw_total: Number(raw.payable.toFixed(2)),
      mismatch: Math.abs(grouped.payable - raw.payable) > 0.01,
    },
    final_detail: {
      grouped_total: Number(grouped.final_detail.toFixed(2)),
      raw_total: Number(raw.final_detail.toFixed(2)),
      mismatch: Math.abs(grouped.final_detail - raw.final_detail) > 0.01,
    },
    draw_request: {
      grouped_total: Number(grouped.draw_request.toFixed(2)),
      raw_total: Number(raw.draw_request.toFixed(2)),
      mismatch: Math.abs(grouped.draw_request - raw.draw_request) > 0.01,
    },
  };
}

function buildInternalCompanyCostStateMatrixRows(
  payableRows: PreparedPayableRow[],
  internalCompanies: readonly InternalCompanyRegistryRow[],
) {
  const matrix = new Map<string, Map<string, number>>();
  const companyNames = new Map<string, string>();

  for (const row of payableRows) {
    if (!row.vendor || !isInternalCompanyVendor(row.vendor, internalCompanies)) {
      continue;
    }

    const normalizedVendor = normalizeInternalCompanyName(row.vendor);
    const match = internalCompanies.find((company) => company.normalized_name === normalizedVendor);
    const companyName = match?.company_name || row.vendor;
    companyNames.set(normalizeInternalCompanyName(companyName), companyName);
    const companyRows = matrix.get(companyName) || new Map<string, number>();
    companyRows.set(row.costState, (companyRows.get(row.costState) || 0) + row.amount);
    matrix.set(companyName, companyRows);
  }

  return [...matrix.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([company_name, costStates]) =>
      [...costStates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([cost_state, amount]) => ({
          company_name: companyNames.get(normalizeInternalCompanyName(company_name)) || company_name,
          cost_state,
          amount: Number(amount.toFixed(2)),
        })),
    );
}

function buildDetailRows(
  payableRows: PreparedPayableRow[],
  finalDetailRows: PreparedFinalDetailRow[],
  drawRequestRows: PreparedDrawRequestRow[],
): ExternalReconDetailRow[] {
  const rows: ExternalReconDetailRow[] = [];

  payableRows.forEach((row, index) => {
    rows.push({
      source_table: "Payable",
      row_no: index + 1,
      unit_code: row.unitCode,
      vendor: row.vendor,
      old_cost_state: row.costState,
      cost_name: row.costName,
      amount: row.amount,
    });
  });

  finalDetailRows.forEach((row, index) => {
    rows.push({
      source_table: "Final Detail",
      row_no: index + 1,
      unit_code: row.unitCode,
      vendor: row.vendor,
      old_cost_state: row.costState,
      cost_name: buildFinalDetailCostNameLabel(row.activityNo, row.costName),
      amount: row.amount,
    });
  });

  drawRequestRows.forEach((row, index) => {
    rows.push({
      source_table: "Draw Request report",
      row_no: index + 1,
      unit_code: row.unitCode,
      vendor: row.vendor,
      old_cost_state: row.costState,
      cost_name: buildCostNameLabel(row.costCode, row.costName),
      amount: row.amount,
    });
  });

  return rows;
}

function buildReconDiscrepancies(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
): ExternalReconSnapshotV2["discrepancies"] {
  const payableTotals: Record<string, number> = {};
  const finalTotals: Record<string, number> = {};
  const states = ["Direct", "ROE", "Income", "Consulting"];

  for (const row of payableRows) {
    const state = readCell(row, 16, "").trim();
    if (!states.includes(state)) continue;
    payableTotals[state] = (payableTotals[state] || 0) + parseNumber(row[0]);
  }

  for (const row of finalDetailRows) {
    const state = readCell(row, 0, "").trim();
    if (!states.includes(state)) continue;
    finalTotals[state] = (finalTotals[state] || 0) + parseNumber(row[3]);
  }

  return states.map((state) => {
    const payable = Number((payableTotals[state] || 0).toFixed(2));
    const final = Number((finalTotals[state] || 0).toFixed(2));
    return {
      state,
      payable,
      final,
      diff: Number((payable - final).toFixed(2)),
    };
  });
}

function buildCostStateRecon(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
): ExternalReconSnapshotV2["recon_by_cost_state"] {
  const preparedPayableRows = preparePayableRows(payableRows);
  const preparedFinalDetailRows = prepareFinalDetailRows(finalDetailRows);
  const payableTotals: Record<string, number> = {};
  const finalTotals: Record<string, number> = {};
  const states = ["Direct", "ROE", "Income", "Consulting"];

  for (const row of preparedPayableRows) {
    const state = row.costState;
    if (!states.includes(state)) continue;
    payableTotals[state] = (payableTotals[state] || 0) + row.amount;
  }

  for (const row of preparedFinalDetailRows) {
    const state = row.costState;
    if (!states.includes(state)) continue;
    finalTotals[state] = (finalTotals[state] || 0) + row.amount;
  }

  return states.map((state) => {
    const payable = Number((payableTotals[state] || 0).toFixed(2));
    const final = Number((finalTotals[state] || 0).toFixed(2));
    return {
      state,
      payable,
      final,
      diff: Number((payable - final).toFixed(2)),
    };
  });
}

function buildUnitBudgetVariances(unitBudgetRows: SpreadsheetRow[]) {
  return unitBudgetRows
    .filter((row) => {
      const totalBudgetCell = String(row[1] ?? "").trim();
      const wipBudgetCell = String(row[3] ?? "").trim();
      return (
        row.some((cell) => String(cell ?? "").trim()) &&
        /^[0-9,.-]+$/.test(totalBudgetCell) &&
        /^[0-9,.-]+$/.test(wipBudgetCell)
      );
    })
    .map((row) => ({
      unit_code: readCell(row, 0),
      total_budget: parseNumber(row[1]),
      wip_budget: parseNumber(row[3]),
      diff: Number((parseNumber(row[1]) - parseNumber(row[3])).toFixed(2)),
    }))
    .filter((row) => row.unit_code);
}

export function buildExternalReconSnapshotV2({
  unitBudgetRows,
  unitMasterRows = [],
  payableRows,
  finalDetailRows,
  drawRequestRows,
  internalCompanies,
}: {
  unitBudgetRows: SpreadsheetRow[];
  unitMasterRows?: SpreadsheetRow[];
  payableRows: SpreadsheetRow[];
  finalDetailRows: SpreadsheetRow[];
  drawRequestRows: SpreadsheetRow[];
  internalCompanies: readonly InternalCompanyRegistryRow[];
}): ExternalReconSnapshotV2 {
  const unitBudgetHeaderRow = unitBudgetRows[0] || unitMasterRows[0];
  const preparedPayableRows = preparePayableRows(payableRows);
  const preparedFinalDetailRows = prepareFinalDetailRows(finalDetailRows);
  const preparedDrawRequestRows = prepareDrawRequestRows(drawRequestRows);
  const comparisonRows = buildComparisonRows(
    preparedPayableRows,
    preparedFinalDetailRows,
    preparedDrawRequestRows,
  );
  const costStateMatrix = buildCostStateMatrixRows(
    preparedPayableRows,
    preparedFinalDetailRows,
    preparedDrawRequestRows,
    comparisonRows,
  );

  return {
    summary: "已同步",
    discrepancies: buildReconDiscrepancies(payableRows, finalDetailRows),
    recon_by_cost_state: buildCostStateRecon(payableRows, finalDetailRows),
    unit_budget_variances: buildUnitBudgetVariances(unitMasterRows),
    invoice_match_overview: buildInvoiceMatchOverview(payableRows, finalDetailRows, drawRequestRows),
    unit_common_counts: [
      {
        table_name: "Unit Budget",
        unit_count: countUnitBudgetColumns(unitBudgetHeaderRow),
        common_count: countUnitBudgetCommonColumns(unitBudgetHeaderRow),
      },
      buildUnitCommonCountRows(
        "Payable",
        preparedPayableRows.map((row) => ({
          unitCode: row.unitCode,
          commonLabels: [row.unitCode, row.costName],
        })),
      ),
      buildUnitCommonCountRows(
        "Final Detail",
        preparedFinalDetailRows.map((row) => ({
          unitCode: row.unitCode,
          commonLabels: [row.unitCode, row.costState, row.costName],
        })),
      ),
      buildUnitCommonCountRows(
        "Draw Request report",
        preparedDrawRequestRows.map((row) => ({
          unitCode: row.unitCode,
          commonLabels: [row.unitCode, row.costCode, row.costName],
        })),
      ),
    ],
    cost_state_matrix: costStateMatrix,
    cost_state_totals: buildCostStateTotals(
      costStateMatrix,
      preparedPayableRows,
      preparedFinalDetailRows,
      preparedDrawRequestRows,
    ),
    internal_company_cost_state_matrix: buildInternalCompanyCostStateMatrixRows(
      preparedPayableRows,
      internalCompanies,
    ),
    detail_rows: buildDetailRows(preparedPayableRows, preparedFinalDetailRows, preparedDrawRequestRows),
    comparison_rows: comparisonRows,
  };
}
