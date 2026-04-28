import type { NextApiRequest, NextApiResponse } from "next";

import { randomUUID } from "crypto";
import { google } from "googleapis";
import { getServerSession } from "next-auth/next";

import { findPreviewRecord, type ExternalImportPreviewRecord } from "@/lib/external-import/preview-store";
import { resolveImportZone, type ResolvedImportZone } from "@/lib/external-import/import-zone-resolver";
import {
  EXPECTED_EXTERNAL_IMPORT_SOURCE_ROLES,
  EXTERNAL_IMPORT_TARGET_ZONE_BY_SOURCE_ROLE,
  type ExternalImportSourceRole,
} from "@/lib/external-import/source-detection";
import { uploadExternalImportJsonArtifact, type ExternalImportStoredJsonRef } from "@/lib/external-import/upload-storage";
import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import {
  createImportManifest,
  createImportManifestItem,
  createJob,
  findLatestRetainableExternalImportManifestItems,
  type RetainableExternalImportManifestItem,
} from "@/lib/job-service";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

const ASYNC_EXECUTION_ARTIFACT_FORMAT = "external_import.async_execution.chunk_plan.v1";

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
    fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),developerMetadata(metadataKey,metadataValue))",
  });
  return response.data;
}

async function resolveZonesForPreview(spreadsheetId: string, previewRecord: ExternalImportPreviewRecord) {
  const spreadsheet = await loadSpreadsheetMetadata(spreadsheetId);
  const resolvedZones: Record<string, ResolvedImportZone> = {};

  for (const table of previewRecord.sourceTables) {
    const targetZoneKey = table.target_zone_key || table.target_zone_id;
    if (resolvedZones[targetZoneKey]) {
      continue;
    }

    const resolution = resolveImportZone(spreadsheet as Parameters<typeof resolveImportZone>[0], table.source_role, {
      sourceColumnCount: table.column_count,
    });
    if (!resolution.ok) {
      const issue = resolution.blockingIssues[0];
      throw new Error(issue ? `${issue.code}:${issue.message}` : `IMPORT_ZONE_UNRESOLVED:${table.source_role}`);
    }
    resolvedZones[targetZoneKey] = resolution.zone;
  }

  return resolvedZones;
}

function summarizePreviewTable(table: ExternalImportPreviewRecord["sourceTables"][number]) {
  return {
    source_role: table.source_role,
    source_sheet_name: table.source_sheet_name,
    row_count: table.row_count,
    column_count: table.column_count,
    amount_total: table.amount_total,
    target_zone_key: table.target_zone_key,
    target_zone_id: table.target_zone_id,
    warnings: table.warnings,
    blocking_issues: table.blocking_issues,
  };
}

function buildParsedTableChunks(previewRecord: ExternalImportPreviewRecord) {
  return previewRecord.files.flatMap((file) =>
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
      target_zone_key: table.target_zone_key || table.target_zone_id,
      schema_drift: {
        warnings: table.warnings,
        blocking_issues: table.blocking_issues,
      },
    })),
  );
}

function uploadedSourceRoles(previewRecord: ExternalImportPreviewRecord) {
  return new Set(
    previewRecord.files.flatMap((file) =>
      file.tables.map((table) => table.source_role).filter((role): role is ExternalImportSourceRole =>
        EXPECTED_EXTERNAL_IMPORT_SOURCE_ROLES.includes(role as ExternalImportSourceRole),
      ),
    ),
  );
}

function readRetainedNumber(value: unknown) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

function buildAsyncExecutionArtifact(input: {
  executionId: string;
  spreadsheetId: string;
  previewRecord: ExternalImportPreviewRecord;
  resolvedZones: Record<string, ResolvedImportZone>;
}) {
  return {
    format: ASYNC_EXECUTION_ARTIFACT_FORMAT,
    execution_id: input.executionId,
    spreadsheet_id: input.spreadsheetId,
    preview_hash: input.previewRecord.previewHash,
    resolved_zones: input.resolvedZones,
    files: input.previewRecord.files.map((file) => ({
      file_name: file.file_name,
      file_hash: file.file_hash,
      table_count: file.tables.length,
    })),
    chunks: buildParsedTableChunks(input.previewRecord),
  };
}

async function stageAsyncExecutionArtifact(input: {
  executionId: string;
  spreadsheetId: string;
  previewRecord: ExternalImportPreviewRecord;
  resolvedZones: Record<string, ResolvedImportZone>;
}) {
  return uploadExternalImportJsonArtifact({
    spreadsheetId: input.spreadsheetId,
    pathParts: ["async-execution", input.executionId, "parsed-tables.json"],
    format: ASYNC_EXECUTION_ARTIFACT_FORMAT,
    payload: buildAsyncExecutionArtifact(input),
  });
}

function buildDurableJobPayload(input: {
  spreadsheetId: string;
  previewRecord: ExternalImportPreviewRecord;
  resolvedZones: Record<string, ResolvedImportZone>;
  executionArtifact: ExternalImportStoredJsonRef;
}) {
  return {
    spreadsheet_id: input.spreadsheetId,
    preview_hash: input.previewRecord.previewHash,
    payload_format: "external_import.confirm.async.v1",
    execution_artifact: input.executionArtifact,
    parsed_table_count: input.previewRecord.files.reduce((count, file) => count + file.tables.length, 0),
    source_tables: input.previewRecord.sourceTables.map(summarizePreviewTable),
    resolved_zones: input.resolvedZones,
    files: input.previewRecord.files.map((file) => ({
      file_name: file.file_name,
      file_hash: file.file_hash,
      table_count: file.tables.length,
    })),
  };
}

