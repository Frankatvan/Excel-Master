import * as XLSX from "xlsx";

import {
  detectSourceForSheet,
  normalizeHeader,
  type DetectedSource,
  type ExternalImportSourceRole,
  type TargetZoneKey,
} from "./source-detection";

export interface ParsedExternalImportTable {
  sourceRole: ExternalImportSourceRole;
  sourceSheetName: string;
  rowCount: number;
  columnCount: number;
  amountTotal: number;
  targetZoneKey: TargetZoneKey;
  warnings: string[];
  blockingIssues: string[];
  headers: string[];
  rows: SerializableCellValue[][];
}

export interface ParsedExternalImportWorkbook {
  fileName: string;
  tables: ParsedExternalImportTable[];
}

type CellValue = string | number | boolean | Date | null | undefined;
type SerializableCellValue = string | number | boolean | null;

function trimTrailingEmptyCells(row: CellValue[]): CellValue[] {
  const trimmed = [...row];

  while (trimmed.length > 0 && String(trimmed[trimmed.length - 1] ?? "").trim() === "") {
    trimmed.pop();
  }

  return trimmed;
}

function isNonEmptyRow(row: CellValue[]): boolean {
  return row.some((cell) => String(cell ?? "").trim() !== "");
}

function detectionScore(detection: DetectedSource): number {
  return detection.missingRequiredHeaders.length * 10 + detection.duplicateRequiredHeaders.length;
}

function findDetectedHeaderRow(
  sheetName: string,
  rows: CellValue[][],
): { headerIndex: number; headers: string[]; detection: DetectedSource } | null {
  let bestPartialMatch: { headerIndex: number; headers: string[]; detection: DetectedSource } | null = null;

  for (let index = 0; index < rows.length; index += 1) {
    const headers = trimTrailingEmptyCells(rows[index]).map((cell) => String(cell ?? "").trim());

    if (!headers.some((header) => header !== "")) {
      continue;
    }

    const detection = detectSourceForSheet(sheetName, headers);
    if (!detection) {
      continue;
    }

    const candidate = { headerIndex: index, headers, detection };
    if (detection.missingRequiredHeaders.length === 0) {
      return candidate;
    }

    if (!bestPartialMatch || detectionScore(detection) < detectionScore(bestPartialMatch.detection)) {
      bestPartialMatch = candidate;
    }
  }

  return bestPartialMatch;
}

interface RequiredValueIssue {
  header: string;
  value: CellValue;
}

function formatCellValue(value: CellValue): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value ?? "");
}

function serializableCellValue(value: CellValue): SerializableCellValue {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return null;
}

function parseAmount(value: CellValue, allowBlank = false): { value: number; valid: boolean } {
  if (allowBlank && String(value ?? "").trim() === "") {
    return { value: 0, valid: true };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return { value, valid: true };
  }

  const normalized = String(value ?? "")
    .replace(/[$,\s]/g, "")
    .replace(/USD/gi, "")
    .replace(/[()]/g, (match) => (match === "(" ? "-" : ""));
  const parsed = Number(normalized);

  return Number.isFinite(parsed) && normalized !== "" ? { value: parsed, valid: true } : { value: 0, valid: false };
}

function isParseableDate(value: CellValue): boolean {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  const normalized = String(value ?? "").trim();

  return normalized !== "" && Number.isFinite(Date.parse(normalized));
}

function indexesForHeaders(headers: string[], desiredHeaders: string[]): number[] {
  const desired = new Set(desiredHeaders.map(normalizeHeader));

  return headers.reduce<number[]>((indexes, header, index) => {
    if (desired.has(normalizeHeader(header))) {
      indexes.push(index);
    }

    return indexes;
  }, []);
}

function amountColumnIndexes(headers: string[], detection: NonNullable<ReturnType<typeof detectSourceForSheet>>): number[] {
  if (detection.rule.matrixAmountColumns) {
    const keyHeaders = new Set(detection.rule.requiredHeaders.map(normalizeHeader));
    return headers.reduce<number[]>((indexes, header, index) => {
      if (header && !keyHeaders.has(normalizeHeader(header))) {
        indexes.push(index);
      }

      return indexes;
    }, []);
  }

  return indexesForHeaders(headers, detection.rule.amountHeaders ?? []);
}

