import type { SpreadsheetRow } from "@/lib/audit-dashboard";

type MatchStrategy = "exact" | "alias" | "fuzzy" | "manual";

export type FieldMappingCandidate = {
  logical_field: string;
  column_index: number; // 1-based
  column_letter: string;
  header_value: string;
  match_strategy: MatchStrategy;
  confidence: number;
  is_required: boolean;
  is_selected: boolean;
  rejection_reason: string | null;
};

export type SheetDiscoveryResult = {
  sheet_name: string;
  header_row_index: number; // 1-based
  header_cells: string[];
  candidates: FieldMappingCandidate[];
};

type FieldMappingConfig = {
  logical_field: string;
  aliases: string[];
  required: boolean;
  fixed_column_index?: number; // 1-based
};

const SHEET_FIELD_CONFIGS: Record<string, FieldMappingConfig[]> = {
  Payable: [
    { logical_field: "vendor", aliases: ["Vendor"], required: true },
    { logical_field: "invoice_no", aliases: ["Invoice No", "Invoice #", "Invoice"], required: false },
    { logical_field: "amount", aliases: ["Amount"], required: true },
    { logical_field: "incurred_date", aliases: ["Incurred Date"], required: false },
    { logical_field: "unit_code", aliases: ["Unit Code", "Unit"], required: false },
    { logical_field: "cost_code", aliases: ["Cost Code"], required: false },
    { logical_field: "cost_name", aliases: ["Cost Name", "Activity"], required: false },
    { logical_field: "raw_cost_state", aliases: ["Cost State"], required: false },
  ],
  "Final Detail": [
    { logical_field: "vendor", aliases: ["Vendor"], required: true },
    { logical_field: "amount", aliases: ["Amount"], required: true },
    { logical_field: "incurred_date", aliases: ["Incurred Date", "Posting Date 1"], required: false },
    { logical_field: "unit_code", aliases: ["Unit Code", "Unit"], required: false },
    { logical_field: "cost_code", aliases: ["Cost Code"], required: false },
    { logical_field: "cost_name", aliases: ["Cost Name", "Activity"], required: false },
    { logical_field: "raw_cost_state", aliases: ["Cost State"], required: false },
    { logical_field: "record_type", aliases: ["Type"], required: false },
  ],
  "Draw request report": [
    { logical_field: "draw_invoice", aliases: ["Draw Invoice"], required: false },
    { logical_field: "invoice_no", aliases: ["Invoiced No", "Invoice No", "Invoice #", "Invoice"], required: false },
    { logical_field: "vendor", aliases: ["Vendor"], required: true },
    { logical_field: "unit_code", aliases: ["Unit Code"], required: false },
    { logical_field: "incurred_date", aliases: ["Incurred Date"], required: false },
    { logical_field: "cost_code", aliases: ["Cost Code"], required: false },
    { logical_field: "cost_name", aliases: ["Activity"], required: false },
    { logical_field: "amount", aliases: ["Amount"], required: true },
    // Draw cost state is contractually pinned to C column.
    { logical_field: "raw_cost_state", aliases: ["Cost State"], required: false, fixed_column_index: 3 },
  ],
  Scoping: [
    { logical_field: "group_number", aliases: ["Group Number", "Group"], required: false },
    { logical_field: "budget_amount", aliases: ["Budget amount", "Budget Amount"], required: false },
    { logical_field: "incurred_amount", aliases: ["Incurred amount", "Incurred Amount"], required: false },
  ],
  "Unit Master": [
    { logical_field: "unit_code", aliases: ["Unit Code"], required: false },
    { logical_field: "co_date", aliases: ["C/O date", "CO date"], required: false },
    { logical_field: "final_date", aliases: ["Final Date"], required: false },
    { logical_field: "actual_settlement_date", aliases: ["Actual Settlement Date"], required: false },
    { logical_field: "tbd_acceptance_date", aliases: ["TBD Acceptance Date"], required: false },
  ],
  // Logical role key for main-sheet semantics (not a hardcoded physical sheet title).
  "109": [
    { logical_field: "poc_cumulative_ratio", aliases: ["累积完工比例", "POC (%)"], required: false },
    { logical_field: "poc_current_ratio", aliases: ["当期完工比例"], required: false },
    { logical_field: "contract_variation_amount", aliases: ["合同变动金额"], required: false },
    { logical_field: "period_revenue_amount", aliases: ["当期计算收入"], required: false },
    { logical_field: "roe_cost_wb_home", aliases: ["ROE成本 - WB Home"], required: false },
    { logical_field: "wb_home_income", aliases: ["WB Home收入"], required: false },
  ],
};

function normalizeHeaderValue(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, "");
}

