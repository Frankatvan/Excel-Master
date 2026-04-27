import type { SpreadsheetCell, SpreadsheetRow } from "@/lib/audit-dashboard";

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

function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = parseNumber(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (!/[0-9]/.test(trimmed)) {
      return null;
    }
  }
  return parsed;
}

function isNumericEntry(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.includes("/") || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return false;
  }

  return /^\(?-?\$?[\d,\s]+(?:\.\d+)?%?\)?$/.test(trimmed);
}

function isSameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.0001;
}

function normalizeLabelToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[()（）]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5 ]+/g, "");
}

export function findRowByLabelPath(rows109: SpreadsheetRow[], labelPath: string[]): number | null {
  const normalizedPath = labelPath.map((label) => normalizeLabelToken(label)).filter(Boolean);
  if (normalizedPath.length === 0) {
    return null;
  }

  let currentSection = "";

  for (let rowIndex = 0; rowIndex < rows109.length; rowIndex += 1) {
    const row = rows109[rowIndex] || [];
    const sectionLabel = normalizeLabelToken(row[2]);
    const rowLabel = normalizeLabelToken(row[3] || row[2]);

    if (sectionLabel) {
      currentSection = sectionLabel;
    }

    if (normalizedPath.length === 1 && rowLabel === normalizedPath[0]) {
      return rowIndex;
    }

    if (
      normalizedPath.length === 2 &&
      currentSection === normalizedPath[0] &&
      rowLabel === normalizedPath[1]
    ) {
      return rowIndex;
    }
  }

  return null;
}

type YearAxis = {
  rowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
  years: number[];
};

function parseYearToken(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const matched = text.match(/(?:19|20)\d{2}/);
  if (!matched) {
    return null;
  }
  const year = Number.parseInt(matched[0], 10);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return null;
  }
  return year;
}

export function discoverYearAxis(rows109: SpreadsheetRow[]): YearAxis | null {
  let best: YearAxis | null = null;

  rows109.forEach((row, rowIndex) => {
    const yearCells = row
      .map((cell, colIndex) => ({ year: parseYearToken(cell), colIndex }))
      .filter((item): item is { year: number; colIndex: number } => item.year !== null);

    if (yearCells.length < 3) {
      return;
    }

    let segmentStart = 0;
    while (segmentStart < yearCells.length) {
      let segmentEnd = segmentStart;
      while (
        segmentEnd + 1 < yearCells.length &&
        yearCells[segmentEnd + 1].colIndex === yearCells[segmentEnd].colIndex + 1
      ) {
        segmentEnd += 1;
      }

      const segment = yearCells.slice(segmentStart, segmentEnd + 1);
      if (segment.length >= 3) {
        const candidate: YearAxis = {
          rowIndex,
          startColumnIndex: segment[0].colIndex,
          endColumnIndex: segment[segment.length - 1].colIndex,
          years: segment.map((item) => item.year),
        };

        if (!best || candidate.years.length > best.years.length) {
          best = candidate;
        }
      }

      segmentStart = segmentEnd + 1;
    }
  });

  return best;
}

export function resolveValueColumnIndex(rows109: SpreadsheetRow[]): number {
  const yearAxis = discoverYearAxis(rows109);
  if (!yearAxis) {
    return 4;
  }
  return Math.max(0, yearAxis.startColumnIndex - 1);
}

const MANUAL_INPUT_FIELD_PATHS: Record<string, string[][]> = {
  POC_CUMULATIVE: [
    ["Total Project", "Percentage of Completion POC"],
    ["Total Project", "Percentage of Completion"],
    ["Total Project", "累积完工比例"],
    ["POC"],
  ],
  POC_CURRENT: [
    ["Total Project", "Completion Rate for the Period"],
    ["Total Project", "当期完工比例"],
    ["Completion Rate for the Period"],
  ],
  CONTRACT_VARIATION: [
    ["Total Project", "Contract change amount"],
    ["Total Project", "合同变动金额"],
    ["Contract change amount"],
  ],
  PERIOD_REVENUE: [
    ["Total Project", "General Conditions fee"],
    ["Total Project", "当期计算收入"],
    ["General Conditions fee"],
  ],
  ROE_COST_WB_HOME: [
    ["WB Home", "ROE成本 WB Home"],
    ["WB Home", "WB Home COGS"],
    ["ROE成本 WB Home"],
  ],
  WB_HOME_INCOME: [
    ["WB Home", "WB Home收入"],
    ["WB Home", "WB Home Income"],
    ["WB Home收入"],
  ],
};