function requiredValueIssues(
  headers: string[],
  dataRows: CellValue[][],
  detection: NonNullable<ReturnType<typeof detectSourceForSheet>>,
): { amountIssues: RequiredValueIssue[]; dateIssues: RequiredValueIssue[] } {
  const amountIssues: RequiredValueIssue[] = [];
  const dateIssues: RequiredValueIssue[] = [];

  indexesForHeaders(headers, detection.rule.amountHeaders ?? []).forEach((index) => {
    dataRows.forEach((row) => {
      if (!parseAmount(row[index]).valid) {
        amountIssues.push({ header: headers[index], value: row[index] });
      }
    });
  });

  indexesForHeaders(headers, detection.rule.dateHeaders ?? []).forEach((index) => {
    dataRows.forEach((row) => {
      if (!isParseableDate(row[index])) {
        dateIssues.push({ header: headers[index], value: row[index] });
      }
    });
  });

  return { amountIssues, dateIssues };
}

function summarizeRequiredValueIssues(issues: RequiredValueIssue[]): string {
  return issues
    .map((issue) => `${issue.header} has invalid value "${formatCellValue(issue.value)}"`)
    .join("; ");
}

function buildWarnings(detection: NonNullable<ReturnType<typeof detectSourceForSheet>>): string[] {
  const warnings: string[] = [];

  if (detection.missingOptionalHeaders.length > 0) {
    warnings.push(`Missing optional columns: ${detection.missingOptionalHeaders.join(", ")}.`);
  }

  if (detection.extraHeaders.length > 0) {
    warnings.push(`Extra non-key columns: ${detection.extraHeaders.join(", ")}.`);
  }

  return warnings;
}

function buildBlockingIssues(
  detection: NonNullable<ReturnType<typeof detectSourceForSheet>>,
  rowCount: number,
  valueIssues: { amountIssues: RequiredValueIssue[]; dateIssues: RequiredValueIssue[] },
): string[] {
  const blockingIssues: string[] = [];

  if (detection.ambiguousSourceRoles.length > 0) {
    blockingIssues.push(
      `Ambiguous source detection: matched multiple source roles (${detection.ambiguousSourceRoles.join(", ")}).`,
    );
  }

  if (detection.missingRequiredHeaders.length > 0) {
    blockingIssues.push(`Missing required columns: ${detection.missingRequiredHeaders.join(", ")}.`);
  }

  if (detection.duplicateRequiredHeaders.length > 0) {
    blockingIssues.push(`Duplicate required columns: ${detection.duplicateRequiredHeaders.join(", ")}.`);
  }

  if (valueIssues.amountIssues.length > 0) {
    blockingIssues.push(
      `Unparsable amount values in required columns: ${summarizeRequiredValueIssues(valueIssues.amountIssues)}.`,
    );
  }

  if (valueIssues.dateIssues.length > 0) {
    blockingIssues.push(
      `Unparsable date values in required columns: ${summarizeRequiredValueIssues(valueIssues.dateIssues)}.`,
    );
  }

  if (rowCount === 0) {
    blockingIssues.push("Detected sheet has no data rows.");
  }

  return blockingIssues;
}

export function parseWorkbookBuffer(buffer: Buffer | ArrayBuffer | Uint8Array, fileName: string): ParsedExternalImportWorkbook {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const tables = workbook.SheetNames.flatMap<ParsedExternalImportTable>((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<CellValue[]>(worksheet, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: true,
    });
    const headerRow = findDetectedHeaderRow(sheetName, rows);

    if (!headerRow) {
      return [];
    }

    const detection = headerRow.detection;

    const dataRows = rows.slice(headerRow.headerIndex + 1).filter(isNonEmptyRow);
    const amountIndexes = amountColumnIndexes(headerRow.headers, detection);
    const amountTotal = dataRows.reduce((total, row) => {
      return total + amountIndexes.reduce((rowTotal, index) => {
        return rowTotal + parseAmount(row[index], detection.rule.matrixAmountColumns).value;
      }, 0);
    }, 0);
    const valueIssues = requiredValueIssues(headerRow.headers, dataRows, detection);

    return [
      {
        sourceRole: detection.rule.sourceRole,
        sourceSheetName: sheetName,
        rowCount: dataRows.length,
        columnCount: headerRow.headers.length,
        amountTotal,
        targetZoneKey: detection.rule.targetZoneKey,
        warnings: buildWarnings(detection),
        blockingIssues: buildBlockingIssues(detection, dataRows.length, valueIssues),
        headers: headerRow.headers,
        rows: dataRows.map((row) => headerRow.headers.map((_header, index) => serializableCellValue(row[index]))),
      },
    ];
  });

  return { fileName, tables };
}