async function createQueuedManifest(input: {
  jobId: string;
  spreadsheetId: string;
  importedBy: string;
  previewRecord: ExternalImportPreviewRecord;
  resolvedZones: Record<string, ResolvedImportZone>;
  executionArtifact: ExternalImportStoredJsonRef;
}) {
  const parsedTableCount = input.previewRecord.files.reduce((count, file) => count + file.tables.length, 0);
  const resultMeta = {
    source: "confirm",
    preview_hash: input.previewRecord.previewHash,
    parsed_table_count: parsedTableCount,
    execution_artifact: input.executionArtifact,
  };
  const manifest = (await createImportManifest({
    jobId: input.jobId,
    spreadsheetId: input.spreadsheetId,
    status: "queued",
    importedBy: input.importedBy,
    resultMeta,
    error: null,
  })) as { id?: string } | null;

  if (!manifest?.id) {
    throw new Error("External import queued manifest was not created.");
  }

  for (const file of input.previewRecord.files) {
    for (const table of file.tables) {
      const targetZoneKey = table.target_zone_key || table.target_zone_id;
      await createImportManifestItem({
        manifestId: manifest.id,
        jobId: input.jobId,
        spreadsheetId: input.spreadsheetId,
        sourceTable: table.source_role,
        sourceFileName: file.file_name,
        sourceSheetName: table.source_sheet_name,
        fileHash: file.file_hash,
        headerSignature: null,
        rowCount: table.row_count,
        columnCount: table.column_count,
        amountTotal: table.amount_total,
        targetZoneKey,
        resolvedZoneFingerprint: input.resolvedZones[targetZoneKey]?.fingerprint ?? null,
        status: "parsed",
        validationMessage: null,
        schemaDrift: {
          warnings: table.warnings,
          blocking_issues: table.blocking_issues,
        },
        resultMeta: {
          source: "preview",
          preview_hash: input.previewRecord.previewHash,
          execution_artifact: input.executionArtifact,
        },
        error: null,
      });
    }
  }

  const uploadedRoles = uploadedSourceRoles(input.previewRecord);
  const missingRoles = EXPECTED_EXTERNAL_IMPORT_SOURCE_ROLES.filter((sourceRole) => !uploadedRoles.has(sourceRole));
  const retainedItems = await findLatestRetainableExternalImportManifestItems({
    spreadsheetId: input.spreadsheetId,
    sourceTables: missingRoles,
    excludeJobId: input.jobId,
  });
  for (const sourceRole of EXPECTED_EXTERNAL_IMPORT_SOURCE_ROLES) {
    if (uploadedRoles.has(sourceRole)) {
      continue;
    }
    const targetZoneKey = EXTERNAL_IMPORT_TARGET_ZONE_BY_SOURCE_ROLE[sourceRole];
    const retainedItem = retainedItems.get(sourceRole) as RetainableExternalImportManifestItem | undefined;
    const effectiveTargetZoneKey = retainedItem?.target_zone_key ?? targetZoneKey;
    await createImportManifestItem({
      manifestId: manifest.id,
      jobId: input.jobId,
      spreadsheetId: input.spreadsheetId,
      sourceTable: sourceRole,
      sourceFileName: retainedItem?.source_file_name ?? null,
      sourceSheetName: retainedItem?.source_sheet_name ?? null,
      fileHash: retainedItem?.file_hash ?? null,
      headerSignature: retainedItem?.header_signature ?? null,
      rowCount: readRetainedNumber(retainedItem?.row_count),
      columnCount: readRetainedNumber(retainedItem?.column_count),
      amountTotal: readRetainedNumber(retainedItem?.amount_total),
      targetZoneKey: effectiveTargetZoneKey,
      resolvedZoneFingerprint: retainedItem?.resolved_zone_fingerprint ?? input.resolvedZones[effectiveTargetZoneKey]?.fingerprint ?? null,
      status: "stale",
      validationMessage: "No file uploaded in this run; retained current worksheet data.",
      schemaDrift: {
        warnings: ["No file uploaded in this run; retained current worksheet data."],
        blocking_issues: [],
      },
      resultMeta: {
        source: "retained",
        preview_hash: input.previewRecord.previewHash,
        execution_artifact: input.executionArtifact,
        retained: true,
        retention_status: "stale",
        retained_reason: "not_uploaded",
        retained_from_manifest_id: retainedItem?.manifest_id ?? null,
        retained_from_item_id: retainedItem?.id ?? null,
        retained_source_missing: !retainedItem,
      },
      error: null,
    });
  }

  return manifest;
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

    const resolvedZones = await resolveZonesForPreview(spreadsheetId, previewRecord);
    const executionId = randomUUID();
    const executionArtifact = await stageAsyncExecutionArtifact({
      executionId,
      spreadsheetId,
      previewRecord,
      resolvedZones,
    });
    const job = await createJob({
      spreadsheetId,
      jobType: "external_import",
      operation: "external_import",
      createdBy: session.user.email,
      payload: buildDurableJobPayload({
        spreadsheetId,
        previewRecord,
        resolvedZones,
        executionArtifact,
      }),
    });

    if (!job?.id) {
      throw new Error("External import job was not created.");
    }

    await createQueuedManifest({
      jobId: job.id,
      spreadsheetId,
      importedBy: session.user.email,
      previewRecord,
      resolvedZones,
      executionArtifact,
    });

    return res.status(202).json({
      job_id: job.id,
      status: "queued",
      status_url: `/api/external_import/status?spreadsheet_id=${encodeURIComponent(
        spreadsheetId,
      )}&job_id=${encodeURIComponent(job.id)}`,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "外部导入确认失败";
    return res.status(500).json({ error: message });
  }
}
