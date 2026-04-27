import type { NextApiRequest, NextApiResponse } from "next";

import { randomUUID } from "crypto";
import { google } from "googleapis";
import { getServerSession } from "next-auth/next";

import { findPreviewRecord, type ExternalImportPreviewRecord } from "@/lib/external-import/preview-store";
import { resolveImportZone, type ResolvedImportZone } from "@/lib/external-import/import-zone-resolver";
import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import {
  createImportManifest,
  createImportManifestItem,
  createJob,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  type ExternalImportManifestStatus,
} from "@/lib/job-service";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

interface ExternalImportWorkerManifestItem {
  source_table?: unknown;
  source_file_name?: unknown;
  source_sheet_name?: unknown;
  file_hash?: unknown;
  header_signature?: unknown;
  row_count?: unknown;
  column_count?: unknown;
  amount_total?: unknown;
  target_zone_key?: unknown;
  resolved_zone_fingerprint?: unknown;
  status?: unknown;
  validation_message?: unknown;
  schema_drift?: unknown;
  error?: unknown;
}

interface ExternalImportWorkerResult {
  ok?: unknown;
  job_status?: unknown;
  manifest_status?: unknown;
  manifest?: unknown;
  validation?: unknown;
  write_result?: unknown;
  message?: unknown;
  details?: unknown;
}

class ExternalImportWorkerFailure extends Error {
  errorCode: string;
  details?: unknown;

  constructor(errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = "ExternalImportWorkerFailure";
    this.errorCode = errorCode;
    this.details = details;
  }
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSpreadsheetId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const spreadsheetId =
    (body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheetId ??
    (body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheet_id;
  return readString(spreadsheetId);
}

function readPreviewHash(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  return readString((body as { preview_hash?: unknown; previewHash?: unknown }).preview_hash) ??
    readString((body as { preview_hash?: unknown; previewHash?: unknown }).previewHash);
}

function requireExternalImportWorkerConfig() {
  const url = process.env.EXTERNAL_IMPORT_WORKER_URL?.trim();
  const secret = process.env.EXTERNAL_IMPORT_WORKER_SECRET?.trim();
  if (!url || !secret) {
    throw new Error("External import worker URL or secret is not configured.");
  }
  return { url, secret };
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

async function loadSpreadsheetMetadata(spreadsheetId: string) {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title),developerMetadata(metadataKey,metadataValue))",
  });
  return response.data;
}

async function resolveZonesForPreview(spreadsheetId: string, previewRecord: ExternalImportPreviewRecord) {
  const spreadsheet = await loadSpreadsheetMetadata(spreadsheetId);
  const resolvedZones: Record<string, ResolvedImportZone> = {};

  for (const table of previewRecord.sourceTables) {
    if (resolvedZones[table.target_zone_id]) {
      continue;
    }

    const resolution = resolveImportZone(spreadsheet as Parameters<typeof resolveImportZone>[0], table.source_role, {
      sourceColumnCount: table.column_count,
    });
    if (!resolution.ok) {
      const issue = resolution.blockingIssues[0];
      throw new Error(issue ? `${issue.code}:${issue.message}` : `IMPORT_ZONE_UNRESOLVED:${table.source_role}`);
    }
    resolvedZones[table.target_zone_id] = resolution.zone;
  }

  return resolvedZones;
}

async function dispatchExternalImportWorker(input: {
  jobId: string;
  workerUrl: string;
  workerSecret: string;
  payload: Record<string, unknown>;
}): Promise<ExternalImportWorkerResult> {
  const response = await fetch(input.workerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AiWB-Worker-Secret": input.workerSecret,
    },
    body: JSON.stringify({
      job_id: input.jobId,
      ...input.payload,
    }),
  });
  const responseText = await response.text();
  const responsePayload = parseWorkerResponse(responseText);

  if (!response.ok && typeof responsePayload.job_status !== "string") {
    const message = readString(responsePayload.message) ?? responseText.trim();
    throw new ExternalImportWorkerFailure(
      workerRejectionCode(response.status),
      message || `External import worker rejected the import (${response.status}).`,
      isRecord(responsePayload.details) ? responsePayload.details : undefined,
    );
  }

  assertWorkerResultContract(responsePayload);
  return responsePayload;
}

function workerRejectionCode(status: number) {
  if (status === 409) {
    return "EXTERNAL_IMPORT_CAPACITY_EXCEEDED";
  }
  if (status === 403) {
    return "EXTERNAL_IMPORT_WORKER_FORBIDDEN";
  }
  return "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED";
}

