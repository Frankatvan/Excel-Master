import { google } from "googleapis";

import type { DurableJobRow } from "@/lib/job-service";
import {
  getExternalImportStatus,
  type ExternalImportManifestItemStatus,
} from "@/lib/external-import/import-manifest-service";
import type { ResolvedImportZone } from "@/lib/external-import/import-zone-resolver";
import {
  downloadExternalImportJsonArtifact,
  type ExternalImportStoredJsonRef,
} from "@/lib/external-import/upload-storage";
import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import {
  updateExternalImportJobProgress,
  updateImportManifestItemStatus,
  updateImportManifestStatus,
} from "@/lib/job-service";

const ASYNC_EXECUTION_ARTIFACT_FORMAT = "external_import.async_execution.chunk_plan.v1";
const DEFAULT_MAX_ROWS_PER_STEP = 500;

export interface ExternalImportStepCursor {
  chunk_index: number;
  row_offset: number;
}

export interface ExternalImportExecutionChunk {
  source_table: string;
  source_file_name?: string | null;
  source_sheet_name?: string | null;
  headers: unknown[];
  rows: unknown[][];
  row_count: number;
  column_count: number;
  amount_total?: number;
  target_zone_key: string;
}

export interface ExternalImportExecutionArtifact {
  format: string;
  spreadsheet_id: string;
  preview_hash?: string;
  resolved_zones: Record<string, ResolvedImportZone>;
  chunks: ExternalImportExecutionChunk[];
}

export class ExternalImportStepError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ExternalImportStepError";
    this.code = code;
    this.details = details;
  }
}

function readNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function readCursor(value: unknown): ExternalImportStepCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { chunk_index: 0, row_offset: 0 };
  }
  const cursor = value as Record<string, unknown>;
  return {
    chunk_index: readNumber(cursor.chunk_index, 0),
    row_offset: readNumber(cursor.row_offset, 0),
  };
}

function readStoredJsonRef(value: unknown): ExternalImportStoredJsonRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ARTIFACT_MISSING", "External import execution artifact is missing.");
  }
  const ref = value as Record<string, unknown>;
  const bucket = typeof ref.bucket === "string" ? ref.bucket : "";
  const path = typeof ref.path === "string" ? ref.path : "";
  const format = typeof ref.format === "string" ? ref.format : "";
  if (!bucket || !path || !format) {
    throw new ExternalImportStepError(
      "EXTERNAL_IMPORT_ARTIFACT_INVALID",
      "External import execution artifact reference is incomplete.",
    );
  }
  return {
    bucket,
    path,
    format,
    size_bytes: readNumber(ref.size_bytes, 0),
    sha256: typeof ref.sha256 === "string" ? ref.sha256 : "",
  };
}

function normalizeRows(rows: unknown): unknown[][] {
  return Array.isArray(rows) ? rows.filter(Array.isArray) : [];
}

function normalizeHeaders(headers: unknown): unknown[] {
  return Array.isArray(headers) ? headers : [];
}

function normalizeChunk(chunk: unknown): ExternalImportExecutionChunk | null {
  if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
    return null;
  }
  const raw = chunk as Record<string, unknown>;
  const sourceTable = typeof raw.source_table === "string" ? raw.source_table : "";
  const targetZoneKey = typeof raw.target_zone_key === "string" ? raw.target_zone_key : sourceTable;
  if (!sourceTable || !targetZoneKey) {
    return null;
  }
  const headers = normalizeHeaders(raw.headers);
  const rows = normalizeRows(raw.rows);
  return {
    source_table: sourceTable,
    source_file_name: typeof raw.source_file_name === "string" ? raw.source_file_name : null,
    source_sheet_name: typeof raw.source_sheet_name === "string" ? raw.source_sheet_name : null,
    headers,
    rows,
    row_count: readNumber(raw.row_count, rows.length),
    column_count: readNumber(raw.column_count, headers.length),
    amount_total: readNumber(raw.amount_total, 0),
    target_zone_key: targetZoneKey,
  };
}