function toColumnLetter(columnIndex1Based: number): string {
  let value = columnIndex1Based;
  let out = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }

  return out;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tokenOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  });
  const union = leftTokens.size + rightTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function findHeaderRowIndex(rows: SpreadsheetRow[], aliases: string[][]): number {
  let bestIndex = 0;
  let bestScore = -1;

  rows.forEach((row, rowIndex) => {
    const normalizedCells = row.map((cell) => normalizeHeaderValue(cell));
    const score = aliases.reduce((acc, group) => {
      const hasMatch = group.some((alias) => normalizedCells.includes(normalizeHeaderValue(alias)));
      return acc + (hasMatch ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = rowIndex;
    }
  });

  return bestIndex;
}

function buildCandidatesForField(
  field: FieldMappingConfig,
  headerCells: string[],
): FieldMappingCandidate[] {
  const candidates: FieldMappingCandidate[] = [];
  const normalizedAliases = field.aliases.map((alias) => normalizeHeaderValue(alias));

  if (field.fixed_column_index && field.fixed_column_index >= 1) {
    const fixedIndex = field.fixed_column_index;
    const headerValue = headerCells[fixedIndex - 1] || "";
    candidates.push({
      logical_field: field.logical_field,
      column_index: fixedIndex,
      column_letter: toColumnLetter(fixedIndex),
      header_value: headerValue,
      match_strategy: "manual",
      confidence: 1,
      is_required: field.required,
      is_selected: false,
      rejection_reason: null,
    });
  }

  headerCells.forEach((rawHeaderValue, zeroBasedIndex) => {
    const normalizedHeader = normalizeHeaderValue(rawHeaderValue);
    if (!normalizedHeader) {
      return;
    }

    const exactAlias = normalizedAliases.find((alias) => alias === normalizedHeader);
    if (exactAlias) {
      candidates.push({
        logical_field: field.logical_field,
        column_index: zeroBasedIndex + 1,
        column_letter: toColumnLetter(zeroBasedIndex + 1),
        header_value: rawHeaderValue,
        match_strategy: "exact",
        confidence: 1,
        is_required: field.required,
        is_selected: false,
        rejection_reason: null,
      });
      return;
    }

    let bestFuzzy = 0;
    for (const alias of normalizedAliases) {
      bestFuzzy = Math.max(bestFuzzy, tokenOverlapScore(alias, normalizedHeader));
      if (alias && normalizedHeader.includes(alias)) {
        bestFuzzy = Math.max(bestFuzzy, 0.9);
      }
    }

    if (bestFuzzy >= 0.6) {
      candidates.push({
        logical_field: field.logical_field,
        column_index: zeroBasedIndex + 1,
        column_letter: toColumnLetter(zeroBasedIndex + 1),
        header_value: rawHeaderValue,
        match_strategy: bestFuzzy >= 0.85 ? "alias" : "fuzzy",
        confidence: clampConfidence(bestFuzzy),
        is_required: field.required,
        is_selected: false,
        rejection_reason: null,
      });
    }
  });

  const deduped = new Map<string, FieldMappingCandidate>();
  candidates.forEach((candidate) => {
    const key = `${candidate.logical_field}::${candidate.column_index}`;
    const prev = deduped.get(key);
    if (!prev || prev.confidence < candidate.confidence) {
      deduped.set(key, candidate);
    }
  });

  return [...deduped.values()].sort((a, b) => b.confidence - a.confidence);
}

export function discoverSheetFieldCandidates(
  sheetName: string,
  rows: SpreadsheetRow[],
): SheetDiscoveryResult | null {
  const fieldConfig = SHEET_FIELD_CONFIGS[sheetName];
  if (!fieldConfig || fieldConfig.length === 0 || rows.length === 0) {
    return null;
  }

  const headerRowIndex = findHeaderRowIndex(
    rows,
    fieldConfig.map((field) => field.aliases),
  );
  const headerCells = (rows[headerRowIndex] || []).map((cell) => String(cell ?? "").trim());
  const candidates: FieldMappingCandidate[] = [];

  fieldConfig.forEach((field) => {
    const fieldCandidates = buildCandidatesForField(field, headerCells);
    if (fieldCandidates.length === 0) {
      return;
    }

    const topColumnIndex = fieldCandidates[0].column_index;
    fieldCandidates.forEach((candidate) => {
      candidate.is_selected = candidate.column_index === topColumnIndex;
      if (!candidate.is_selected) {
        candidate.rejection_reason = "lower_confidence";
      }
    });
    candidates.push(...fieldCandidates);
  });

  return {
    sheet_name: sheetName,
    header_row_index: headerRowIndex + 1,
    header_cells: headerCells,
    candidates,
  };
}

export function buildSheetDiscoveries(rowsBySheetName: Record<string, SpreadsheetRow[]>): SheetDiscoveryResult[] {
  return Object.entries(rowsBySheetName)
    .map(([sheetName, rows]) => discoverSheetFieldCandidates(sheetName, rows))
    .filter((result): result is SheetDiscoveryResult => Boolean(result));
}