function assertWorkerResultContract(workerResult: ExternalImportWorkerResult): asserts workerResult is ExternalImportWorkerResult {
  const ok = typeof workerResult.ok === "boolean";
  const jobStatus = readString(workerResult.job_status);
  const manifestStatus = readString(workerResult.manifest_status);
  if (
    !ok ||
    (jobStatus !== "succeeded" && jobStatus !== "failed") ||
    (manifestStatus !== "validated" && manifestStatus !== "failed") ||
    !Array.isArray(workerResult.manifest) ||
    (workerResult.ok === true && (jobStatus !== "succeeded" || manifestStatus !== "validated")) ||
    (workerResult.ok === false && (jobStatus !== "failed" || manifestStatus !== "failed"))
  ) {
    throw new ExternalImportWorkerFailure(
      "EXTERNAL_IMPORT_WORKER_CONTRACT_INVALID",
      "External import worker returned an invalid result contract.",
    );
  }
}

function parseWorkerResponse(responseText: string): ExternalImportWorkerResult {
  if (!responseText.trim()) {
    return {};
  }
  try {
    const payload = JSON.parse(responseText) as unknown;
    return isRecord(payload) ? payload : { message: responseText };
  } catch {
    return { message: responseText };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }
  return 0;
}

function readOptionalRecord(value: unknown) {
  return isRecord(value) ? value : {};
}

function readManifestItems(value: unknown): ExternalImportWorkerManifestItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function normalizeManifestStatus(workerResult: ExternalImportWorkerResult): ExternalImportManifestStatus {
  const status = readString(workerResult.manifest_status);
  if (status === "validated" || status === "failed") {
    return status;
  }
  if (readString(workerResult.job_status) === "failed" || workerResult.ok === false) {
    return "failed";
  }
  return "validated";
}

function normalizeManifestItemStatus(
  item: ExternalImportWorkerManifestItem,
  workerResult: ExternalImportWorkerResult,
): ExternalImportManifestStatus {
  const itemStatus = readString(item.status);
  if (itemStatus === "stale") {
    return "stale";
  }
  if (readString(workerResult.job_status) === "failed" || workerResult.ok === false) {
    return "failed";
  }
  if (
    itemStatus === "parsed" ||
    itemStatus === "warning" ||
    itemStatus === "imported" ||
    itemStatus === "validated" ||
    itemStatus === "failed"
  ) {
    return itemStatus === "imported" ? "validated" : itemStatus;
  }
  return "validated";
}

function workerResultError(workerResult: ExternalImportWorkerResult) {
  const message = readString(workerResult.message) ?? "External import validation failed.";
  return {
    code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
    message,
    validation: readOptionalRecord(workerResult.validation),
  };
}

