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
import { externalImportUpstreamErrorDetails } from "@/lib/external-import/upstream-error";
import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import {
  updateExternalImportJobProgress,
  updateImportManifestItemStatus,
  updateImportManifestStatus,
} from "@/lib/job-service";

const ASYNC_EXECUTION_ARTIFACT_FORMAT = "external_import.async_execution.chunk_plan.v1";
const DEFAULT_MAX_ROWS_PER_STEP = 500;
const DEFAULT_MAX_CELLS_PER_STEP = 50_000;

export interface ExternalImportStepCursor {
  phase?: "setup_table" | "write_chunk" | "validation";
  chunk_index: number;
  row_offset: number;
}

export interface ExternalImportExecutionChunk {
  source_table: string;
  source_role?: string;
  detected?: boolean;
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
  validation?: Record<string, unknown>;
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
    phase:
      cursor.phase === "setup_table" || cursor.phase === "write_chunk" || cursor.phase === "validation"
        ? cursor.phase
        : undefined,
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
    source_role: typeof raw.source_role === "string" ? raw.source_role : undefined,
    detected: raw.detected === true,
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
    validation: raw.validation && typeof raw.validation === "object" && !Array.isArray(raw.validation)
      ? (raw.validation as Record<string, unknown>)
      : undefined,
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

function isUploadedChunk(chunk: ExternalImportExecutionChunk) {
  const sourceRole = String(chunk.source_role ?? "").toLowerCase();
  return sourceRole ? sourceRole === "uploaded" || sourceRole === "detected" : chunk.detected === true;
}

function boundedClearRequest(input: {
  resolvedZone: ResolvedImportZone;
  startRowOffset: number;
  rowCount: number;
  startColumnOffset: number;
  columnCount: number;
  enforceColumnCapacity?: boolean;
}) {
  if (input.rowCount <= 0 || input.columnCount <= 0) {
    return null;
  }
  const range = input.enforceColumnCapacity === false
    ? input.resolvedZone.gridRange
    : requireZoneRange(input.resolvedZone, input.startColumnOffset + input.columnCount);
  if (typeof range.endColumnIndex !== "number" || typeof range.endRowIndex !== "number") {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ZONE_INVALID", "Resolved import zone is missing row or column bounds.", {
      target_zone_key: input.resolvedZone.zoneKey,
    });
  }
  return {
    repeatCell: {
      range: {
        sheetId: range.sheetId,
        startRowIndex: range.startRowIndex + input.startRowOffset,
        endRowIndex: range.startRowIndex + input.startRowOffset + input.rowCount,
        startColumnIndex: range.startColumnIndex + input.startColumnOffset,
        endColumnIndex: range.startColumnIndex + input.startColumnOffset + input.columnCount,
      },
      cell: {},
      fields: "userEnteredValue",
    },
  };
}

function readItemCount(item: ExternalImportManifestItemStatus | null, key: "row_count" | "column_count", fallback: number) {
  const metaKey = key === "row_count" ? "previous_row_count" : "previous_column_count";
  const metaValue = item?.result_meta?.[metaKey];
  const value = readNumber(metaValue, readNumber(item?.[key], fallback));
  return Math.max(value, fallback);
}

