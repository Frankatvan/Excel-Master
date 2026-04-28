import { createClient } from "@supabase/supabase-js";

export type DurableJobStatus = "queued" | "running" | "succeeded" | "failed" | "stale" | "cancelled";

export interface DurableJobRow {
  id: string;
  project_id?: string | null;
  spreadsheet_id?: string | null;
  job_type?: string | null;
  type?: string | null;
  operation?: string | null;
  status: DurableJobStatus | string;
  lock_token?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  heartbeat_at?: string | null;
  finished_at?: string | null;
  progress?: number | null;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  result_meta?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
}

interface SupabaseLike {
  from(table: string): {
    insert?(payload: Record<string, unknown>): unknown;
    update?(payload: Record<string, unknown>): unknown;
  };
}

interface SupabaseResult<T> {
  data: T | null;
  error: unknown;
}

export interface CreateJobInput {
  projectId?: string | null;
  spreadsheetId: string;
  jobType: string;
  operation: string;
  createdBy: string;
  payload?: Record<string, unknown>;
}

export type ExternalImportManifestStatus = "queued" | "parsed" | "warning" | "imported" | "validated" | "failed" | "stale";

export interface CreateImportManifestInput {
  jobId: string;
  projectId?: string | null;
  spreadsheetId: string;
  status: ExternalImportManifestStatus;
  importedBy?: string | null;
  resultMeta?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}

export interface CreateImportManifestItemInput {
  manifestId: string;
  jobId: string;
  projectId?: string | null;
  spreadsheetId: string;
  sourceTable: string;
  sourceFileName?: string | null;
  sourceSheetName?: string | null;
  fileHash?: string | null;
  headerSignature?: string | null;
  rowCount: number;
  columnCount: number;
  amountTotal: number;
  targetZoneKey: string;
  resolvedZoneFingerprint?: string | null;
  status: ExternalImportManifestStatus;
  validationMessage?: string | null;
  schemaDrift?: Record<string, unknown>;
  resultMeta?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}

export interface UpdateImportManifestItemStatusInput {
  itemId: string;
  status: ExternalImportManifestStatus;
  validationMessage?: string | null;
  resultMeta?: Record<string, unknown>;
  error?: Record<string, unknown> | null;
}

function nowIso() {
  return new Date().toISOString();
}

function getSupabaseClient(): SupabaseLike {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service role configuration is missing.");
  }
  return createClient(supabaseUrl, serviceRoleKey) as unknown as SupabaseLike;
}

function selectSingle<T>(query: unknown): Promise<SupabaseResult<T>> {
  const selectable = query as { select(columns?: string): { single(): Promise<SupabaseResult<T>> } };
  return selectable.select().single();
}

function updateById<T>(client: SupabaseLike, jobId: string, payload: Record<string, unknown>): Promise<SupabaseResult<T>> {
  const table = client.from("jobs");
  if (!table.update) {
    throw new Error("Supabase jobs update is unavailable.");
  }
  const query = table.update(payload) as { eq(column: string, value: string): unknown };
  return selectSingle<T>(query.eq("id", jobId));
}

function insertSingle<T>(
  client: SupabaseLike,
  tableName: string,
  payload: Record<string, unknown>,
): Promise<SupabaseResult<T>> {
  const table = client.from(tableName);
  if (!table.insert) {
    throw new Error(`Supabase ${tableName} insert is unavailable.`);
  }
  return selectSingle<T>(table.insert(payload));
}

function updateSingleById<T>(
  client: SupabaseLike,
  tableName: string,
  rowId: string,
  payload: Record<string, unknown>,
): Promise<SupabaseResult<T>> {
  const table = client.from(tableName);
  if (!table.update) {
    throw new Error(`Supabase ${tableName} update is unavailable.`);
  }
  const query = table.update(payload) as { eq(column: string, value: string): unknown };
  return selectSingle<T>(query.eq("id", rowId));
}

function throwIfSupabaseError(error: unknown) {
  if (!error) {
    return;
  }
  if (error instanceof Error) {
    throw error;
  }
  if (typeof error === "string") {
    throw new Error(error);
  }

  if (typeof error === "object" && error !== null) {
    const supabaseError = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    const message = typeof supabaseError.message === "string" && supabaseError.message.trim()
      ? supabaseError.message.trim()
      : "Supabase job operation failed.";
    const context = [
      typeof supabaseError.code === "string" && supabaseError.code.trim() ? `code: ${supabaseError.code.trim()}` : null,
      typeof supabaseError.details === "string" && supabaseError.details.trim()
        ? `details: ${supabaseError.details.trim()}`
        : null,
      typeof supabaseError.hint === "string" && supabaseError.hint.trim() ? `hint: ${supabaseError.hint.trim()}` : null,
    ].filter(Boolean);
    throw new Error(`Supabase job operation failed: ${message}${context.length ? ` (${context.join("; ")})` : ""}`);
  }

  throw new Error("Supabase job operation failed.");
}

export async function createJob(input: CreateJobInput, client: SupabaseLike = getSupabaseClient()) {
  const table = client.from("jobs");
  if (!table.insert) {
    throw new Error("Supabase jobs insert is unavailable.");
  }

  const payload = {
    project_id: input.projectId ?? null,
    spreadsheet_id: input.spreadsheetId,
    job_type: input.jobType,
    type: input.jobType,
    operation: input.operation,
    status: "queued",
    progress: 0,
    created_by: input.createdBy,
    payload: input.payload ?? {},
    result: null,
    result_meta: {},
    error: null,
  };
  const { data, error } = await selectSingle<DurableJobRow>(table.insert(payload));
  throwIfSupabaseError(error);
  return data;
}