async function persistExternalImportResult(input: {
  jobId: string;
  spreadsheetId: string;
  importedBy: string;
  workerResult: ExternalImportWorkerResult;
}) {
  const manifestStatus = normalizeManifestStatus(input.workerResult);
  const workerFailed = manifestStatus === "failed";
  const manifest = (await createImportManifest({
    jobId: input.jobId,
    spreadsheetId: input.spreadsheetId,
    status: manifestStatus,
    importedBy: input.importedBy,
    resultMeta: {
      validation: readOptionalRecord(input.workerResult.validation),
      write_result: readOptionalRecord(input.workerResult.write_result),
    },
    error: workerFailed ? workerResultError(input.workerResult) : null,
  })) as { id?: string } | null;

  if (!manifest?.id) {
    throw new Error("External import manifest was not created.");
  }

  const workerManifestItems = readManifestItems(input.workerResult.manifest);
  for (const item of workerManifestItems) {
    const itemStatus = normalizeManifestItemStatus(item, input.workerResult);
    const itemError = readOptionalRecord(item.error);
    await createImportManifestItem({
      manifestId: manifest.id,
      jobId: input.jobId,
      spreadsheetId: input.spreadsheetId,
      sourceTable: readString(item.source_table) ?? readString(item.target_zone_key) ?? "unknown",
      sourceFileName: readString(item.source_file_name) ?? null,
      sourceSheetName: readString(item.source_sheet_name) ?? null,
      fileHash: readString(item.file_hash) ?? null,
      headerSignature: readString(item.header_signature) ?? null,
      rowCount: readNumber(item.row_count),
      columnCount: readNumber(item.column_count),
      amountTotal: readNumber(item.amount_total),
      targetZoneKey: readString(item.target_zone_key) ?? readString(item.source_table) ?? "unknown",
      resolvedZoneFingerprint: readString(item.resolved_zone_fingerprint) ?? null,
      status: itemStatus,
      validationMessage: readString(item.validation_message) ?? null,
      schemaDrift: readOptionalRecord(item.schema_drift),
      resultMeta: {
        worker_status: readString(item.status) ?? null,
      },
      error: itemStatus === "failed" ? (Object.keys(itemError).length ? itemError : workerResultError(input.workerResult)) : null,
    });
  }

  return {
    manifestId: manifest.id,
    manifestStatus,
    importedTableCount: workerManifestItems.filter((item) => normalizeManifestItemStatus(item, input.workerResult) !== "stale")
      .length,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "未登录" });
    }

    const spreadsheetId = readSpreadsheetId(req.body);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "缺少 spreadsheet_id" });
    }

    await requireProjectCollaborator(spreadsheetId, session.user.email);

    const previewHash = readPreviewHash(req.body);
    const previewRecord = previewHash ? findPreviewRecord(previewHash, spreadsheetId) : undefined;

    if (!previewRecord) {
      return res.status(400).json({
        error: "preview_hash 无效或已过期，请重新预览后确认",
        code: "INVALID_PREVIEW_HASH",
      });
    }

    if (!previewRecord.confirmAllowed) {
      return res.status(409).json({
        error: "预览仍有阻塞问题，不能确认导入",
        code: "PREVIEW_NOT_CONFIRMABLE",
      });
    }

    const workerConfig = requireExternalImportWorkerConfig();
    const resolvedZones = await resolveZonesForPreview(spreadsheetId, previewRecord);
    const workerPayload = {
      spreadsheet_id: spreadsheetId,
      preview_hash: previewRecord.previewHash,
      source_tables: previewRecord.sourceTables,
      resolved_zones: resolvedZones,
      parsed_tables: previewRecord.files.flatMap((file) =>
        file.tables.map((table) => ({
          source_table: table.source_role,
          source_role: "uploaded",
          detected: true,
          source_file_name: file.file_name,
          source_sheet_name: table.source_sheet_name,
          file_hash: file.file_hash,
          headers: table.headers,
          rows: table.rows,
          row_count: table.row_count,
          column_count: table.column_count,
          amount_total: table.amount_total,
          target_zone_key: table.target_zone_id,
          schema_drift: {
            warnings: table.warnings,
            blocking_issues: table.blocking_issues,
          },
        })),
      ),
      files: previewRecord.files.map((file) => ({
        file_name: file.file_name,
        file_hash: file.file_hash,
        table_count: file.tables.length,
      })),
    };
    const job = await createJob({
      spreadsheetId,
      jobType: "external_import",
      operation: "external_import",
      createdBy: session.user.email,
      payload: workerPayload,
    });

    if (!job?.id) {
      throw new Error("External import job was not created.");
    }

    const lockToken = randomUUID();
    await markJobRunning({ jobId: job.id, lockToken });

    let workerResult: ExternalImportWorkerResult;
    try {
      workerResult = await dispatchExternalImportWorker({
        jobId: job.id,
        workerUrl: workerConfig.url,
        workerSecret: workerConfig.secret,
        payload: workerPayload,
      });
    } catch (dispatchError) {
      const workerFailure = dispatchError instanceof ExternalImportWorkerFailure ? dispatchError : null;
      await markJobFailed({
        jobId: job.id,
        error: {
          code: workerFailure?.errorCode ?? "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
          message: dispatchError instanceof Error ? dispatchError.message : "External import worker dispatch failed.",
          ...(workerFailure?.details ? { details: workerFailure.details } : {}),
        },
      });
      throw dispatchError;
    }

    try {
      const persistedResult = await persistExternalImportResult({
        jobId: job.id,
        spreadsheetId,
        importedBy: session.user.email,
        workerResult,
      });

      if (persistedResult.manifestStatus === "failed") {
        await markJobFailed({
          jobId: job.id,
          error: workerResultError(workerResult),
        });
      } else {
        await markJobSucceeded({
          jobId: job.id,
          result: {
            manifest_id: persistedResult.manifestId,
            imported_table_count: persistedResult.importedTableCount,
          },
          resultMeta: {
            validation: readOptionalRecord(workerResult.validation),
            write_result: readOptionalRecord(workerResult.write_result),
          },
        });
      }

      return res.status(202).json({
        job_id: job.id,
        status: persistedResult.manifestStatus === "failed" ? "failed" : "succeeded",
        manifest_id: persistedResult.manifestId,
        status_url: `/api/external_import/status?spreadsheet_id=${encodeURIComponent(
          spreadsheetId,
        )}&job_id=${encodeURIComponent(job.id)}`,
      });
    } catch (persistenceError) {
      await markJobFailed({
        jobId: job.id,
        error: {
          code: "EXTERNAL_IMPORT_RESULT_PERSISTENCE_FAILED",
          message:
            persistenceError instanceof Error ? persistenceError.message : "External import result persistence failed.",
        },
      });
      throw persistenceError;
    }
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "外部导入确认失败";
    return res.status(500).json({ error: message });
  }
}
