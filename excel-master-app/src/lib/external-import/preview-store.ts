import crypto from "crypto";

import type { ParsedExternalImportWorkbook } from "./workbook-parser";

export interface ExternalImportPreviewTable {
  source_role: string;
  source_sheet_name: string;
  row_count: number;
  column_count: number;
  amount_total: number;
  target_zone_id: string;
  warnings: string[];
  blocking_issues: string[];
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface ExternalImportPreviewFile {
  file_name: string;
  file_hash: string;
  tables: ExternalImportPreviewTable[];
}

export interface ExternalImportPreviewPayload {
  status: "preview_ready";
  spreadsheet_id: string;
  preview_hash: string;
  confirm_allowed: boolean;
  files: ExternalImportPreviewFile[];
  source_tables: ExternalImportPreviewTable[];
}

export interface ExternalImportPreviewRecord {
  spreadsheetId: string;
  previewHash: string;
  confirmAllowed: boolean;
  files: ExternalImportPreviewFile[];
  sourceTables: ExternalImportPreviewTable[];
  expiresAt: number;
}

const previewRecords = new Map<string, ExternalImportPreviewRecord>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
}

function sha256(value: Buffer | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function hashFileBuffer(buffer: Buffer) {
  return sha256(buffer);
}

export function computePreviewHash(input: {
  spreadsheetId: string;
  files: ExternalImportPreviewFile[];
  confirmAllowed: boolean;
}) {
  return sha256(
    JSON.stringify(
      stableValue({
        spreadsheet_id: input.spreadsheetId,
        confirm_allowed: input.confirmAllowed,
        files: input.files,
      }),
    ),
  );
}

export function buildPreviewPayload(input: {
  spreadsheetId: string;
  parsedWorkbooks: ParsedExternalImportWorkbook[];
  fileHashes: string[];
}): ExternalImportPreviewPayload {
  const files = input.parsedWorkbooks.map<ExternalImportPreviewFile>((workbook, index) => ({
    file_name: workbook.fileName,
    file_hash: input.fileHashes[index],
    tables: workbook.tables.map((table) => ({
      source_role: table.sourceRole,
      source_sheet_name: table.sourceSheetName,
      row_count: table.rowCount,
      column_count: table.columnCount,
      amount_total: table.amountTotal,
      target_zone_id: table.targetZoneKey,
      warnings: [...table.warnings],
      blocking_issues: [...table.blockingIssues],
      headers: [...table.headers],
      rows: table.rows.map((row) => [...row]),
    })),
  }));
  const sourceTables = files.flatMap((file) => file.tables);
  const confirmAllowed = sourceTables.length > 0 && sourceTables.every((table) => table.blocking_issues.length === 0);
  const previewHash = computePreviewHash({
    spreadsheetId: input.spreadsheetId,
    files,
    confirmAllowed,
  });

  return {
    status: "preview_ready",
    spreadsheet_id: input.spreadsheetId,
    preview_hash: previewHash,
    confirm_allowed: confirmAllowed,
    files,
    source_tables: sourceTables,
  };
}

function pruneExpired(now = Date.now()) {
  for (const [previewHash, record] of previewRecords.entries()) {
    if (record.expiresAt <= now) {
      previewRecords.delete(previewHash);
    }
  }
}

export function savePreviewPayload(payload: ExternalImportPreviewPayload, now = Date.now()) {
  pruneExpired(now);
  const sourceTables = payload.files.flatMap((file) => file.tables);
  const record: ExternalImportPreviewRecord = {
    spreadsheetId: payload.spreadsheet_id,
    previewHash: payload.preview_hash,
    confirmAllowed: payload.confirm_allowed,
    files: payload.files,
    sourceTables,
    expiresAt: now + PREVIEW_TTL_MS,
  };
  previewRecords.set(payload.preview_hash, record);
  return record;
}

export function findPreviewRecord(previewHash: string, spreadsheetId: string, now = Date.now()) {
  pruneExpired(now);
  const record = previewRecords.get(previewHash);
  if (!record || record.spreadsheetId !== spreadsheetId) {
    return undefined;
  }
  return record;
}
