import crypto from "crypto";

import { createClient } from "@supabase/supabase-js";

import { DEFAULT_SUPABASE_URL } from "@/lib/project-registry";

const DEFAULT_UPLOAD_BUCKET = "external-import-uploads";
const UPLOAD_ROOT = "external-import";
const MAX_UPLOAD_FILE_BYTES = 75 * 1024 * 1024;

export interface ExternalImportUploadReservationInput {
  spreadsheetId: string;
  files: Array<{
    fileName: string;
    contentType?: string;
    size?: number;
  }>;
}

export interface ExternalImportUploadReservation {
  file_name: string;
  bucket: string;
  path: string;
  upload_url: string;
  token: string;
}

export interface ExternalImportStoredFileRef {
  file_name: string;
  path: string;
}

export interface ExternalImportStoredFileBuffer {
  name: string;
  buffer: Buffer;
}

function readRequiredEnv() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("External import upload storage is not configured.");
  }
  return { supabaseUrl, serviceRoleKey };
}

function getUploadBucket() {
  return process.env.EXTERNAL_IMPORT_UPLOAD_BUCKET?.trim() || DEFAULT_UPLOAD_BUCKET;
}

function createSupabaseStorageClient() {
  const { supabaseUrl, serviceRoleKey } = readRequiredEnv();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

async function ensureExternalImportUploadBucket(supabase: ReturnType<typeof createSupabaseStorageClient>, bucket: string) {
  const { error: getError } = await supabase.storage.getBucket(bucket);
  if (!getError) {
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(bucket, {
    public: false,
  });
  if (createError && !/already exists/i.test(createError.message || "")) {
    throw new Error(createError.message || "Failed to initialize external import upload storage.");
  }
}

function sanitizePathPart(value: string) {
  const normalized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return normalized || "external-import.xlsx";
}

export function externalImportUploadPathPrefix(spreadsheetId: string) {
  return `${UPLOAD_ROOT}/${sanitizePathPart(spreadsheetId)}/`;
}

function createUploadPath(spreadsheetId: string, fileName: string) {
  const uploadId = crypto.randomUUID();
  return `${externalImportUploadPathPrefix(spreadsheetId)}${uploadId}/${sanitizePathPart(fileName)}`;
}

function assertUploadPathInSpreadsheetScope(spreadsheetId: string, path: string) {
  if (!path.startsWith(externalImportUploadPathPrefix(spreadsheetId))) {
    throw new Error("External import upload path is outside the requested spreadsheet scope.");
  }
}

async function blobToBuffer(blob: Blob) {
  return Buffer.from(await blob.arrayBuffer());
}

export async function createExternalImportUploadReservations(
  input: ExternalImportUploadReservationInput,
): Promise<ExternalImportUploadReservation[]> {
  const bucket = getUploadBucket();
  const supabase = createSupabaseStorageClient();
  await ensureExternalImportUploadBucket(supabase, bucket);

  return Promise.all(
    input.files.map(async (file) => {
      const fileName = sanitizePathPart(file.fileName);
      const size = Number(file.size ?? 0);
      if (Number.isFinite(size) && size > MAX_UPLOAD_FILE_BYTES) {
        throw new Error(`External import upload file is too large: ${fileName}`);
      }
      const path = createUploadPath(input.spreadsheetId, fileName);
      const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, {
        upsert: true,
      });
      if (error) {
        throw new Error(error.message || "Failed to create external import signed upload URL.");
      }
      if (!data?.signedUrl || !data?.token) {
        throw new Error("External import signed upload URL response is incomplete.");
      }
      return {
        file_name: fileName,
        bucket,
        path,
        upload_url: data.signedUrl,
        token: data.token,
      };
    }),
  );
}

export async function downloadExternalImportStoredFiles(
  spreadsheetId: string,
  files: ExternalImportStoredFileRef[],
): Promise<ExternalImportStoredFileBuffer[]> {
  const bucket = getUploadBucket();
  const supabase = createSupabaseStorageClient();

  return Promise.all(
    files.map(async (file) => {
      assertUploadPathInSpreadsheetScope(spreadsheetId, file.path);
      const { data, error } = await supabase.storage.from(bucket).download(file.path);
      if (error) {
        throw new Error(error.message || `Failed to download external import upload: ${file.file_name}`);
      }
      if (!data) {
        throw new Error(`External import upload is missing: ${file.file_name}`);
      }
      return {
        name: sanitizePathPart(file.file_name),
        buffer: await blobToBuffer(data),
      };
    }),
  );
}