function buildSetupRequests(input: {
  resolvedZone: ResolvedImportZone;
  chunk: ExternalImportExecutionChunk;
  manifestItem: ExternalImportManifestItemStatus | null;
}) {
  const currentRowCount = input.chunk.rows.length;
  const currentColumnCount = input.chunk.headers.length || input.chunk.column_count;
  const previousRowCount = readItemCount(input.manifestItem, "row_count", currentRowCount);
  const previousColumnCount = readItemCount(input.manifestItem, "column_count", currentColumnCount);
  const requests: Record<string, unknown>[] = [];
  const expandRequest = buildExpandRequest(input.resolvedZone, currentRowCount);
  if (expandRequest) {
    requests.push(expandRequest);
  }
  const currentClear = boundedClearRequest({
    resolvedZone: input.resolvedZone,
    startRowOffset: 0,
    rowCount: currentRowCount,
    startColumnOffset: 0,
    columnCount: currentColumnCount,
  });
  if (currentClear) {
    requests.push(currentClear);
  }
  const tailClear = boundedClearRequest({
    resolvedZone: input.resolvedZone,
    startRowOffset: currentRowCount,
    rowCount: Math.max(previousRowCount - currentRowCount, 0),
    startColumnOffset: 0,
    columnCount: Math.max(previousColumnCount, currentColumnCount),
    enforceColumnCapacity: false,
  });
  if (tailClear) {
    requests.push(tailClear);
  }
  const widthDriftClear = boundedClearRequest({
    resolvedZone: input.resolvedZone,
    startRowOffset: 0,
    rowCount: Math.max(previousRowCount, currentRowCount),
    startColumnOffset: currentColumnCount,
    columnCount: Math.max(previousColumnCount - currentColumnCount, 0),
    enforceColumnCapacity: false,
  });
  if (widthDriftClear) {
    requests.push(widthDriftClear);
  }

  return {
    requests,
    setupMeta: {
      setup_completed: true,
      clear_strategy: "bounded_target_tail_width_drift",
      previous_row_count: previousRowCount,
      previous_column_count: previousColumnCount,
      current_row_count: currentRowCount,
      current_column_count: currentColumnCount,
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
  return chunks.reduce((count, chunk) => count + Math.max(1, Math.ceil(chunk.rows.length / rowLimitForChunk(chunk, maxRowsPerStep))), 0);
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
    const rowLimit = rowLimitForChunk(chunks[index], maxRowsPerStep);
    completed += Math.max(1, Math.ceil(chunks[index].rows.length / rowLimit));
  }
  const currentChunk = chunks[cursor.chunk_index];
  if (currentChunk) {
    const rowLimit = rowLimitForChunk(currentChunk, maxRowsPerStep);
    completed += Math.min(Math.ceil(cursor.row_offset / rowLimit), Math.max(1, Math.ceil(currentChunk.rows.length / rowLimit)));
  }
  return completed;
}

function chunkColumnCount(chunk: ExternalImportExecutionChunk) {
  return Math.max(chunk.column_count, chunk.headers.length, 1, ...chunk.rows.map((row) => row.length));
}

function rowLimitForChunk(chunk: ExternalImportExecutionChunk, maxRowsPerStep: number) {
  const maxRows = Math.max(1, Math.floor(maxRowsPerStep));
  const maxRowsByCells = Math.max(1, Math.floor(DEFAULT_MAX_CELLS_PER_STEP / chunkColumnCount(chunk)));
  return Math.min(maxRows, maxRowsByCells);
}

export function planExternalImportStep(input: {
  chunks: ExternalImportExecutionChunk[];
  resolvedZones: Record<string, ResolvedImportZone>;
  cursor: ExternalImportStepCursor;
  maxRowsPerStep: number;
  manifestItem?: ExternalImportManifestItemStatus | null;
}) {
  const maxRowsPerStep = Math.max(1, Math.floor(input.maxRowsPerStep));
  const importChunks = input.chunks.filter(isUploadedChunk);
  if (input.cursor.phase === "validation") {
    return {
      chunk: null,
      rows: [],
      requests: [],
      nextCursor: null,
      hasNextStep: false,
      completedTable: false,
      totalChunks: totalRowBandChunks(importChunks, maxRowsPerStep),
      completedChunks: totalRowBandChunks(importChunks, maxRowsPerStep),
      stepKind: "validation",
      setupMeta: {},
    };
  }
  const chunk = importChunks[input.cursor.chunk_index];
  if (!chunk) {
    return {
      chunk: null,
      rows: [],
      requests: [],
      nextCursor: null,
      hasNextStep: false,
      completedTable: false,
      totalChunks: totalRowBandChunks(importChunks, maxRowsPerStep),
      completedChunks: totalRowBandChunks(importChunks, maxRowsPerStep),
      stepKind: "validation",
      setupMeta: {},
    };
  }

  const resolvedZone = input.resolvedZones[chunk.target_zone_key];
  if (!resolvedZone) {
    throw new ExternalImportStepError("EXTERNAL_IMPORT_ZONE_MISSING", "Resolved import zone is missing for chunk.", {
      target_zone_key: chunk.target_zone_key,
    });
  }

  const rowLimit = rowLimitForChunk(chunk, maxRowsPerStep);
  const rows = chunk.rows.slice(input.cursor.row_offset, input.cursor.row_offset + rowLimit);
  const setup = input.cursor.row_offset === 0
    ? buildSetupRequests({ resolvedZone, chunk, manifestItem: input.manifestItem ?? null })
    : { requests: [], setupMeta: {} };
  const requests = [
    ...setup.requests,
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
    ? input.cursor.chunk_index + 1 < importChunks.length
      ? { chunk_index: input.cursor.chunk_index + 1, row_offset: 0 }
      : ({ phase: "validation", chunk_index: importChunks.length, row_offset: 0 } as ExternalImportStepCursor)
    : { chunk_index: input.cursor.chunk_index, row_offset: nextRowOffset };
  const totalChunks = totalRowBandChunks(importChunks, maxRowsPerStep);
  const completedChunks = completedRowBandChunks(importChunks, nextCursor, maxRowsPerStep);

  return {
    chunk,
    rows,
    requests,
    nextCursor,
    hasNextStep: nextCursor !== null,
    completedTable,
    totalChunks,
    completedChunks,
    stepKind: "write_chunk",
    setupMeta: setup.setupMeta,
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
  currentStep?: string;
  validation?: Record<string, unknown>;
}) {
  return {
    current_step: input.currentStep ?? (input.cursor?.phase === "validation" ? "validation" : input.cursor ? "write_chunk" : "complete"),
    total_chunks: input.totalChunks,
    completed_chunks: input.completedChunks,
    current_table: currentTableFromCursor(input.chunks, input.cursor),
    rows_written: rowsWrittenBeforeCursor(input.chunks, input.cursor),
    cursor: input.cursor,
    execution_artifact: input.executionArtifact,
    ...(input.validation ? { validation: input.validation } : {}),
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
      batchUpdate: (input: { spreadsheetId: string; requestBody: { requests: Record<string, unknown>[] } }) => unknown;
    };
  };
  try {
    const batchUpdateResult = sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: { requests: input.requests },
    });
    const result = await batchUpdateResult;
    return { ...(result ?? {}), request_count: input.requests.length };
  } catch (error) {
    throw new ExternalImportStepError(
      "EXTERNAL_IMPORT_SHEETS_BATCH_UPDATE_FAILED",
      "Google Sheets batchUpdate failed.",
      externalImportUpstreamErrorDetails(error, {
        service: "google_sheets",
        operation: "spreadsheets.batchUpdate",
        requestCount: input.requests.length,
      }),
    );
  }
}

