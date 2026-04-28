import { createClient } from "@supabase/supabase-js";

export interface GetExternalImportStatusInput {
  spreadsheetId: string;
  jobId?: string;
}

type JsonObject = Record<string, unknown>;

export interface ExternalImportJobStatus {
  id: string;
  project_id?: string | null;
  spreadsheet_id?: string | null;
  job_type?: string | null;
  type?: string | null;
  operation?: string | null;
  status: string;
  lock_token?: string | null;
  created_by?: string | null;
  progress?: number | null;
  payload?: JsonObject | null;
  result?: JsonObject | null;
  result_meta?: JsonObject | null;
  error?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
  started_at?: string | null;
  heartbeat_at?: string | null;
  finished_at?: string | null;
}

export interface ExternalImportManifestStatus {
  id: string;
  job_id: string;
  project_id?: string | null;
  spreadsheet_id: string;
  status: string;
  result_meta?: JsonObject | null;
  error?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
  imported_at?: string | null;
  imported_by?: string | null;
}

export interface ExternalImportManifestItemStatus {
  id: string;
  manifest_id: string;
  job_id: string;
  project_id?: string | null;
  spreadsheet_id: string;
  source_table: string;
  source_file_name?: string | null;
  source_sheet_name?: string | null;
  file_hash?: string | null;
  header_signature?: string | null;
  imported_at?: string | null;
  imported_by?: string | null;
  row_count?: number | null;
  column_count?: number | null;
  amount_total?: number | string | null;
  target_zone_key?: string | null;
  resolved_zone_fingerprint?: string | null;
  status: string;
  validation_message?: string | null;
  schema_drift?: JsonObject | null;
  result_meta?: JsonObject | null;
  error?: JsonObject | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ExternalImportProgressStatus {
  percent: number | null;
  total_items: number;
  completed_items: number;
  failed_items: number;
  pending_items: number;
}

export interface ExternalImportStatusPayload {
  spreadsheet_id: string;
  job_id: string | null;
  status: string;
  has_next_step?: boolean;
  current_step?: string | null;
  current_table?: string | null;
  completed_chunks?: number | null;
  total_chunks?: number | null;
  rows_written?: number | null;
  job: ExternalImportJobStatus | null;
  manifest: ExternalImportManifestStatus | null;
  manifest_items: ExternalImportManifestItemStatus[];
  progress: ExternalImportProgressStatus;
}

interface SupabaseResult<T> {
  data: T | null;
  error: unknown;
}

interface QueryBuilder extends PromiseLike<SupabaseResult<unknown>> {
  select(columns?: string): QueryBuilder;
  eq(column: string, value: string): QueryBuilder;
  order(column: string, options?: { ascending?: boolean }): QueryBuilder;
  limit(count: number): QueryBuilder;
  maybeSingle?(): Promise<SupabaseResult<unknown>>;
  single?(): Promise<SupabaseResult<unknown>>;
}

interface SupabaseLike {
  from(table: string): QueryBuilder;
}

const JOB_COLUMNS = [
  "id",
  "project_id",
  "spreadsheet_id",
  "job_type",
  "type",
  "operation",
  "status",
  "lock_token",
  "created_by",
  "progress",
  "result",
  "result_meta",
  "error",
  "created_at",
  "updated_at",
  "started_at",
  "heartbeat_at",
  "finished_at",
].join(",");

const MANIFEST_COLUMNS = [
  "id",
  "job_id",
  "project_id",
  "spreadsheet_id",
  "status",
  "result_meta",
  "error",
  "created_at",
  "updated_at",
  "imported_at",
  "imported_by",
].join(",");

const ITEM_COLUMNS = [
  "id",
  "manifest_id",
  "job_id",
  "project_id",
  "spreadsheet_id",
  "source_table",
  "source_file_name",
  "source_sheet_name",
  "file_hash",
  "header_signature",
  "imported_at",
  "imported_by",
  "row_count",
  "column_count",
  "amount_total",
  "target_zone_key",
  "resolved_zone_fingerprint",
  "status",
  "validation_message",
  "schema_drift",
  "result_meta",
  "error",
  "created_at",
  "updated_at",
].join(",");

function getSupabaseClient(): SupabaseLike {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase service role configuration is missing.");
  }
  return createClient(supabaseUrl, serviceRoleKey) as unknown as SupabaseLike;
}