export async function createImportManifest(
  input: CreateImportManifestInput,
  client: SupabaseLike = getSupabaseClient(),
) {
  const { data, error } = await insertSingle(client, "external_import_manifests", {
    job_id: input.jobId,
    project_id: input.projectId ?? null,
    spreadsheet_id: input.spreadsheetId,
    status: input.status,
    imported_by: input.importedBy ?? null,
    imported_at: nowIso(),
    result_meta: input.resultMeta ?? {},
    error: input.error ?? null,
  });
  throwIfSupabaseError(error);
  return data;
}

export async function createImportManifestItem(
  input: CreateImportManifestItemInput,
  client: SupabaseLike = getSupabaseClient(),
) {
  const { data, error } = await insertSingle(client, "external_import_manifest_items", {
    manifest_id: input.manifestId,
    job_id: input.jobId,
    project_id: input.projectId ?? null,
    spreadsheet_id: input.spreadsheetId,
    source_table: input.sourceTable,
    source_file_name: input.sourceFileName ?? null,
    source_sheet_name: input.sourceSheetName ?? null,
    file_hash: input.fileHash ?? null,
    header_signature: input.headerSignature ?? null,
    row_count: input.rowCount,
    column_count: input.columnCount,
    amount_total: input.amountTotal,
    target_zone_key: input.targetZoneKey,
    resolved_zone_fingerprint: input.resolvedZoneFingerprint ?? null,
    status: input.status,
    validation_message: input.validationMessage ?? null,
    schema_drift: input.schemaDrift ?? {},
    result_meta: input.resultMeta ?? {},
    error: input.error ?? null,
  });
  throwIfSupabaseError(error);
  return data;
}

export async function updateImportManifestItemStatus(
  input: UpdateImportManifestItemStatusInput,
  client: SupabaseLike = getSupabaseClient(),
) {
  const { data, error } = await updateSingleById(client, "external_import_manifest_items", input.itemId, {
    status: input.status,
    validation_message: input.validationMessage ?? null,
    result_meta: input.resultMeta ?? {},
    error: input.error ?? null,
    imported_at: nowIso(),
  });
  throwIfSupabaseError(error);
  return data;
}

export async function markJobRunning(
  input: { jobId: string; lockToken: string },
  client: SupabaseLike = getSupabaseClient(),
) {
  const timestamp = nowIso();
  const { data, error } = await updateById<DurableJobRow>(client, input.jobId, {
    status: "running",
    lock_token: input.lockToken,
    started_at: timestamp,
    heartbeat_at: timestamp,
  });
  throwIfSupabaseError(error);
  return data;
}

export async function heartbeatJob(
  input: { jobId: string; progress?: number },
  client: SupabaseLike = getSupabaseClient(),
) {
  const payload: Record<string, unknown> = { heartbeat_at: nowIso() };
  if (typeof input.progress === "number") {
    payload.progress = input.progress;
  }
  const { data, error } = await updateById<DurableJobRow>(client, input.jobId, payload);
  throwIfSupabaseError(error);
  return data;
}

export async function markJobSucceeded(
  input: { jobId: string; result?: Record<string, unknown>; resultMeta?: Record<string, unknown> },
  client: SupabaseLike = getSupabaseClient(),
) {
  const { data, error } = await updateById<DurableJobRow>(client, input.jobId, {
    status: "succeeded",
    progress: 100,
    finished_at: nowIso(),
    result: input.result ?? {},
    result_meta: input.resultMeta ?? {},
    error: null,
  });
  throwIfSupabaseError(error);
  return data;
}

export async function markJobFailed(
  input: { jobId: string; error: Record<string, unknown> },
  client: SupabaseLike = getSupabaseClient(),
) {
  const { data, error } = await updateById<DurableJobRow>(client, input.jobId, {
    status: "failed",
    finished_at: nowIso(),
    error: input.error,
  });
  throwIfSupabaseError(error);
  return data;
}

export async function markJobCancelled(
  input: { jobId: string; reason: string },
  client: SupabaseLike = getSupabaseClient(),
) {
  const { data, error } = await updateById<DurableJobRow>(client, input.jobId, {
    status: "cancelled",
    finished_at: nowIso(),
    error: { reason: input.reason },
  });
  throwIfSupabaseError(error);
  return data;
}

export function classifyJobStatus(
  job: Pick<DurableJobRow, "status" | "heartbeat_at" | "started_at" | "finished_at">,
  options: { staleAfterMs?: number; now?: Date } = {},
): DurableJobStatus | string {
  if (job.status !== "running" || job.finished_at) {
    return job.status;
  }

  const thresholdMs = options.staleAfterMs ?? 10 * 60 * 1000;
  const reference = job.heartbeat_at || job.started_at;
  if (!reference) {
    return "stale";
  }

  const referenceTime = new Date(reference).getTime();
  if (!Number.isFinite(referenceTime)) {
    return "stale";
  }

  const now = options.now ?? new Date();
  return now.getTime() - referenceTime > thresholdMs ? "stale" : job.status;
}