function isValidationCursor(job: DurableJobRow, cursor: ExternalImportStepCursor) {
  return cursor.phase === "validation" || job.result_meta?.current_step === "validation";
}

function validationSucceeded(validation: Record<string, unknown>) {
  if (validation.ok === false || validation.valid === false || validation.status === "failed") {
    return false;
  }
  return validation.ok === true || validation.valid === true || validation.status === "success" || validation.status === "succeeded";
}

function validationError(validation: Record<string, unknown>) {
  return {
    code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
    message: "External import validation failed.",
    details: { validation },
  };
}

async function runValidation(input: { spreadsheetId: string; artifact: ExternalImportExecutionArtifact }) {
  if (input.artifact.validation) {
    return input.artifact.validation;
  }

  const workerUrl = process.env.PROJECT_BOOTSTRAP_WORKER_URL?.trim();
  const workerSecret = (process.env.PROJECT_BOOTSTRAP_WORKER_SECRET || process.env.AIWB_WORKER_SECRET || "").trim();
  if (!workerUrl || !workerSecret) {
    throw new ExternalImportStepError(
      "EXTERNAL_IMPORT_VALIDATION_UNAVAILABLE",
      "External import validation worker is not configured.",
    );
  }

  let response: Response;
  try {
    response = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aiwb-worker-secret": workerSecret,
      },
      body: JSON.stringify({
        operation: "validate_input",
        spreadsheet_id: input.spreadsheetId,
      }),
    });
  } catch (error) {
    throw new ExternalImportStepError(
      "EXTERNAL_IMPORT_VALIDATION_UPSTREAM_FAILED",
      "External import validation worker request failed.",
      externalImportUpstreamErrorDetails(error, {
        service: "project_bootstrap_worker",
        operation: "validate_input",
        route: workerUrl,
      }),
    );
  }
  const rawBody = await response.text().catch(() => "");
  let body: unknown = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }
  if (!response.ok) {
    throw new ExternalImportStepError(
      "EXTERNAL_IMPORT_VALIDATION_FAILED",
      "External import validation worker returned an error.",
      externalImportUpstreamErrorDetails(
        {
          response: {
            status: response.status,
            statusText: response.statusText,
            data: body,
            config: { url: workerUrl },
          },
        },
        {
          service: "project_bootstrap_worker",
          operation: "validate_input",
          route: workerUrl,
        },
      ),
    );
  }
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : { ok: true, result: body };
}

