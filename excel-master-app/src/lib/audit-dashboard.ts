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

export interface ExternalReconSnapshot {
  summary: string;
  discrepancies: ReconDiscrepancy[];
  recon_by_cost_state: ReconDiscrepancy[];
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
}

export interface ReclassAuditSnapshot {
  overview: {
    old_total: number;
    new_total: number;
    diff_amount: number;
    diff_invoice_count: number;
  };
  category_rows: Array<{
    category: string;
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
    vendor: string;
    amount: number;
    incurred_date: string;
    unit_code: string;
    cost_code: string;
    old_cost_state: string;
    new_category: string;
    rule_id: string;
  }>;
  sankey: {
    nodes: Array<{ name: string }>;
    links: Array<{ source: number; target: number; value: number }>;
  };
}

export interface Compare109Snapshot {
  metric_rows: Array<{
    label: string;
    year_rows: Array<{
      year_offset: number;
      year_label: string;
      company: number;
      audit: number;
      diff: number;
    }>;
  }>;
}

export interface ScopingLogicRow {
  group_number: string;
  group_name: string;
  statuses: string[];
  budget: number;
  incurred_amount: number;
}

export interface AuditSnapshot {
  project_name: string;
  highlights: HighlightCard[];
  workflow_stage: string;
  audit_tabs: {
    external_recon: ExternalReconSnapshot;
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

function findHeaderRowIndex(rows: SpreadsheetRow[], needle: string): number {
  return rows.findIndex((row) => row.some((cell) => String(cell || "").trim() === needle));
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
  const explicitValue = readFirstNonEmpty(row, [42, 43]);
  if (explicitValue) {
    return explicitValue;
  }

  for (let index = row.length - 1; index >= 0; index -= 1) {
    const value = readCell(row, index, "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function readPayableUnitCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [37, 36, 34]);
}

function readPayableCostCode(row: SpreadsheetRow): string {
  return readFirstNonEmpty(row, [38, 37, 35]);
}

function getPayableDataRows(rows: SpreadsheetRow[]): SpreadsheetRow[] {
  return stripHeaderRow(rows, ["Category", "Rule_ID", "Vendor", "Amount", "Cost State"]);
}

function getFinalDetailDataRows(rows: SpreadsheetRow[]): SpreadsheetRow[] {
  return stripHeaderRow(rows, ["Category", "Rule_ID", "Final Date", "Incurred Date", "Cost State", "Amount"]);
}

function buildInvoiceMatchOverview(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
  drawRequestRows: SpreadsheetRow[],
): ExternalReconSnapshot["invoice_match_overview"] {
  const payableData = getPayableDataRows(payableRows).filter((row) => readCell(row, 14, "").trim() || readCell(row, 20, "").trim());
  const finalData = getFinalDetailDataRows(finalDetailRows).filter(
    (row) => readCell(row, 20, "").trim() || readCell(row, 27, "").trim(),
  );
  const drawHeaderIndex = findHeaderRowIndex(drawRequestRows, "Sql");
  const drawData = (drawHeaderIndex >= 0 ? drawRequestRows.slice(drawHeaderIndex + 1) : drawRequestRows).filter(
    (row) => readCell(row, 7, "").trim() || readCell(row, 25, "").trim(),
  );

  const finalKeys = new Set(
    finalData.map((row) =>
      buildInvoiceMatchKey([
        row[27],
        row[19],
        row[20],
        row[21],
        row[25],
      ]),
    ),
  );
  const drawKeys = new Set(
    drawData.map((row) =>
      buildInvoiceMatchKey([
        row[25],
        row[14],
        row[7],
        row[21],
        row[19],
      ]),
    ),
  );

  let matchedToFinal = 0;
  let matchedToDraw = 0;
  let matchedToBoth = 0;
  let payableUnmatched = 0;

  for (const row of payableData) {
    const key = buildInvoiceMatchKey([
      row[20],
      row[21],
      row[37],
      row[15],
      row[38],
    ]);
    const hasFinal = finalKeys.has(key);
    const hasDraw = drawKeys.has(key);
    if (hasFinal) {
      matchedToFinal += 1;
    }
    if (hasDraw) {
      matchedToDraw += 1;
    }
    if (hasFinal && hasDraw) {
      matchedToBoth += 1;
    }
    if (!hasFinal && !hasDraw) {
      payableUnmatched += 1;
    }
  }

  return {
    payable_total_invoices: payableData.length,
    final_total_invoices: finalData.length,
    draw_total_invoices: drawData.length,
    matched_to_final: matchedToFinal,
    matched_to_draw: matchedToDraw,
    matched_to_both: matchedToBoth,
    payable_unmatched: payableUnmatched,
    final_only: Math.max(finalData.length - matchedToFinal, 0),
    draw_only: Math.max(drawData.length - matchedToDraw, 0),
  };
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
  const kpiRow = kpiRows[1] || [];

  return [
    { label: "Revenue", value: readCell(kpiRow, 1), color: "blue" },
    { label: "Actual Cost", value: readCell(kpiRow, 2), color: "indigo" },
    { label: "Gross Margin", value: readCell(kpiRow, 3), color: "emerald" },
    { label: "POC (%)", value: readCell(kpiRow, 9), color: "purple" },
  ];
}

export function buildReconDiscrepancies(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
): ReconDiscrepancy[] {
  const payableTotals: Record<string, number> = {};
  const finalTotals: Record<string, number> = {};

  for (const row of payableRows) {
    const state = readCell(row, 16, "").trim();
    if (!RECON_STATES.includes(state as (typeof RECON_STATES)[number])) {
      continue;
    }
    payableTotals[state] = (payableTotals[state] || 0) + parseNumber(row[0]);
  }

  for (const row of finalDetailRows) {
    const state = readCell(row, 0, "").trim();
    if (!RECON_STATES.includes(state as (typeof RECON_STATES)[number])) {
      continue;
    }
    finalTotals[state] = (finalTotals[state] || 0) + parseNumber(row[3]);
  }

  return RECON_STATES.map((state) => {
    const payable = Number(payableTotals[state] || 0);
    const final = Number(finalTotals[state] || 0);
    return {
      state,
      payable: Number(payable.toFixed(2)),
      final: Number(final.toFixed(2)),
      diff: Number((payable - final).toFixed(2)),
    };
  });
}

function buildCostStateRecon(payableRows: SpreadsheetRow[], finalDetailRows: SpreadsheetRow[]): ReconDiscrepancy[] {
  const payableTotals: Record<string, number> = {};
  const finalTotals: Record<string, number> = {};

  for (const row of getPayableDataRows(payableRows)) {
    const state = readOldCostState(row);
    if (!RECON_STATES.includes(state as (typeof RECON_STATES)[number])) {
      continue;
    }
    payableTotals[state] = (payableTotals[state] || 0) + parseNumber(row[20]);
  }

  for (const row of getFinalDetailDataRows(finalDetailRows)) {
    const state = readCell(row, 0, "").trim();
    if (!RECON_STATES.includes(state as (typeof RECON_STATES)[number])) {
      continue;
    }
    finalTotals[state] = (finalTotals[state] || 0) + parseNumber(row[27]);
  }

  return RECON_STATES.map((state) => {
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

function buildUnitBudgetVariances(unitMasterRows: SpreadsheetRow[]) {
  const headerIndex = findHeaderRowIndex(unitMasterRows, "Unit Code");
  const dataRows = headerIndex >= 0 ? unitMasterRows.slice(headerIndex + 1) : unitMasterRows.slice(1);

  return dataRows
    .map((row) => ({
      unit_code: readCell(row, 0, "").trim(),
      total_budget: parseNumber(row[1]),
      wip_budget: parseNumber(row[3]),
      diff: Number((parseNumber(row[1]) - parseNumber(row[3])).toFixed(2)),
    }))
    .filter((row) => row.unit_code);
}

function buildExternalReconSnapshot(
  payableRows: SpreadsheetRow[],
  finalDetailRows: SpreadsheetRow[],
  drawRequestRows: SpreadsheetRow[],
  unitMasterRows: SpreadsheetRow[],
): ExternalReconSnapshot {
  return {
    summary: "Live Sync Successful",
    discrepancies: buildReconDiscrepancies(payableRows, finalDetailRows),
    recon_by_cost_state: buildCostStateRecon(payableRows, finalDetailRows),
    unit_budget_variances: buildUnitBudgetVariances(unitMasterRows),
    invoice_match_overview: buildInvoiceMatchOverview(payableRows, finalDetailRows, drawRequestRows),
  };
}

function buildReclassAuditSnapshot(payableRows: SpreadsheetRow[]): ReclassAuditSnapshot {
  const overview = { old_total: 0, new_total: 0, diff_amount: 0, diff_invoice_count: 0 };
  const oldTotals: Record<string, number> = {};
  const newTotals: Record<string, number> = {};
  const diffCounts: Record<string, number> = {};
  const sankeyLinkTotals = new Map<string, number>();
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

  for (const row of getPayableDataRows(payableRows)) {
    const newCategory = readCell(row, 0, "").trim();
    const ruleId = readCell(row, 1, "").trim();
    const oldCostState = readOldCostState(row);
    const amount = parseNumber(row[20]);

    if (!oldCostState || !newCategory || ruleId === "R000") {
      continue;
    }

    overview.old_total += amount;
    overview.new_total += amount;
    oldTotals[oldCostState] = (oldTotals[oldCostState] || 0) + amount;
    newTotals[newCategory] = (newTotals[newCategory] || 0) + amount;
    const sankeyKey = `${oldCostState}=>${newCategory}`;
    sankeyLinkTotals.set(sankeyKey, (sankeyLinkTotals.get(sankeyKey) || 0) + amount);

    if (oldCostState !== newCategory) {
      overview.diff_amount += amount;
      overview.diff_invoice_count += 1;
      diffCounts[oldCostState] = (diffCounts[oldCostState] || 0) - amount;
      diffCounts[newCategory] = (diffCounts[newCategory] || 0) + amount;
    }

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

    invoice_rows.push({
      vendor: readCell(row, 14, "").trim(),
      amount,
      incurred_date: readCell(row, 21, "").trim(),
      unit_code: readPayableUnitCode(row),
      cost_code: readPayableCostCode(row),
      old_cost_state: oldCostState,
      new_category: newCategory,
      rule_id: ruleId,
    });
  }

  const categories = Array.from(new Set([...Object.keys(oldTotals), ...Object.keys(newTotals)]));
  const category_rows = categories.map((category) => {
    const old_total = Number((oldTotals[category] || 0).toFixed(2));
    const new_total = Number((newTotals[category] || 0).toFixed(2));
    const diff_amount = Number((new_total - old_total).toFixed(2));
    return {
      category,
      old_total,
      new_total,
      diff_amount,
      diff_invoice_count: Math.abs(diffCounts[category] || 0) > 0 ? 1 : 0,
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
    overview: {
      old_total: Number(overview.old_total.toFixed(2)),
      new_total: Number(overview.new_total.toFixed(2)),
      diff_amount: Number(overview.diff_amount.toFixed(2)),
      diff_invoice_count: overview.diff_invoice_count,
    },
    category_rows,
    rule_rows,
    invoice_rows,
    sankey: {
      nodes,
      links,
    },
  };
}

const COMPARE_109_ROWS = [
  { rowIndex: 18, label: "Current Period Revenue" },
  { rowIndex: 29, label: "Current Period Cost" },
  { rowIndex: 51, label: "Gross Profit" },
] as const;

export function build109CompareSnapshot(rows109: SpreadsheetRow[]): Compare109Snapshot {
  return {
    metric_rows: COMPARE_109_ROWS.map(({ rowIndex, label }) => ({
      label,
      year_rows: Array.from({ length: 6 }, (_, idx) => {
        const yearLabel = readCell(rows109[9], 5 + idx, `Y${idx + 1}`);
        const company = parseNumber(rows109[rowIndex]?.[5 + idx]);
        const audit = parseNumber(rows109[rowIndex]?.[12 + idx]);

        return {
          year_offset: idx,
          year_label: yearLabel,
          company,
          audit,
          diff: Number((company - audit).toFixed(2)),
        };
      }),
    })),
  };
}

function buildScopingLogicSnapshot(scopingRows: SpreadsheetRow[]): ScopingLogicRow[] {
  const headerIndex = findHeaderRowIndex(scopingRows, "Group Number");
  const dataRows = headerIndex >= 0 ? scopingRows.slice(headerIndex + 1) : scopingRows.slice(1);

  return dataRows
    .map((row) => ({
      group_number: readCell(row, 2, "").trim(),
      group_name: readCell(row, 3, "").trim(),
      statuses: [
        readCell(row, 4, "").trim(),
        readCell(row, 5, "").trim(),
        readCell(row, 6, "").trim(),
        readCell(row, 7, "").trim(),
        readCell(row, 8, "").trim(),
        readCell(row, 9, "").trim(),
      ].filter(Boolean),
      budget: parseNumber(row[12]),
      incurred_amount: parseNumber(row[13]),
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
    return "109 Compare";
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
  unitMasterRows = [],
  scopingRows = [],
  rows109 = [],
}: {
  projectName: string;
  kpiRows: SpreadsheetRow[];
  payableRows: SpreadsheetRow[];
  finalDetailRows: SpreadsheetRow[];
  drawRequestRows?: SpreadsheetRow[];
  unitMasterRows?: SpreadsheetRow[];
  scopingRows?: SpreadsheetRow[];
  rows109?: SpreadsheetRow[];
}): AuditSnapshot {
  const externalRecon = buildExternalReconSnapshot(payableRows, finalDetailRows, drawRequestRows, unitMasterRows);
  const reclassAudit = buildReclassAuditSnapshot(payableRows);
  const compare109 = build109CompareSnapshot(rows109);
  const scopingLogic = buildScopingLogicSnapshot(scopingRows);

  return {
    project_name: projectName || "Unnamed Project",
    highlights: buildHighlights(kpiRows),
    workflow_stage: inferWorkflowStage(externalRecon, reclassAudit, compare109, scopingLogic),
    audit_tabs: {
      external_recon: externalRecon,
      reclass_audit: reclassAudit,
      compare_109: compare109,
      scoping_logic: scopingLogic,
    },
  };
}