function normalizeArtifact(value: unknown): ExternalImportExecutionArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ARTIFACT_INVALID", "External import execution artifact is invalid.");
  }
  const raw = value as Record<string, unknown>;
  const format = typeof raw.format === "string" ? raw.format : "";
  if (format !== ASYNC_EXECUTION_ARTIFACT_FORMAT) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ARTIFACT_INVALID", `Unsupported external import artifact format: ${format}`);
  }
  const spreadsheetId = typeof raw.spreadsheet_id === "string" ? raw.spreadsheet_id : "";
  const resolvedZones =
    raw.resolved_zones && typeof raw.resolved_zones === "object" && !Array.isArray(raw.resolved_zones)
      ? (raw.resolved_zones as Record<string, ResolvedImportZone>)
      : {};
  return {
    format,
    spreadsheet_id: spreadsheetId,
    preview_hash: typeof raw.preview_hash === "string" ? raw.preview_hash : undefined,
    resolved_zones: resolvedZones,
    chunks: Array.isArray(raw.chunks) ? raw.chunks.map(normalizeChunk).filter(Boolean) as ExternalImportExecutionChunk[] : [],
  };
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function cellData(value: unknown) {
  if (typeof value === "boolean") {
    return { userEnteredValue: { boolValue: value } };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { userEnteredValue: { numberValue: value } };
  }
  return { userEnteredValue: { stringValue: value == null ? "" : String(value) } };
}

function requireZoneRange(resolvedZone: ResolvedImportZone, columnCount: number) {
  const range = resolvedZone.gridRange;
  if (typeof range.endColumnIndex !== "number" || typeof range.endRowIndex !== "number") {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ZONE_INVALID", "Resolved import zone is missing row or column bounds.", {
      target_zone_key: resolvedZone.zoneKey,
    });
  }
  const availableColumns = range.endColumnIndex - range.startColumnIndex;
  if (columnCount > availableColumns) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_CAPACITY_EXCEEDED", "Resolved import zone column capacity is too small.", {
      target_zone_key: resolvedZone.zoneKey,
      required_columns: columnCount,
      available_columns: availableColumns,
    });
  }
  return range;
}

function buildExpandRequest(resolvedZone: ResolvedImportZone, rowCount: number) {
  const range = requireZoneRange(resolvedZone, 0);
  const requiredEndRowIndex = range.startRowIndex + rowCount;
  const endRowIndex = range.endRowIndex ?? range.startRowIndex;
  if (requiredEndRowIndex > endRowIndex && resolvedZone.capacityPolicy !== "expand_within_managed_sheet") {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_CAPACITY_EXCEEDED", "Resolved import zone row capacity is too small.", {
      target_zone_key: resolvedZone.zoneKey,
      required_rows: rowCount,
      available_rows: endRowIndex - range.startRowIndex,
    });
  }
  const currentRowCount = Math.max(endRowIndex, resolvedZone.sheetGridProperties?.rowCount ?? 0);
  if (requiredEndRowIndex <= currentRowCount) {
    return null;
  }
  return {
    updateSheetProperties: {
      properties: {
        sheetId: range.sheetId,
        gridProperties: { rowCount: requiredEndRowIndex },
      },
      fields: "gridProperties.rowCount",
    },
  };
}

export function buildExternalImportRowBandRequests(input: {
  resolvedZone: ResolvedImportZone;
  rows: unknown[][];
  headers: unknown[];
  cursor: ExternalImportStepCursor;
}) {
  const columnCount = input.headers.length || Math.max(0, ...input.rows.map((row) => row.length));
  const range = requireZoneRange(input.resolvedZone, columnCount);
  const startRowIndex = range.startRowIndex + input.cursor.row_offset;
  const bandRange = {
    sheetId: range.sheetId,
    startRowIndex,
    endRowIndex: startRowIndex + input.rows.length,
    startColumnIndex: range.startColumnIndex,
    endColumnIndex: range.startColumnIndex + columnCount,
  };
  if (input.rows.length === 0) {
    return [];
  }
  return [
    {
      repeatCell: {
        range: bandRange,
        cell: {},
        fields: "userEnteredValue",
      },
    },
    {
      updateCells: {
        range: bandRange,
        rows: input.rows.map((row) => ({ values: row.map(cellData) })),
        fields: "userEnteredValue",
      },
    },
  ];
}

function totalRowBandChunks(chunks: ExternalImportExecutionChunk[], maxRowsPerStep: number) {
  return chunks.reduce((count, chunk) => count + Math.max(1, Math.ceil(chunk.rows.length / maxRowsPerStep)), 0);
}