async function completeValidationStep(input: {
  job: DurableJobRow;
  spreadsheetId: string;
  artifact: ExternalImportExecutionArtifact;
  executionArtifact: ExternalImportStoredJsonRef;
  importChunks: ExternalImportExecutionChunk[];
  maxRowsPerStep: number;
}) {
  const validation = await runValidation({ spreadsheetId: input.spreadsheetId, artifact: input.artifact });
  const status = await getExternalImportStatus({ spreadsheetId: input.spreadsheetId, jobId: input.job.id });
  const totalChunks = totalRowBandChunks(input.importChunks, input.maxRowsPerStep);
  const meta = progressMeta({
    chunks: input.importChunks,
    cursor: null,
    totalChunks,
    completedChunks: totalChunks,
    executionArtifact: input.executionArtifact,
    currentStep: validationSucceeded(validation) ? "complete" : "validation",
    validation,
  });

  if (!validationSucceeded(validation)) {
    const error = validationError(validation);
    await updateImportManifestStatus({
      jobId: input.job.id,
      status: "failed",
      resultMeta: meta,
      error,
    });
    await updateImportManifestItemStatus({
      jobId: input.job.id,
      status: "failed",
      validationMessage: error.message,
      resultMeta: meta,
      error,
    });
    await updateExternalImportJobProgress({
      jobId: input.job.id,
      status: "failed",
      progress: 100,
      resultMeta: meta,
      error,
    });
    return {
      status: "failed",
      progress: 100,
      cursor: null,
      has_next_step: false,
      rows_written: 0,
      manifest_item_id: null,
      step: { kind: "validation", index: totalChunks + 1, total: totalChunks + 1 },
      next_step: null,
      error,
    };
  }

  await updateImportManifestStatus({
    jobId: input.job.id,
    status: "validated",
    resultMeta: meta,
    error: null,
  });
  await updateImportManifestItemStatus({
    jobId: input.job.id,
    status: "validated",
    resultMeta: meta,
    error: null,
  });
  await updateExternalImportJobProgress({
    jobId: input.job.id,
    status: "succeeded",
    progress: 100,
    result: {
      imported_table_count: status.manifest_items.length,
      validation,
    },
    resultMeta: meta,
    error: null,
  });

  return {
    status: "succeeded",
    progress: 100,
    cursor: null,
    has_next_step: false,
    rows_written: 0,
    manifest_item_id: null,
    step: { kind: "validation", index: totalChunks + 1, total: totalChunks + 1 },
    next_step: null,
  };
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
  const activeCursor = isValidationCursor(input.job, cursor)
    ? ({ phase: "validation", chunk_index: cursor.chunk_index, row_offset: 0 } as ExternalImportStepCursor)
    : cursor;
  const importChunks = artifact.chunks.filter(isUploadedChunk);

  if (activeCursor.phase === "validation") {
    return completeValidationStep({
      job: input.job,
      spreadsheetId,
      artifact,
      executionArtifact,
      importChunks,
      maxRowsPerStep,
    });
  }

  if (artifact.chunks.length > 0 && importChunks.length === 0) {
    const nextCursor = { phase: "validation", chunk_index: 0, row_offset: 0 } as ExternalImportStepCursor;
    const meta = progressMeta({
      chunks: importChunks,
      cursor: nextCursor,
      totalChunks: 0,
      completedChunks: 0,
      executionArtifact,
      currentStep: "validation",
    });
    await updateExternalImportJobProgress({
      jobId: input.job.id,
      status: "running",
      progress: 0,
      resultMeta: meta,
      error: null,
    });
    return {
      status: "running",
      progress: 0,
      cursor: nextCursor,
      has_next_step: true,
      rows_written: 0,
      manifest_item_id: null,
      step: { kind: "skip_non_uploaded", index: 0, total: 1 },
      next_step: { kind: "validation", index: 1, remaining: 1 },
    };
  }

  const status = await getExternalImportStatus({ spreadsheetId, jobId: input.job.id });
  const currentItem = findManifestItem(status.manifest_items, importChunks[activeCursor.chunk_index] ?? null);
  const plan = planExternalImportStep({
    chunks: artifact.chunks,
    resolvedZones: artifact.resolved_zones,
    cursor: activeCursor,
    maxRowsPerStep,
    manifestItem: currentItem,
  });
  if (plan.stepKind === "validation") {
    return completeValidationStep({
      job: input.job,
      spreadsheetId,
      artifact,
      executionArtifact,
      importChunks,
      maxRowsPerStep,
    });
  }
  await executeBatchUpdate({ spreadsheetId, requests: plan.requests, sheets: input.sheets });

  const item = findManifestItem(status.manifest_items, plan.chunk);
  const meta = progressMeta({
    chunks: importChunks,
    cursor: plan.nextCursor,
    totalChunks: plan.totalChunks,
    completedChunks: plan.completedChunks,
    executionArtifact,
    currentStep: plan.nextCursor?.phase === "validation" ? "validation" : "write_chunk",
  });
  const progress = plan.totalChunks ? Math.min(99, Math.round((plan.completedChunks / plan.totalChunks) * 95)) : 0;

  if (item) {
    await updateImportManifestItemStatus({
      itemId: item.id,
      status: plan.completedTable ? "imported" : "parsed",
      resultMeta: {
        ...item.result_meta,
        ...meta,
        ...plan.setupMeta,
        current_table: plan.chunk?.source_table ?? null,
        chunk_rows_written: plan.rows.length,
      },
      error: null,
    });
  }

  if (plan.nextCursor?.phase === "validation") {
    await updateImportManifestStatus({
      jobId: input.job.id,
      status: "imported",
      resultMeta: meta,
      error: null,
    });
  }
  await updateExternalImportJobProgress({
    jobId: input.job.id,
    status: "running",
    progress,
    resultMeta: meta,
    error: null,
  });

  return {
    status: "running",
    progress,
    cursor: plan.nextCursor,
    has_next_step: true,
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
          kind: plan.nextCursor.phase === "validation" ? "validation" : "write_chunk",
          index: plan.completedChunks + 1,
          remaining: plan.nextCursor.phase === "validation" ? 1 : Math.max(plan.totalChunks - plan.completedChunks, 0),
        }
      : null,
  };
}