function throwIfSupabaseError(error: unknown) {
  if (!error) {
    return;
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error(typeof error === "string" ? error : "Supabase external import status query failed.");
}

async function maybeSingle<T>(query: QueryBuilder): Promise<SupabaseResult<T>> {
  if (query.maybeSingle) {
    return query.maybeSingle() as Promise<SupabaseResult<T>>;
  }
  if (query.single) {
    return query.single() as Promise<SupabaseResult<T>>;
  }
  throw new Error("Supabase maybeSingle is unavailable.");
}

async function executeQuery<T>(query: PromiseLike<SupabaseResult<unknown>>): Promise<SupabaseResult<T>> {
  return (await query) as SupabaseResult<T>;
}

async function findLatestJob(
  input: GetExternalImportStatusInput,
  client: SupabaseLike,
): Promise<ExternalImportJobStatus | null> {
  let query = client
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("spreadsheet_id", input.spreadsheetId)
    .eq("job_type", "external_import");

  if (input.jobId) {
    query = query.eq("id", input.jobId);
  }

  const { data, error } = await maybeSingle<ExternalImportJobStatus>(
    query.order("created_at", { ascending: false }).limit(1),
  );
  throwIfSupabaseError(error);
  return data;
}

async function findLatestManifest(
  input: { spreadsheetId: string; jobId: string },
  client: SupabaseLike,
): Promise<ExternalImportManifestStatus | null> {
  const { data, error } = await maybeSingle<ExternalImportManifestStatus>(
    client
      .from("external_import_manifests")
      .select(MANIFEST_COLUMNS)
      .eq("spreadsheet_id", input.spreadsheetId)
      .eq("job_id", input.jobId)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  throwIfSupabaseError(error);
  return data;
}

async function findManifestItems(
  input: { manifestId: string },
  client: SupabaseLike,
): Promise<ExternalImportManifestItemStatus[]> {
  const query = client
    .from("external_import_manifest_items")
    .select(ITEM_COLUMNS)
    .eq("manifest_id", input.manifestId)
    .order("created_at", { ascending: true });
  const { data, error } = await executeQuery<ExternalImportManifestItemStatus[]>(query);
  throwIfSupabaseError(error);
  return data ?? [];
}

function readNumberOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readMetaNumber(meta: JsonObject | null | undefined, keys: string[]) {
  if (!meta) {
    return null;
  }
  for (const key of keys) {
    const value = readNumberOrNull(meta[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function readMetaString(meta: JsonObject | null | undefined, keys: string[]) {
  if (!meta) {
    return null;
  }
  for (const key of keys) {
    const value = readStringOrNull(meta[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function readResultMetaStatus(item: ExternalImportManifestItemStatus) {
  const status = item.result_meta?.worker_status ?? item.result_meta?.status;
  return typeof status === "string" ? status : null;
}

function isCompletedItem(item: ExternalImportManifestItemStatus) {
  const statuses = [item.status, readResultMetaStatus(item)];
  return statuses.some((status) => status === "validated" || status === "imported" || status === "succeeded" || status === "stale" || status === "retained");
}

function isFailedItem(item: ExternalImportManifestItemStatus) {
  const statuses = [item.status, readResultMetaStatus(item)];
  return statuses.some((status) => status === "failed");
}

function emptyProgress(percent: number | null = null): ExternalImportProgressStatus {
  return {
    percent,
    total_items: 0,
    completed_items: 0,
    failed_items: 0,
    pending_items: 0,
  };
}

function buildProgressStatus(
  job: ExternalImportJobStatus | null,
  manifestItems: ExternalImportManifestItemStatus[],
): ExternalImportProgressStatus {
  if (!job) {
    return emptyProgress();
  }

  const percent =
    readNumberOrNull(job.progress) ?? readMetaNumber(job.result_meta, ["progress", "progress_percent", "percent"]);
  const completedItems = manifestItems.filter(isCompletedItem).length;
  const failedItems = manifestItems.filter(isFailedItem).length;
  const totalItems =
    manifestItems.length ||
    readMetaNumber(job.result_meta, ["total_items", "source_count", "parsed_table_count"]) ||
    completedItems + failedItems;
  const pendingItems = Math.max(totalItems - completedItems - failedItems, 0);

  return {
    percent,
    total_items: totalItems,
    completed_items: completedItems,
    failed_items: failedItems,
    pending_items: pendingItems,
  };
}

function hasNextExternalImportStep(job: ExternalImportJobStatus | null) {
  if (!job) {
    return false;
  }
  if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }
  const currentStep = readMetaString(job.result_meta, ["current_step"]);
  return currentStep !== "complete";
}

export async function getExternalImportStatus(
  input: GetExternalImportStatusInput,
  client: SupabaseLike = getSupabaseClient(),
): Promise<ExternalImportStatusPayload> {
  const job = await findLatestJob(input, client);
  if (!job) {
    return {
      spreadsheet_id: input.spreadsheetId,
      job_id: input.jobId ?? null,
      status: "not_started",
      job: null,
      manifest: null,
      manifest_items: [],
      progress: emptyProgress(),
    };
  }

  const manifest = await findLatestManifest({ spreadsheetId: input.spreadsheetId, jobId: job.id }, client);
  const manifestItems = manifest ? await findManifestItems({ manifestId: manifest.id }, client) : [];

  return {
    spreadsheet_id: input.spreadsheetId,
    job_id: job.id,
    status: job.status,
    has_next_step: hasNextExternalImportStep(job),
    current_step: readMetaString(job.result_meta, ["current_step"]),
    current_table: readMetaString(job.result_meta, ["current_table"]),
    completed_chunks: readMetaNumber(job.result_meta, ["completed_chunks"]),
    total_chunks: readMetaNumber(job.result_meta, ["total_chunks"]),
    rows_written: readMetaNumber(job.result_meta, ["rows_written"]),
    job,
    manifest,
    manifest_items: manifestItems,
    progress: buildProgressStatus(job, manifestItems),
  };
}