function completedRowBandChunks(
  chunks: ExternalImportExecutionChunk[],
  cursor: ExternalImportStepCursor | null,
  maxRowsPerStep: number,
) {
  if (!cursor) {
    return totalRowBandChunks(chunks, maxRowsPerStep);
  }
  let completed = 0;
  for (let index = 0; index < Math.min(cursor.chunk_index, chunks.length); index += 1) {
    completed += Math.max(1, Math.ceil(chunks[index].rows.length / maxRowsPerStep));
  }
  const currentChunk = chunks[cursor.chunk_index];
  if (currentChunk) {
    completed += Math.min(Math.ceil(cursor.row_offset / maxRowsPerStep), Math.max(1, Math.ceil(currentChunk.rows.length / maxRowsPerStep)));
  }
  return completed;
}

export function planExternalImportStep(input: {
  chunks: ExternalImportExecutionChunk[];
  resolvedZones: Record<string, ResolvedImportZone>;
  cursor: ExternalImportStepCursor;
  maxRowsPerStep: number;
}) {
  const maxRowsPerStep = Math.max(1, Math.floor(input.maxRowsPerStep));
  const chunk = input.chunks[input.cursor.chunk_index];
  if (!chunk) {
    return {
      chunk: null,
      rows: [],
      requests: [],
      nextCursor: null,
      hasNextStep: false,
      completedTable: false,
      totalChunks: totalRowBandChunks(input.chunks, maxRowsPerStep),
      completedChunks: totalRowBandChunks(input.chunks, maxRowsPerStep),
    };
  }

  const resolvedZone = input.resolvedZones[chunk.target_zone_key];
  if (!resolvedZone) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ZONE_MISSING", "Resolved import zone is missing for chunk.", {
      target_zone_key: chunk.target_zone_key,
    });
  }

  const rows = chunk.rows.slice(input.cursor.row_offset, input.cursor.row_offset + maxRowsPerStep);
  const expandRequest = input.cursor.row_offset === 0 ? buildExpandRequest(resolvedZone, chunk.rows.length) : null;
  const requests = [
    ...(expandRequest ? [expandRequest] : []),
    ...buildExternalImportRowBandRequests({
      resolvedZone,
      rows,
      headers: chunk.headers,
      cursor: input.cursor,
    }),
  ];
  const nextRowOffset = input.cursor.row_offset + rows.length;
  const completedTable = nextRowOffset >= chunk.rows.length;
  const nextCursor = completedTable
    ? input.cursor.chunk_index + 1 < input.chunks.length
      ? { chunk_index: input.cursor.chunk_index + 1, row_offset: 0 }
      : null
    : { chunk_index: input.cursor.chunk_index, row_offset: nextRowOffset };
  const totalChunks = totalRowBandChunks(input.chunks, maxRowsPerStep);
  const completedChunks = completedRowBandChunks(input.chunks, nextCursor, maxRowsPerStep);

  return {
    chunk,
    rows,
    requests,
    nextCursor,
    hasNextStep: nextCursor !== null,
    completedTable,
    totalChunks,
    completedChunks,
  };
}

function currentTableFromCursor(chunks: ExternalImportExecutionChunk[], cursor: ExternalImportStepCursor | null) {
  if (!cursor) {
    return null;
  }
  return chunks[cursor.chunk_index]?.source_table ?? null;
}

function rowsWrittenBeforeCursor(chunks: ExternalImportExecutionChunk[], cursor: ExternalImportStepCursor | null) {
  if (!cursor) {
    return chunks.reduce((sum, chunk) => sum + chunk.rows.length, 0);
  }
  let rowsWritten = 0;
  for (let index = 0; index < Math.min(cursor.chunk_index, chunks.length); index += 1) {
    rowsWritten += chunks[index].rows.length;
  }
  return rowsWritten + Math.min(cursor.row_offset, chunks[cursor.chunk_index]?.rows.length ?? 0);
}

function progressMeta(input: {
  chunks: ExternalImportExecutionChunk[];
  cursor: ExternalImportStepCursor | null;
  totalChunks: number;
  completedChunks: number;
  executionArtifact: ExternalImportStoredJsonRef;
}) {
  return {
    current_step: input.cursor ? "write_chunk" : "complete",
    total_chunks: input.totalChunks,
    completed_chunks: input.completedChunks,
    current_table: currentTableFromCursor(input.chunks, input.cursor),
    rows_written: rowsWrittenBeforeCursor(input.chunks, input.cursor),
    cursor: input.cursor,
    execution_artifact: input.executionArtifact,
  };
}