function getFieldValue(rows109: SpreadsheetRow[], logicalField: keyof typeof MANUAL_INPUT_FIELD_PATHS): number | null {
  const valueCol = resolveValueColumnIndex(rows109);
  const paths = MANUAL_INPUT_FIELD_PATHS[logicalField] || [];
  for (const path of paths) {
    const rowIndex = findRowByLabelPath(rows109, path);
    if (rowIndex === null) {
      continue;
    }
    const parsed = parseOptionalNumber(rows109[rowIndex]?.[valueCol]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function parseDateValue(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = Math.round((value - 25569) * 86400 * 1000);
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    const date = new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateValue(value: unknown): string {
  const parsed = parseDateValue(value);
  if (!parsed) {
    return readCell([value as SpreadsheetCell], 0);
  }

  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const year = parsed.getFullYear();
  return `${month}/${day}/${year}`;
}

function columnLabel(colIndex: number): string {
  let n = colIndex + 1;
  let label = "";

  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }

  return label;
}

const DEFAULT_PRIMARY_YEAR_COLUMNS = [5, 6, 7, 8, 9, 10];
const DEFAULT_AUDIT_YEAR_COLUMNS = [12, 13, 14, 15, 16, 17];

const MANUAL_PROFIT_STATEMENT_ROWS = [
  { labels: ["General Conditions fee-Audited"], includeAudit: true },
  { labels: ["Owner-unapproved Overrun"], includeAudit: false },
  { labels: ["Cost of Goods Sold-Audited", "Audit Adjustment (Current Period)"], includeAudit: true },
  { labels: ["Accrued Warranty Expenses"], includeAudit: false },
  { labels: ["WB Home Income", "WB Home收入"], includeAudit: false },
  { labels: ["WB Home COGS", "ROE成本 - WB Home", "ROE Cost - WB Home"], includeAudit: false },
  { labels: ["WB Home Inventory Income"], includeAudit: false },
  { labels: ["WB Home Inventory"], includeAudit: false },
] as const;

function normalizeYearHeader(value: unknown): string {
  const matched = String(value ?? "").match(/(?:19|20)\d{2}/);
  return matched?.[0] || "";
}

function discoverManualInputColumns(rows109: SpreadsheetRow[]) {
  const yearAxis = discoverYearAxis(rows109);
  if (!yearAxis) {
    return {
      primaryColumns: DEFAULT_PRIMARY_YEAR_COLUMNS,
      auditColumns: DEFAULT_AUDIT_YEAR_COLUMNS,
    };
  }

  const primaryColumns = Array.from(
    { length: yearAxis.endColumnIndex - yearAxis.startColumnIndex + 1 },
    (_, index) => yearAxis.startColumnIndex + index,
  );
  const headerRow = rows109[yearAxis.rowIndex] || [];
  const auditColumns = primaryColumns.map((columnIndex, index) => {
    const year = normalizeYearHeader(headerRow[columnIndex]);
    for (let nextColumnIndex = columnIndex + 1; nextColumnIndex < headerRow.length; nextColumnIndex += 1) {
      if (year && normalizeYearHeader(headerRow[nextColumnIndex]) === year) {
        return nextColumnIndex;
      }
    }
    return DEFAULT_AUDIT_YEAR_COLUMNS[index] ?? columnIndex;
  });

  return { primaryColumns, auditColumns };
}

function findManualInputRow(rows109: SpreadsheetRow[], labels: readonly string[]) {
  for (const label of labels) {
    const rowIndex = findRowByLabelPath(rows109, [label]);
    if (rowIndex !== null) {
      return rowIndex;
    }
  }
  return null;
}

function buildProfitStatementEntries(rows109: SpreadsheetRow[]) {
  const { primaryColumns, auditColumns } = discoverManualInputColumns(rows109);
  const seenCells = new Set<string>();

  return MANUAL_PROFIT_STATEMENT_ROWS.flatMap((definition) => {
    const rowIndex = findManualInputRow(rows109, definition.labels);
    if (rowIndex === null) {
      return [];
    }

    const row = rows109[rowIndex] || [];
    const fieldName = readCell(row, 3) || readCell(row, 2);
    const columns = definition.includeAudit ? [...primaryColumns, ...auditColumns] : primaryColumns;

    return columns
      .map((colIndex) => ({ cell: row[colIndex], colIndex }))
      .filter(({ cell }) => isNumericEntry(cell))
      .map(({ cell, colIndex }) => {
        const cellPosition = `${columnLabel(colIndex)}${rowIndex + 1}`;
        if (seenCells.has(cellPosition)) {
          return null;
        }
        seenCells.add(cellPosition);
        return {
          cell_position: cellPosition,
          field_name: fieldName,
          amount: parseNumber(cell),
        };
      })
      .filter((entry): entry is { cell_position: string; field_name: string; amount: number } =>
        Boolean(entry && entry.field_name && entry.amount !== 0),
      );
  });
}

function buildValidationErrors(rows109: SpreadsheetRow[]) {
  const errors: Array<{
    rule_id: string;
    label: string;
    severity: "error";
  }> = [];

  const pocCumulative = getFieldValue(rows109, "POC_CUMULATIVE");
  const pocCurrent = getFieldValue(rows109, "POC_CURRENT");
  const contractVariation = getFieldValue(rows109, "CONTRACT_VARIATION");
  const periodRevenue = getFieldValue(rows109, "PERIOD_REVENUE");
  const roeCostWbHome = getFieldValue(rows109, "ROE_COST_WB_HOME");
  const wbHomeIncome = getFieldValue(rows109, "WB_HOME_INCOME");

  if (pocCumulative !== null && pocCurrent !== null && !isSameNumber(pocCumulative, pocCurrent)) {
    errors.push({
      rule_id: "poc_mismatch",
      label: "累积完工比例 不等于 当期完工比例",
      severity: "error",
    });
  }

  if (pocCumulative !== null && pocCumulative > 100) {
    errors.push({
      rule_id: "poc_over_100",
      label: "累积完工比例 大于 100%",
      severity: "error",
    });
  }

  if (
    pocCumulative !== null &&
    contractVariation !== null &&
    periodRevenue !== null &&
    isSameNumber(pocCumulative, 100) &&
    !isSameNumber(contractVariation, periodRevenue)
  ) {
    errors.push({
      rule_id: "contract_change_revenue_mismatch",
      label: "累积完工比例 = 100% 时，合同变动金额 不等于 当期计算收入",
      severity: "error",
    });
  }

  if (
    roeCostWbHome !== null &&
    wbHomeIncome !== null &&
    !isSameNumber(roeCostWbHome, -wbHomeIncome)
  ) {
    errors.push({
      rule_id: "roe_wbhome_mismatch",
      label: "ROE成本 - WB Home 不等于 -WB Home收入",
      severity: "error",
    });
  }

  return errors;
}

function buildScopingGroups(scopingRows: SpreadsheetRow[]) {
  const headerIndex = scopingRows.findIndex((row) => row.some((cell) => String(cell ?? "").trim() === "Group Number"));
  const headerRow = headerIndex >= 0 ? scopingRows[headerIndex] || [] : [];
  const dataRows = headerIndex >= 0 ? scopingRows.slice(headerIndex + 1) : scopingRows.slice(1);
  const finalGmpColumn = findOptionalColumnByHeader(headerRow, ["Final GMP"]);
  const hasFinalGmpColumn = finalGmpColumn !== null;
  const groupColumn = findColumnByHeader(headerRow, ["Group Number"], 2);
  const groupNameColumn = findColumnByHeader(headerRow, ["Group Name"], 3);
  const gmpColumn = findColumnByHeader(headerRow, ["GMP"], 4);
  const feeColumn = findColumnByHeader(headerRow, ["Fee"], hasFinalGmpColumn ? 6 : 5);
  const wipColumn = findColumnByHeader(headerRow, ["WIP"], hasFinalGmpColumn ? 7 : 6);
  const wtcColumn = findColumnByHeader(headerRow, ["WTC"], hasFinalGmpColumn ? 8 : 7);
  const gcColumn = findColumnByHeader(headerRow, ["GC"], hasFinalGmpColumn ? 9 : 8);
  const tbdColumn = findColumnByHeader(headerRow, ["TBD"], hasFinalGmpColumn ? 10 : 9);
  const warrantyMonthsColumn = findColumnByHeader(headerRow, ["Warranty Months", "保修月数"], hasFinalGmpColumn ? 11 : 10);
  const warrantyDueDateColumn = findColumnByHeader(headerRow, ["Warranty Due Date", "保修到期日"], hasFinalGmpColumn ? 15 : 14);
  const budgetAmountColumn = findColumnByHeader(headerRow, ["Budget amount", "Budget"], hasFinalGmpColumn ? 13 : 12);
  const incurredAmountColumn = findColumnByHeader(headerRow, ["Incurred amount", "Incurred Amount"], hasFinalGmpColumn ? 14 : 13);
  const statusFields = [
    { label: "GMP", column: gmpColumn },
    { label: "Final GMP", column: finalGmpColumn ?? -1 },
    { label: "Fee", column: feeColumn },
    { label: "WIP", column: wipColumn },
    { label: "WTC", column: wtcColumn },
    { label: "GC", column: gcColumn },
    { label: "TBD", column: tbdColumn },
  ];
  const legacyStatusColumns = [gmpColumn, feeColumn, wipColumn, wtcColumn, gcColumn, tbdColumn];
  const requiredFieldIndexes = [gmpColumn, feeColumn, wipColumn, wtcColumn, gcColumn, tbdColumn, warrantyMonthsColumn, warrantyDueDateColumn];

  return dataRows
    .map((row) => {
      const hasBudgetOrIncurredAmount = [budgetAmountColumn, incurredAmountColumn].some((index) => {
        const value = row[index];
        return value !== null && value !== undefined && String(value).trim() !== "";
      });
      const legacyScopeValues = legacyStatusColumns
        .map((index) => readCell(row, index))
        .map((value) => String(value || "").trim())
        .filter((value) => /\d/.test(value));
      const labeledScopeValues = statusFields.map(({ label, column }) => {
        const value = readCell(row, column);
        return `${label}=${value || "-"}`;
      });

      return {
        group: readCell(row, groupColumn),
        group_name: readCell(row, groupNameColumn),
        scope_values: hasFinalGmpColumn
          ? (legacyScopeValues.length ? labeledScopeValues.join(" / ") : "")
          : legacyScopeValues.join("/"),
        e: readCell(row, gmpColumn),
        f: readCell(row, finalGmpColumn ?? feeColumn),
        g: readCell(row, hasFinalGmpColumn ? feeColumn : wipColumn),
        h: readCell(row, hasFinalGmpColumn ? wipColumn : wtcColumn),
        i: readCell(row, hasFinalGmpColumn ? wtcColumn : gcColumn),
        j: readCell(row, hasFinalGmpColumn ? gcColumn : tbdColumn),
        warranty_months: readCell(row, warrantyMonthsColumn),
        warranty_due_date: readCell(row, warrantyDueDateColumn),
        budget_amount: parseNumber(row[budgetAmountColumn]),
        incurred_amount: parseNumber(row[incurredAmountColumn]),
        status:
          hasBudgetOrIncurredAmount &&
          requiredFieldIndexes.some((index) => !readCell(row, index))
            ? "未录入数值"
            : "",
      };
    })
    .filter((row) => row.group)
    .filter((row) => [row.scope_values, row.warranty_months].some((value) => String(value || "").trim()));
}

function findColumnByHeader(headerRow: SpreadsheetRow, aliases: string[], fallbackIndex: number): number {
  const normalizedAliases = new Set(aliases.map((alias) => normalizeLabelToken(alias)));
  const matchedIndex = headerRow.findIndex((cell) => normalizedAliases.has(normalizeLabelToken(cell)));
  return matchedIndex >= 0 ? matchedIndex : fallbackIndex;
}

function findOptionalColumnByHeader(headerRow: SpreadsheetRow, aliases: string[]): number | null {
  const normalizedAliases = new Set(aliases.map((alias) => normalizeLabelToken(alias)));
  const matchedIndex = headerRow.findIndex((cell) => normalizedAliases.has(normalizeLabelToken(cell)));
  return matchedIndex >= 0 ? matchedIndex : null;
}

function buildUnitMasterDates(unitMasterRows: SpreadsheetRow[]) {
  const headerIndex = unitMasterRows.findIndex((row) => row.some((cell) => String(cell ?? "").trim() === "C/O date"));
  const headerRow = headerIndex >= 0 ? unitMasterRows[headerIndex] || [] : [];
  const unitCodeColumn = findColumnByHeader(headerRow, ["Unit Code", "unit_code"], 0);
  const coDateColumn = findColumnByHeader(headerRow, ["C/O date", "CO date"], 2);
  const finalDateColumn = findColumnByHeader(headerRow, ["Final Date"], 3);
  const actualSettlementDateColumn = findColumnByHeader(
    headerRow,
    ["Actual Settlement Date", "实际结算日期", "实际结算日期"],
    4,
  );
  const tbdAcceptanceDateColumn = findColumnByHeader(headerRow, ["TBD Acceptance Date"], 5);
  const dataRows = headerIndex >= 0 ? unitMasterRows.slice(headerIndex + 1) : [];

  return dataRows
    .map((row) => {
      const coDate = parseDateValue(row[coDateColumn]);
      const finalDate = parseDateValue(row[finalDateColumn]);
      const actualSettlementDate = parseDateValue(row[actualSettlementDateColumn]);
      const tbdAcceptanceDate = parseDateValue(row[tbdAcceptanceDateColumn]);

      return {
        unit_code: readCell(row, unitCodeColumn),
        co_date: formatDateValue(row[coDateColumn]),
        final_date: formatDateValue(row[finalDateColumn]),
        actual_settlement_date: formatDateValue(row[actualSettlementDateColumn]),
        tbd_acceptance_date: formatDateValue(row[tbdAcceptanceDateColumn]),
        final_date_invalid: Boolean(coDate && finalDate && finalDate < coDate),
        actual_settlement_date_invalid: Boolean(finalDate && actualSettlementDate && actualSettlementDate < finalDate),
        tbd_acceptance_date_invalid: Boolean(
          actualSettlementDate && tbdAcceptanceDate && tbdAcceptanceDate < actualSettlementDate,
        ),
      };
    })
    .filter((row) => row.unit_code);
}

export function buildManualInputSnapshot({
  rows109,
  scopingRows,
  unitMasterRows,
}: {
  rows109: SpreadsheetRow[];
  scopingRows: SpreadsheetRow[];
  unitMasterRows: SpreadsheetRow[];
}) {
  return {
    profit_statement_entries: buildProfitStatementEntries(rows109),
    validation_errors: buildValidationErrors(rows109),
    scoping_groups: buildScopingGroups(scopingRows),
    unit_master_dates: buildUnitMasterDates(unitMasterRows),
  };
}

export const __internal = {
  findRowByLabelPath,
  discoverYearAxis,
  resolveValueColumnIndex,
};