function findManifestItem(items: ExternalImportManifestItemStatus[], chunk: ExternalImportExecutionChunk | null) {
  if (!chunk) {
    return null;
  }
  return items.find((item) => item.source_table === chunk.source_table || item.target_zone_key === chunk.target_zone_key) ?? null;
}

async function executeBatchUpdate(input: { spreadsheetId: string; requests: Record<string, unknown>[]; sheets?: unknown }) {
  if (!input.requests.length) {
    return { request_count: 0 };
  }
  const sheets = (input.sheets ?? getSheetsClient()) as {
    spreadsheets: {
      batchUpdate: (input: { spreadsheetId: string; body: { requests: Record<string, unknown>[] } }) => {
        execute: () => Promise<Record<string, unknown>>;
      };
    };
  };
  const result = await sheets.spreadsheets
    .batchUpdate({ spreadsheetId: input.spreadsheetId, body: { requests: input.requests } })
    .execute();
  return { ...(result ?? {}), request_count: input.requests.length };
}

export async function runExternalImportJobStep(input: {
  job: DurableJobRow;
  maxRowsPerStep?: number;
  sheets?: unknown;
}) {
  const spreadsheetId = input.job.spreadsheet_id || String(input.job.payload?.spreadsheet_id || "");
  if (!spreadsheetId) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_JOB_INVALID", "External import job is missing spreadsheet_id.");
  }
  const executionArtifact = readStoredJsonRef(input.job.payload?.execution_artifact);
  const artifact = normalizeArtifact(
    await downloadExternalImportJsonArtifact({
      spreadsheetId,
      ref: executionArtifact,
      expectedFormat: ASYNC_EXECUTION_ARTIFACT_FORMAT,
    }),
  );
  if (artifact.spreadsheet_id !== spreadsheetId) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ARTIFACT_INVALID", "External import artifact spreadsheet_id does not match job.");
  }

  const maxRowsPerStep = Math.max(1, Math.floor(input.maxRowsPerStep ?? DEFAULT_MAX_ROWS_PER_STEP));
  const cursor = readCursor(input.job.result_meta?.cursor);
  const plan = planExternalImportStep({
    chunks: artifact.chunks,
    resolvedZones: artifact.resolved_zones,
    cursor,
    maxRowsPerStep,
  });
  await executeBatchUpdate({ spreadsheetId, requests: plan.requests, sheets: input.sheets });

  const status = await getExternalImportStatus({ spreadsheetId, jobId: input.job.id });
  const item = findManifestItem(status.manifest_items, plan.chunk);
  const meta = progressMeta({
    chunks: artifact.chunks,
    cursor: plan.nextCursor,
    totalChunks: plan.totalChunks,
    completedChunks: plan.completedChunks,
    executionArtifact,
  });
  const progress = plan.totalChunks ? Math.round((plan.completedChunks / plan.totalChunks) * 100) : 100;

  if (item) {
    await updateImportManifestItemStatus({
      itemId: item.id,
      status: plan.completedTable ? "imported" : "parsed",
      resultMeta: {
        ...item.result_meta,
        ...meta,
        current_table: plan.chunk?.source_table ?? null,
        chunk_rows_written: plan.rows.length,
      },
      error: null,
    });
  }

  if (!plan.hasNextStep) {
    await updateImportManifestStatus({
      jobId: input.job.id,
      status: "imported",
      resultMeta: meta,
      error: null,
    });
    await updateExternalImportJobProgress({
      jobId: input.job.id,
      status: "succeeded",
      progress: 100,
      result: { imported_table_count: artifact.chunks.length },
      resultMeta: meta,
      error: null,
    });
  } else {
    await updateExternalImportJobProgress({
      jobId: input.job.id,
      status: "running",
      progress,
      resultMeta: meta,
      error: null,
    });
  }

  return {
    status: plan.hasNextStep ? "running" : "succeeded",
    progress: plan.hasNextStep ? progress : 100,
    cursor: plan.nextCursor,
    has_next_step: plan.hasNextStep,
    rows_written: plan.rows.length,
    manifest_item_id: item?.id ?? null,
    step: {
      kind: "write_chunk",
      index: plan.completedChunks,
      total: plan.totalChunks,
      manifest_item_id: item?.id ?? null,
    },
    next_step: plan.nextCursor
      ? {
          kind: "write_chunk",
          index: plan.completedChunks + 1,
          remaining: Math.max(plan.totalChunks - plan.completedChunks, 0),
        }
      : null,
  };
}
