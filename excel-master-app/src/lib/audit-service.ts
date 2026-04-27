import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { google } from "googleapis";

import {
  buildAuditSnapshot,
  normalizeSpreadsheetId,
  type AuditSnapshot,
  type SpreadsheetRow,
} from "@/lib/audit-dashboard";
import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import { readInternalCompanies } from "@/lib/internal-company-registry";
import { buildProject109Range, getProject109Title } from "@/lib/project-109-sheet";
import { DEFAULT_SUPABASE_URL } from "@/lib/project-registry";
import { buildSheetDiscoveries, type SheetDiscoveryResult } from "@/lib/sheet-field-mapper";

interface AuditCacheRow {
  project_id: string;
  data_json: AuditSnapshot;
  last_synced_at: string;
}

interface MemoryAuditCacheRow {
  data_json: AuditSnapshot;
  last_synced_at: string;
  expires_at: number;
}

type SupabaseAdminClient = SupabaseClient<any, any, any, any, any>;
type SnapshotDecisionTable = "payable" | "final_detail";

type SnapshotDataJson = {
  dashboard_summary?: AuditSnapshot;
  audit_dashboard_snapshot?: AuditSnapshot;
  audit_dashboard_last_synced_at?: string;
  classification_decisions?: {
    payable?: Array<Record<string, unknown>>;
    final_detail?: Array<Record<string, unknown>>;
  };
  formula_plan_templates?: Array<Record<string, unknown>>;
  formula_plan_template_count?: number;
};

type SnapshotRunStatus = "queued" | "running" | "succeeded" | "failed" | "partial";
export const AUDIT_SYNC_STALE_AFTER_MS = 5 * 60 * 1000;

type SnapshotWithRunRow = {
  id: string;
  sync_run_id: string;
  created_at: string;
  is_current: boolean;
  source_last_edit_at?: string | null;
  data_json?: SnapshotDataJson | null;
  mapping_manifest_json?: Record<string, unknown> | null;
  audit_sync_runs?: { status?: SnapshotRunStatus } | Array<{ status?: SnapshotRunStatus }> | null;
};

type SnapshotBaseRow = Omit<SnapshotWithRunRow, "audit_sync_runs">;

type CurrentAuditSnapshotRow = {
  id: string;
  sync_run_id: string;
  created_at: string;
  source_last_edit_at?: string | null;
  data_json?: SnapshotDataJson | null;
  mapping_manifest_json?: Record<string, unknown> | null;
};

type CurrentAuditDashboardSnapshot = {
  snapshot_id: string;
  sync_run_id: string;
  snapshot_created_at: string;
  source_last_edit_at?: string;
  source_mode?: string;
  snapshot: SnapshotDataJson & { dashboard_summary: AuditSnapshot };
  last_synced_at: string;
};

export type AuditSnapshotHistoryItem = {
  snapshot_id: string;
  sync_run_id: string;
  created_at: string;
  is_current: boolean;
  sync_run_status: SnapshotRunStatus | "unknown";
  source_last_edit_at?: string;
  decision_count: number;
  formula_template_count: number;
};

export type AuditSnapshotHistoryResult = {
  project_id: string;
  spreadsheet_id: string;
  items: AuditSnapshotHistoryItem[];
};

export type AuditSnapshotDiffResult = {
  spreadsheet_id: string;
  current_snapshot_id?: string;
  target_snapshot_id: string;
  decision_change_count: number;
  table_change_counts: Record<SnapshotDecisionTable, number>;
  formula_template_change_count: number;
};

export type PromoteAuditSnapshotResult = {
  spreadsheet_id: string;
  snapshot_id: string;
  previous_snapshot_id?: string;
  promoted_at: string;
};

export type AuditProjectRunLock = {
  project_id: string;
  lock_token: string;
  operation: string;
  expires_at: string;
};

export class AuditSnapshotServiceError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "AuditSnapshotServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const MEMORY_AUDIT_CACHE_TTL_MS = 5 * 60 * 1000;
const RESERVED_SHEET_TITLES = new Set([
  "Payable",
  "Final Detail",
  "Draw request report",
  "Unit Budget",
  "Unit Master",
  "Scoping",
]);
const SEMANTIC_RUNTIME_FALLBACK_FIELDS: Record<string, string[]> = {
  Payable: ["vendor", "invoice_no", "cost_name", "unit_code"],
  "Final Detail": ["cost_code", "posting_date", "incurred_date", "unit_code"],
  "Draw request report": ["unit_code"],
};
const memoryAuditCache = new Map<string, MemoryAuditCacheRow>();
const SNAPSHOT_DECISION_TABLES: SnapshotDecisionTable[] = ["payable", "final_detail"];
const PERSISTED_RECLASS_ROW_LIMIT = 500;

export function buildMappingWarningMetrics(discoveries: SheetDiscoveryResult[]) {
  const fallbackFields: string[] = [];

  discoveries.forEach((discovery) => {
    const targetFields = SEMANTIC_RUNTIME_FALLBACK_FIELDS[discovery.sheet_name] || [];
    if (targetFields.length === 0) {
      return;
    }

    const selectedFields = new Set(
      discovery.candidates.filter((candidate) => candidate.is_selected).map((candidate) => candidate.logical_field),
    );

    targetFields.forEach((logicalField) => {
      if (!selectedFields.has(logicalField)) {
        fallbackFields.push(`${discovery.sheet_name}.${logicalField}`);
      }
    });
  });

  const dedupedFields = [...new Set(fallbackFields)].sort();
  return {
    fallback_count: dedupedFields.length,
    fallback_fields: dedupedFields,
  };
}

export function buildMappingScoreMetrics(discoveries: SheetDiscoveryResult[]) {
  const selectedCandidates = discoveries.flatMap((discovery) =>
    discovery.candidates.filter((candidate) => candidate.is_selected),
  );
  const mapping_field_count = selectedCandidates.length;
  if (mapping_field_count === 0) {
    return {
      mapping_score: 0,
      mapping_field_count,
    };
  }

  const total = selectedCandidates.reduce((sum, candidate) => sum + Number(candidate.confidence || 0), 0);
  const mapping_score = Number((total / mapping_field_count).toFixed(4));
  return {
    mapping_score,
    mapping_field_count,
  };
}

function isMissingAuditCacheTableError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "PGRST205";
}

function isMissingTableError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "PGRST205";
}

function isSnapshotRunRelationError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const typed = error as { code?: string; message?: string };
  if (typed.code === "PGRST200" || typed.code === "PGRST201") {
    return true;
  }
  const message = typeof typed.message === "string" ? typed.message.toLowerCase() : "";
  return message.includes("relationship") && message.includes("audit_sync_runs");
}

function isMissingFunctionError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "PGRST202";
}

function asSnapshotRunStatus(value: unknown): SnapshotRunStatus | "unknown" {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "partial"
  ) {
    return value;
  }
  return "unknown";
}

export function classifyAuditSyncRun(run: {
  status: string;
  started_at?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
}): "running" | "stale" | "succeeded" | "failed" {
  if (run.status === "succeeded") {
    return "succeeded";
  }
  if (run.status === "failed") {
    return "failed";
  }

  const startedAt = run.started_at || run.created_at;
  if ((run.status === "running" || run.status === "queued") && startedAt) {
    const startedAtMs = new Date(startedAt).getTime();
    if (Number.isFinite(startedAtMs) && Date.now() - startedAtMs > AUDIT_SYNC_STALE_AFTER_MS) {
      return "stale";
    }
  }

  return "running";
}

function getSnapshotRunStatus(row: SnapshotWithRunRow): SnapshotRunStatus | "unknown" {
  const source = Array.isArray(row.audit_sync_runs) ? row.audit_sync_runs[0] : row.audit_sync_runs;
  return asSnapshotRunStatus(source?.status);
}

async function loadSnapshotRunStatusesBySyncRunIds(
  supabase: SupabaseAdminClient,
  syncRunIds: string[],
): Promise<Map<string, SnapshotRunStatus>> {
  const deduped = [...new Set(syncRunIds.filter((id) => typeof id === "string" && id.trim()))];
  if (deduped.length === 0) {
    return new Map<string, SnapshotRunStatus>();
  }

  const { data, error } = await supabase
    .from("audit_sync_runs")
    .select("id,status")
    .in("id", deduped);

  if (error) {
    if (isMissingTableError(error)) {
      return new Map<string, SnapshotRunStatus>();
    }
    throw error;
  }

  const out = new Map<string, SnapshotRunStatus>();
  (data || []).forEach((row) => {
    if (!row || typeof row !== "object") {
      return;
    }
    const typed = row as { id?: unknown; status?: unknown };
    const syncRunId = typeof typed.id === "string" ? typed.id.trim() : "";
    const status = asSnapshotRunStatus(typed.status);
    if (!syncRunId || status === "unknown") {
      return;
    }
    out.set(syncRunId, status);
  });

  return out;
}

function readDecisionCount(dataJson: SnapshotDataJson | null | undefined) {
  if (!dataJson || typeof dataJson !== "object") {
    return 0;
  }
  const decisions = dataJson.classification_decisions;
  if (!decisions || typeof decisions !== "object") {
    return 0;
  }
  return SNAPSHOT_DECISION_TABLES.reduce((sum, tableName) => {
    const rows = decisions[tableName];
    return sum + (Array.isArray(rows) ? rows.length : 0);
  }, 0);
}

function readFormulaTemplateCount(dataJson: SnapshotDataJson | null | undefined) {
  if (!dataJson || typeof dataJson !== "object") {
    return 0;
  }
  const explicitCount = Number(dataJson.formula_plan_template_count || 0);
  if (Number.isFinite(explicitCount) && explicitCount > 0) {
    return explicitCount;
  }
  return Array.isArray(dataJson.formula_plan_templates) ? dataJson.formula_plan_templates.length : 0;
}

function readDecisionSignatureByTable(
  dataJson: SnapshotDataJson | null | undefined,
  table: SnapshotDecisionTable,
): Map<string, string> {
  const rows = dataJson?.classification_decisions?.[table];
  const out = new Map<string, string>();
  if (!Array.isArray(rows)) {
    return out;
  }

  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") {
      return;
    }
    const rowObject = row as Record<string, unknown>;
    const rowIndex = Number(rowObject.row_index_1based || rowObject.row_no || index + 1);
    const rowKey = Number.isFinite(rowIndex) && rowIndex > 0 ? String(Math.trunc(rowIndex)) : String(index + 1);
    const category = typeof rowObject.category === "string" ? rowObject.category.trim() : "";
    const ruleId = typeof rowObject.rule_id === "string" ? rowObject.rule_id.trim() : "";
    out.set(rowKey, `${category}::${ruleId}`);
  });
  return out;
}

function buildFormulaTemplateSignatureMap(dataJson: SnapshotDataJson | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const templates = dataJson?.formula_plan_templates;
  if (!Array.isArray(templates)) {
    return out;
  }

  templates.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const row = item as Record<string, unknown>;
    const sheet = typeof row.sheet === "string" ? row.sheet.trim() : "";
    const cell = typeof row.cell === "string" ? row.cell.trim() : "";
    const key = `${sheet}::${cell || index + 1}`;
    const value =
      (typeof row.formula_template === "string" && row.formula_template.trim()) ||
      (typeof row.formula_rendered === "string" && row.formula_rendered.trim()) ||
      (typeof row.logic === "string" && row.logic.trim()) ||
      "";
    out.set(key, value);
  });
  return out;
}

function countChangedKeys(left: Map<string, string>, right: Map<string, string>) {
  const keys = new Set<string>([...left.keys(), ...right.keys()]);
  let changed = 0;
  keys.forEach((key) => {
    if ((left.get(key) || "") !== (right.get(key) || "")) {
      changed += 1;
    }
  });
  return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeAuditSnapshot(value: unknown): value is AuditSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.project_name === "string" && isRecord(value.audit_tabs);
}

function isNonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function hasPositiveNumericMetric(value: unknown) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) && Math.abs(numericValue) > 0;
}

function hasUsableDashboardIndicators(snapshot: AuditSnapshot) {
  const highlights = Array.isArray(snapshot.highlights) ? snapshot.highlights : [];
  if (
    highlights.some((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const value = String((item as { value?: unknown }).value || "").trim();
      return value !== "" && value !== "-" && value !== "$0" && value !== "$0.00";
    })
  ) {
    return true;
  }

  const auditTabs = snapshot.audit_tabs || {};
  const externalRecon: Record<string, unknown> = isRecord(auditTabs.external_recon) ? auditTabs.external_recon : {};
  if (
    isNonEmptyArray(externalRecon.discrepancies) ||
    isNonEmptyArray(externalRecon.cost_state_matrix) ||
    isNonEmptyArray(externalRecon.detail_rows) ||
    isNonEmptyArray(externalRecon.comparison_rows) ||
    isNonEmptyArray(externalRecon.unit_budget_variances)
  ) {
    return true;
  }

  const manualInput: Record<string, unknown> = isRecord(auditTabs.manual_input) ? auditTabs.manual_input : {};
  if (
    isNonEmptyArray(manualInput.profit_statement_entries) ||
    isNonEmptyArray(manualInput.validation_errors) ||
    isNonEmptyArray(manualInput.scoping_groups) ||
    isNonEmptyArray(manualInput.unit_master_dates)
  ) {
    return true;
  }

  const reclassAudit: Record<string, unknown> = isRecord(auditTabs.reclass_audit) ? auditTabs.reclass_audit : {};
  const reclassOverview: Record<string, unknown> = isRecord(reclassAudit.overview) ? reclassAudit.overview : {};
  if (Object.values(reclassOverview).some(hasPositiveNumericMetric)) {
    return true;
  }

  if (
    isNonEmptyArray(reclassAudit.category_rows) ||
    isNonEmptyArray(reclassAudit.rule_rows) ||
    isNonEmptyArray(reclassAudit.invoice_rows)
  ) {
    return true;
  }

  const compare109: Record<string, unknown> = isRecord(auditTabs.compare_109) ? auditTabs.compare_109 : {};
  return isNonEmptyArray(compare109.metric_rows);
}

export function compactAuditSnapshotForPersistence(snapshot: AuditSnapshot): AuditSnapshot {
  const auditTabs = snapshot.audit_tabs || {};
  const externalRecon: Record<string, unknown> = isRecord(auditTabs.external_recon) ? auditTabs.external_recon : {};
  const reclassAudit: Record<string, unknown> = isRecord(auditTabs.reclass_audit) ? auditTabs.reclass_audit : {};
  const externalDetailRows = Array.isArray(externalRecon.detail_rows) ? externalRecon.detail_rows : [];
  const externalComparisonRows = Array.isArray(externalRecon.comparison_rows) ? externalRecon.comparison_rows : [];
  const reclassInvoiceRows = Array.isArray(reclassAudit.invoice_rows) ? reclassAudit.invoice_rows : [];

  return {
    ...snapshot,
    audit_tabs: {
      ...auditTabs,
      external_recon: {
        ...externalRecon,
        detail_rows: externalDetailRows,
        comparison_rows: externalComparisonRows,
        detail_rows_total_count: externalDetailRows.length,
        comparison_rows_total_count: externalComparisonRows.length,
        detail_rows_truncated: false,
        comparison_rows_truncated: false,
      },
      reclass_audit: {
        ...reclassAudit,
        invoice_rows: reclassInvoiceRows.slice(0, PERSISTED_RECLASS_ROW_LIMIT),
        invoice_rows_total_count: reclassInvoiceRows.length,
        invoice_rows_truncated: reclassInvoiceRows.length > PERSISTED_RECLASS_ROW_LIMIT,
      },
    } as unknown as AuditSnapshot["audit_tabs"],
  } as AuditSnapshot;
}

function extractAuditDashboardSnapshot(dataJson: SnapshotDataJson | null | undefined): AuditSnapshot | null {
  if (!dataJson || typeof dataJson !== "object") {
    return null;
  }

  if (
    looksLikeAuditSnapshot(dataJson.audit_dashboard_snapshot) &&
    hasUsableDashboardIndicators(dataJson.audit_dashboard_snapshot)
  ) {
    return dataJson.audit_dashboard_snapshot;
  }

  if (looksLikeAuditSnapshot(dataJson.dashboard_summary) && hasUsableDashboardIndicators(dataJson.dashboard_summary)) {
    return dataJson.dashboard_summary;
  }

  if (looksLikeAuditSnapshot(dataJson) && hasUsableDashboardIndicators(dataJson)) {
    return dataJson;
  }

  return null;
}

async function getCurrentAuditDashboardSnapshot(
  supabase: SupabaseAdminClient,
  spreadsheetId: string,
): Promise<CurrentAuditDashboardSnapshot | null> {
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  if (!projectId) {
    return null;
  }

  let row: CurrentAuditSnapshotRow | null = null;
  try {
    const response = await supabase
      .from("audit_snapshots")
      .select("id,sync_run_id,created_at,source_last_edit_at,data_json,mapping_manifest_json")
      .eq("project_id", projectId)
      .eq("is_current", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<CurrentAuditSnapshotRow>();

    if (response.error) {
      if (isMissingTableError(response.error)) {
        return null;
      }
      throw response.error;
    }
    row = response.data || null;
  } catch {
    return null;
  }

  if (!row) {
    return null;
  }

  const snapshot = extractAuditDashboardSnapshot(row.data_json);
  if (!snapshot) {
    return null;
  }

  const manifest = row.mapping_manifest_json || {};
  const sourceMode =
    typeof manifest.source_mode === "string" && manifest.source_mode.trim() ? manifest.source_mode.trim() : undefined;

  const explicitLastSyncedAt =
    typeof row.data_json?.audit_dashboard_last_synced_at === "string"
      ? row.data_json.audit_dashboard_last_synced_at
      : undefined;
  const snapshotData = isRecord(row.data_json) ? ({ ...row.data_json } as SnapshotDataJson) : {};

  return {
    snapshot_id: row.id,
    sync_run_id: row.sync_run_id,
    snapshot_created_at: row.created_at,
    source_last_edit_at: row.source_last_edit_at || undefined,
    source_mode: sourceMode,
    snapshot: {
      ...snapshotData,
      dashboard_summary: snapshot,
    },
    last_synced_at: explicitLastSyncedAt || row.created_at,
  };
}

async function attachAuditDashboardSnapshotToCurrentSnapshot({
  supabase,
  spreadsheetId,
  snapshot,
  lastSyncedAt,
  sourceLastEditAt,
}: {
  supabase: SupabaseAdminClient;
  spreadsheetId: string;
  snapshot: AuditSnapshot;
  lastSyncedAt: string;
  sourceLastEditAt?: string;
}) {
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  if (!projectId) {
    return null;
  }

  const current = await getCurrentSnapshotRow(supabase, projectId);
  if (!current) {
    return null;
  }

  const currentDataJson = isRecord(current.data_json) ? { ...current.data_json } : {};
  const mergedDataJson: SnapshotDataJson = {
    ...currentDataJson,
    audit_dashboard_snapshot: snapshot,
    audit_dashboard_last_synced_at: lastSyncedAt,
  };
  const existingManifest = isRecord(current.mapping_manifest_json) ? { ...current.mapping_manifest_json } : {};
  const mergedManifest = {
    ...existingManifest,
    source_mode: "snapshot_plus_dashboard",
    dashboard_synced_at: lastSyncedAt,
  };

  const { error } = await supabase
    .from("audit_snapshots")
    .update({
      data_json: mergedDataJson,
      mapping_manifest_json: mergedManifest,
      source_last_edit_at: sourceLastEditAt || null,
    })
    .eq("id", current.id);

  if (error) {
    throw error;
  }

  return current.id;
}

function isAuditCacheNewerThanCurrentSnapshot(
  cached: AuditCacheRow | null,
  currentSnapshot: CurrentAuditDashboardSnapshot | null,
) {
  if (!cached || !currentSnapshot) {
    return false;
  }

  const cachedTime = Date.parse(cached.last_synced_at);
  const currentTime = Date.parse(currentSnapshot.last_synced_at);
  return Number.isFinite(cachedTime) && Number.isFinite(currentTime) && cachedTime > currentTime;
}

function getSupabaseAdminClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

async function resolveProjectIdBySpreadsheetId(supabase: SupabaseAdminClient, spreadsheetId: string) {
  const { data, error } = await supabase
    .from("projects")
    .select("id")
    .eq("spreadsheet_id", spreadsheetId)
    .maybeSingle<{ id: string | number }>();

  if (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }

  return data?.id ?? null;
}

function readProjectRunLockRpcRow(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return isRecord(row) ? row : {};
}

export async function acquireAuditProjectRunLock({
  supabase,
  projectId,
  operation,
  owner,
  ttlSeconds = 15 * 60,
}: {
  supabase: SupabaseAdminClient;
  projectId: string | number;
  operation: string;
  owner?: string;
  ttlSeconds?: number;
}): Promise<AuditProjectRunLock> {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedOperation = operation.trim();
  if (!normalizedProjectId || !normalizedOperation) {
    throw new AuditSnapshotServiceError("项目锁参数缺失", 400, "PROJECT_LOCK_INPUT_MISSING");
  }

  const { data, error } = await supabase.rpc("try_acquire_audit_project_lock", {
    p_project_id: normalizedProjectId,
    p_operation: normalizedOperation,
    p_owner: owner || "aiwb-api",
    p_ttl_seconds: ttlSeconds,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      throw new AuditSnapshotServiceError("项目级运行锁函数未部署", 500, "PROJECT_LOCK_RPC_MISSING");
    }
    throw error;
  }

  const row = readProjectRunLockRpcRow(data);
  const acquired = row.acquired === true;
  const lockToken = typeof row.lock_token === "string" ? row.lock_token.trim() : "";
  const expiresAt = typeof row.expires_at === "string" ? row.expires_at.trim() : "";
  const activeOperation = typeof row.active_operation === "string" ? row.active_operation.trim() : "";

  if (!acquired || !lockToken) {
    throw new AuditSnapshotServiceError(
      `项目正在执行 ${activeOperation || "其他写入任务"}，请稍后重试`,
      409,
      "PROJECT_RUN_LOCKED",
    );
  }

  return {
    project_id: normalizedProjectId,
    lock_token: lockToken,
    operation: normalizedOperation,
    expires_at: expiresAt,
  };
}

export async function releaseAuditProjectRunLock({
  supabase,
  projectId,
  lockToken,
}: {
  supabase: SupabaseAdminClient;
  projectId: string | number;
  lockToken: string;
}) {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedLockToken = lockToken.trim();
  if (!normalizedProjectId || !normalizedLockToken) {
    return;
  }

  const { error } = await supabase.rpc("release_audit_project_lock", {
    p_project_id: normalizedProjectId,
    p_lock_token: normalizedLockToken,
  });
  if (error && !isMissingFunctionError(error)) {
    throw error;
  }
}

async function createAuditSyncRun({
  supabase,
  projectId,
  spreadsheetId,
}: {
  supabase: SupabaseAdminClient;
  projectId: string | number;
  spreadsheetId: string;
}) {
  try {
    const { data, error } = await supabase
      .from("audit_sync_runs")
      .insert({
        project_id: projectId,
        spreadsheet_id: spreadsheetId,
        trigger_source: "manual",
        status: "running",
        source_last_edit_at: null,
      })
      .select("id")
      .single<{ id: string }>();

    if (error) {
      if (isMissingTableError(error)) {
        console.warn("[Audit] audit_sync_runs table is missing. Skip early sync run tracking.");
        return null;
      }
      throw error;
    }

    return data?.id || null;
  } catch (error) {
    if (isMissingTableError(error)) {
      console.warn("[Audit] audit_sync_runs table is missing. Skip early sync run tracking.");
      return null;
    }
    console.warn("[Audit] Failed to create early audit sync run:", error);
    return null;
  }
}

async function markAuditSyncRunFailed({
  supabase,
  syncRunId,
  error,
}: {
  supabase: SupabaseAdminClient;
  syncRunId: string | null;
  error: unknown;
}) {
  if (!syncRunId) {
    return;
  }

  try {
    await supabase
      .from("audit_sync_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : "audit sync failed",
      })
      .eq("id", syncRunId);
  } catch (updateError) {
    console.warn("[Audit] Failed to mark audit sync run failed:", updateError);
  }
}

async function persistSheetFieldMappingCandidates({
  supabase,
  spreadsheetId,
  rowsBySheetName,
  sourceLastEditAt,
  projectId,
  syncRunId,
}: {
  supabase: SupabaseAdminClient;
  spreadsheetId: string;
  rowsBySheetName: Record<string, SpreadsheetRow[]>;
  sourceLastEditAt?: string;
  projectId?: string | number | null;
  syncRunId?: string | null;
}) {
  const resolvedProjectId = projectId || (await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId));
  if (!resolvedProjectId) {
    return;
  }

  let activeSyncRunId = syncRunId || null;
  try {
    if (!activeSyncRunId) {
      const { data: syncRun, error: syncRunError } = await supabase
        .from("audit_sync_runs")
        .insert({
          project_id: resolvedProjectId,
          spreadsheet_id: spreadsheetId,
          trigger_source: "manual",
          status: "running",
          source_last_edit_at: sourceLastEditAt || null,
        })
        .select("id")
        .single<{ id: string }>();

      if (syncRunError) {
        if (isMissingTableError(syncRunError)) {
          console.warn("[Audit] Mapping persistence tables are missing. Skip candidate persistence.");
          return;
        }
        throw syncRunError;
      }
      activeSyncRunId = syncRun.id;
    }

    const discoveries = buildSheetDiscoveries(rowsBySheetName);
    let persistedCandidateCount = 0;
    const mappingWarningMetrics = buildMappingWarningMetrics(discoveries);
    const mappingScoreMetrics = buildMappingScoreMetrics(discoveries);

    for (const discovery of discoveries) {
      const discoverySnapshotId = await persistDiscoverySnapshotRow({
        supabase,
        projectId: resolvedProjectId,
        syncRunId: activeSyncRunId,
        discovery,
      });

      if (!discoverySnapshotId) {
        continue;
      }

      const selectedCandidateId = await persistDiscoveryCandidatesAndMappings({
        supabase,
        projectId: resolvedProjectId,
        discoverySnapshotId,
        discovery,
      });

      if (selectedCandidateId > 0) {
        persistedCandidateCount += selectedCandidateId;
      }
    }

    await supabase
      .from("audit_sync_runs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        source_last_edit_at: sourceLastEditAt || null,
        metrics_json: {
          sheet_count: Object.keys(rowsBySheetName).length,
          discovery_count: discoveries.length,
          persisted_candidate_count: persistedCandidateCount,
          ...mappingWarningMetrics,
          ...mappingScoreMetrics,
        },
      })
      .eq("id", activeSyncRunId);
  } catch (error) {
    if (activeSyncRunId) {
      await supabase
        .from("audit_sync_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : "mapping persistence failed",
        })
        .eq("id", activeSyncRunId);
    }

    if (isMissingTableError(error)) {
      console.warn("[Audit] Mapping persistence skipped because table is missing.");
      return;
    }

    console.warn("[Audit] Mapping persistence failed:", error);
  }
}

async function persistDiscoverySnapshotRow({
  supabase,
  projectId,
  syncRunId,
  discovery,
}: {
  supabase: SupabaseAdminClient;
  projectId: string | number;
  syncRunId: string;
  discovery: SheetDiscoveryResult;
}) {
  const { data, error } = await supabase
    .from("sheet_discovery_snapshots")
    .insert({
      sync_run_id: syncRunId,
      project_id: projectId,
      sheet_name: discovery.sheet_name,
      header_row_index: discovery.header_row_index,
      header_cells_json: discovery.header_cells,
      data_range_a1: "A:ZZ",
      discovery_context_json: {
        candidate_count: discovery.candidates.length,
      },
    })
    .select("id")
    .single<{ id: number }>();

  if (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }

  return data.id;
}

async function persistDiscoveryCandidatesAndMappings({
  supabase,
  projectId,
  discoverySnapshotId,
  discovery,
}: {
  supabase: SupabaseAdminClient;
  projectId: string | number;
  discoverySnapshotId: number;
  discovery: SheetDiscoveryResult;
}) {
  if (discovery.candidates.length === 0) {
    return 0;
  }

  const candidatesPayload = discovery.candidates.map((candidate) => ({
    discovery_snapshot_id: discoverySnapshotId,
    logical_field: candidate.logical_field,
    column_index: candidate.column_index,
    column_letter: candidate.column_letter,
    header_value: candidate.header_value,
    match_strategy: candidate.match_strategy,
    confidence: candidate.confidence,
    is_required: candidate.is_required,
    is_selected: candidate.is_selected,
    rejection_reason: candidate.rejection_reason,
    candidate_payload_json: {
      source: "header_discovery",
      sheet_name: discovery.sheet_name,
    },
  }));

  const { data: insertedCandidates, error: candidateInsertError } = await supabase
    .from("sheet_field_mapping_candidates")
    .insert(candidatesPayload)
    .select("id, logical_field, column_index, column_letter, confidence, is_selected");

  if (candidateInsertError) {
    if (isMissingTableError(candidateInsertError)) {
      return 0;
    }
    throw candidateInsertError;
  }

  const selectedByField = new Map<
    string,
    { id: number; column_index: number; column_letter: string; confidence: number }
  >();

  (insertedCandidates || []).forEach((candidate) => {
    if (!candidate.is_selected) {
      return;
    }
    selectedByField.set(candidate.logical_field, {
      id: candidate.id,
      column_index: candidate.column_index,
      column_letter: candidate.column_letter,
      confidence: candidate.confidence,
    });
  });

  if (selectedByField.size === 0) {
    return (insertedCandidates || []).length;
  }

  const mappingRows = [...selectedByField.entries()].map(([logicalField, selected]) => ({
    project_id: projectId,
    sheet_name: discovery.sheet_name,
    logical_field: logicalField,
    selected_candidate_id: selected.id,
    selected_discovery_snapshot_id: discoverySnapshotId,
    column_index: selected.column_index,
    column_letter: selected.column_letter,
    header_row_index: discovery.header_row_index,
    confidence: selected.confidence,
    mapping_status: selected.confidence < 0.9 ? "review_required" : "active",
    manual_locked: false,
    mapping_contract_json: {
      version: "v1",
      source_mode: "header",
      normalization: "default",
    },
  }));

  const { error: mappingUpsertError } = await supabase
    .from("sheet_field_mappings")
    .upsert(mappingRows, {
      onConflict: "project_id,sheet_name,logical_field",
    });

  if (mappingUpsertError) {
    if (!isMissingTableError(mappingUpsertError)) {
      throw mappingUpsertError;
    }
  }

  return (insertedCandidates || []).length;
}

async function getSnapshotRowById(
  supabase: SupabaseAdminClient,
  projectId: string | number,
  snapshotId: string,
): Promise<SnapshotWithRunRow | null> {
  const { data, error } = await supabase
    .from("audit_snapshots")
    .select(
      "id,sync_run_id,created_at,is_current,source_last_edit_at,data_json,mapping_manifest_json,audit_sync_runs!audit_snapshots_sync_run_id_fkey(status)",
    )
    .eq("project_id", projectId)
    .eq("id", snapshotId)
    .maybeSingle<SnapshotWithRunRow>();

  if (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }

  return data || null;
}

async function getCurrentSnapshotRow(
  supabase: SupabaseAdminClient,
  projectId: string | number,
): Promise<SnapshotWithRunRow | null> {
  const { data, error } = await supabase
    .from("audit_snapshots")
    .select(
      "id,sync_run_id,created_at,is_current,source_last_edit_at,data_json,mapping_manifest_json,audit_sync_runs!audit_snapshots_sync_run_id_fkey(status)",
    )
    .eq("project_id", projectId)
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<SnapshotWithRunRow>();

  if (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }

  return data || null;
}

export function computeSnapshotDecisionDiff(
  currentDataJson: SnapshotDataJson | null | undefined,
  targetDataJson: SnapshotDataJson | null | undefined,
) {
  const tableChangeCounts = {
    payable: countChangedKeys(
      readDecisionSignatureByTable(currentDataJson, "payable"),
      readDecisionSignatureByTable(targetDataJson, "payable"),
    ),
    final_detail: countChangedKeys(
      readDecisionSignatureByTable(currentDataJson, "final_detail"),
      readDecisionSignatureByTable(targetDataJson, "final_detail"),
    ),
  };

  const decision_change_count = tableChangeCounts.payable + tableChangeCounts.final_detail;
  const formula_template_change_count = countChangedKeys(
    buildFormulaTemplateSignatureMap(currentDataJson),
    buildFormulaTemplateSignatureMap(targetDataJson),
  );

  return {
    decision_change_count,
    table_change_counts: tableChangeCounts,
    formula_template_change_count,
  };
}

export async function listAuditSnapshots(
  spreadsheetIdInput?: string | string[] | null,
  limitInput?: number,
): Promise<AuditSnapshotHistoryResult> {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const supabase = getSupabaseAdminClient();
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  if (!projectId) {
    return {
      project_id: "",
      spreadsheet_id: spreadsheetId,
      items: [],
    };
  }

  const requestedLimit = Number(limitInput || 20);
  const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.trunc(requestedLimit))) : 20;

  const primaryResponse = await supabase
    .from("audit_snapshots")
    .select(
      "id,sync_run_id,created_at,is_current,source_last_edit_at,data_json,mapping_manifest_json,audit_sync_runs!audit_snapshots_sync_run_id_fkey(status)",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);

  let data = primaryResponse.data as SnapshotWithRunRow[] | null;
  let error = primaryResponse.error;
  let fallbackRunStatuses = new Map<string, SnapshotRunStatus>();

  if (error && isSnapshotRunRelationError(error)) {
    const fallbackResponse = await supabase
      .from("audit_snapshots")
      .select("id,sync_run_id,created_at,is_current,source_last_edit_at,data_json,mapping_manifest_json")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(limit);

    data = fallbackResponse.data as SnapshotWithRunRow[] | null;
    error = fallbackResponse.error;

    if (!error && data && data.length > 0) {
      fallbackRunStatuses = await loadSnapshotRunStatusesBySyncRunIds(
        supabase,
        data
          .map((row) => (row && typeof row.sync_run_id === "string" ? row.sync_run_id : ""))
          .filter((id): id is string => Boolean(id)),
      );
    }
  }

  if (error) {
    if (isMissingTableError(error)) {
      return {
        project_id: String(projectId),
        spreadsheet_id: spreadsheetId,
        items: [],
      };
    }
    throw error;
  }

  const items: AuditSnapshotHistoryItem[] = (data || []).map((row) => {
    const item = row as SnapshotWithRunRow | SnapshotBaseRow;
    const statusFromEmbeddedRun =
      "audit_sync_runs" in item ? getSnapshotRunStatus(item as SnapshotWithRunRow) : "unknown";
    const status =
      statusFromEmbeddedRun !== "unknown"
        ? statusFromEmbeddedRun
        : asSnapshotRunStatus(fallbackRunStatuses.get(item.sync_run_id));

    return {
      snapshot_id: item.id,
      sync_run_id: item.sync_run_id,
      created_at: item.created_at,
      is_current: Boolean(item.is_current),
      sync_run_status: status,
      source_last_edit_at: item.source_last_edit_at || undefined,
      decision_count: readDecisionCount(item.data_json),
      formula_template_count: readFormulaTemplateCount(item.data_json),
    };
  });

  return {
    project_id: String(projectId),
    spreadsheet_id: spreadsheetId,
    items,
  };
}

export async function getLatestAuditSyncRunStatus(
  spreadsheetIdInput?: string | string[] | null,
  syncRunIdInput?: string | string[] | null,
) {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const syncRunId = Array.isArray(syncRunIdInput) ? syncRunIdInput[0]?.trim() : syncRunIdInput?.trim();
  const supabase = getSupabaseAdminClient();
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  if (!projectId) {
    return {
      spreadsheet_id: spreadsheetId,
      project_id: "",
      latest_run: null,
    };
  }

  let query = supabase
    .from("audit_sync_runs")
    .select("id,status,created_at,finished_at,source_last_edit_at,error_message")
    .eq("project_id", projectId);

  if (syncRunId) {
    query = query.eq("id", syncRunId);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      id?: string;
      status?: SnapshotRunStatus;
      created_at?: string;
      finished_at?: string | null;
      source_last_edit_at?: string | null;
      error_message?: string | null;
    }>();

  if (error) {
    if (isMissingTableError(error)) {
      return {
        spreadsheet_id: spreadsheetId,
        project_id: String(projectId),
        latest_run: null,
      };
    }
    throw error;
  }

  if (!data?.id) {
    return {
      spreadsheet_id: spreadsheetId,
      project_id: String(projectId),
      latest_run: null,
    };
  }

  return {
    spreadsheet_id: spreadsheetId,
    project_id: String(projectId),
    latest_run: {
      sync_run_id: data.id,
      status: asSnapshotRunStatus(data.status),
      created_at: data.created_at,
      finished_at: data.finished_at || undefined,
      source_last_edit_at: data.source_last_edit_at || undefined,
      error_message: data.error_message || undefined,
    },
  };
}

export async function getAuditSnapshotDiff({
  spreadsheetId,
  targetSnapshotId,
  currentSnapshotId,
}: {
  spreadsheetId: string;
  targetSnapshotId: string;
  currentSnapshotId?: string;
}): Promise<AuditSnapshotDiffResult> {
  const supabase = getSupabaseAdminClient();
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  if (!projectId) {
    throw new AuditSnapshotServiceError("项目未注册，无法读取快照", 404, "PROJECT_NOT_FOUND");
  }

  const targetRow = await getSnapshotRowById(supabase, projectId, targetSnapshotId);
  if (!targetRow) {
    throw new AuditSnapshotServiceError("目标快照不存在", 404, "SNAPSHOT_NOT_FOUND");
  }

  const targetStatus = getSnapshotRunStatus(targetRow);
  if (targetStatus !== "succeeded") {
    throw new AuditSnapshotServiceError("仅 succeeded 快照允许预览与切换", 409, "SNAPSHOT_NOT_SUCCEEDED");
  }

  const currentRow = currentSnapshotId
    ? await getSnapshotRowById(supabase, projectId, currentSnapshotId)
    : await getCurrentSnapshotRow(supabase, projectId);
  if (currentSnapshotId && !currentRow) {
    throw new AuditSnapshotServiceError("当前快照不存在", 404, "CURRENT_SNAPSHOT_NOT_FOUND");
  }

  const summary = computeSnapshotDecisionDiff(currentRow?.data_json, targetRow.data_json);
  return {
    spreadsheet_id: spreadsheetId,
    current_snapshot_id: currentRow?.id,
    target_snapshot_id: targetRow.id,
    decision_change_count: summary.decision_change_count,
    table_change_counts: summary.table_change_counts,
    formula_template_change_count: summary.formula_template_change_count,
  };
}

export async function promoteAuditSnapshotToCurrent({
  spreadsheetId,
  snapshotId,
  actorEmail,
}: {
  spreadsheetId: string;
  snapshotId: string;
  actorEmail?: string;
}): Promise<PromoteAuditSnapshotResult> {
  const supabase = getSupabaseAdminClient();
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  if (!projectId) {
    throw new AuditSnapshotServiceError("项目未注册，无法切换快照", 404, "PROJECT_NOT_FOUND");
  }

  const targetRow = await getSnapshotRowById(supabase, projectId, snapshotId);
  if (!targetRow) {
    throw new AuditSnapshotServiceError("目标快照不存在", 404, "SNAPSHOT_NOT_FOUND");
  }

  const targetStatus = getSnapshotRunStatus(targetRow);
  if (targetStatus !== "succeeded") {
    throw new AuditSnapshotServiceError("仅 succeeded 快照允许设为当前", 409, "SNAPSHOT_NOT_SUCCEEDED");
  }

  const { data, error } = await supabase.rpc("promote_audit_snapshot_to_current", {
    p_project_id: String(projectId),
    p_snapshot_id: snapshotId,
    p_actor_email: actorEmail || null,
  });

  if (error) {
    if (isMissingFunctionError(error)) {
      throw new AuditSnapshotServiceError(
        "快照切换函数未部署，请先执行 WBS-08.2 migration。",
        500,
        "PROMOTION_RPC_MISSING",
      );
    }
    throw error;
  }

  const first = Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object" ? data[0] : null;
  const previousSnapshotId =
    first && "previous_snapshot_id" in first && typeof first.previous_snapshot_id === "string"
      ? first.previous_snapshot_id
      : undefined;

  return {
    spreadsheet_id: spreadsheetId,
    snapshot_id: snapshotId,
    previous_snapshot_id: previousSnapshotId,
    promoted_at: new Date().toISOString(),
  };
}

function getGoogleAuth() {
  return new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getGoogleAuth() });
}

function getDriveClient() {
  return google.drive({ version: "v3", auth: getGoogleAuth() });
}

async function fetchSpreadsheetModifiedTime(spreadsheetId: string): Promise<string | undefined> {
  try {
    const drive = getDriveClient();
    const response = await drive.files.get({
      fileId: spreadsheetId,
      fields: "modifiedTime",
      supportsAllDrives: true,
    });
    const modifiedTime = response.data?.modifiedTime;
    return typeof modifiedTime === "string" && modifiedTime.trim() ? modifiedTime : undefined;
  } catch (error) {
    console.warn("[Audit] Failed to read spreadsheet modifiedTime:", error);
    return undefined;
  }
}

function asRows(valueRange?: { values?: unknown[][] | null }): SpreadsheetRow[] {
  if (!Array.isArray(valueRange?.values)) {
    return [];
  }
  return valueRange.values.map((row) => (Array.isArray(row) ? (row as SpreadsheetRow) : []));
}

function readMemoryAuditCache(spreadsheetId: string): MemoryAuditCacheRow | null {
  const cached = memoryAuditCache.get(spreadsheetId);
  if (!cached) {
    return null;
  }

  if (cached.expires_at <= Date.now()) {
    memoryAuditCache.delete(spreadsheetId);
    return null;
  }

  return cached;
}

function writeMemoryAuditCache(spreadsheetId: string, snapshot: AuditSnapshot, lastSyncedAt: string) {
  memoryAuditCache.set(spreadsheetId, {
    data_json: snapshot,
    last_synced_at: lastSyncedAt,
    expires_at: Date.now() + MEMORY_AUDIT_CACHE_TTL_MS,
  });
}

function shouldBlockLiveAuditSummaryFallback() {
  if (process.env.AIWB_DISABLE_LIVE_AUDIT_SUMMARY === "1") {
    return true;
  }
  return process.env.NODE_ENV === "production" && process.env.AIWB_ALLOW_LIVE_AUDIT_SUMMARY !== "1";
}

function guessProject109TitleFromSheetTitles(sheetTitles: string[]): string | null {
  const numericCandidates = [...new Set(
    sheetTitles
    .map((title) => title.trim())
    .filter((title) => /^\d{3}$/.test(title) && !RESERVED_SHEET_TITLES.has(title)),
  )];

  if (numericCandidates.length === 1) {
    return numericCandidates[0];
  }

  return null;
}

async function resolveSheet109Title(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
): Promise<string> {
  const registeredTitle = (await getProject109Title(spreadsheetId)).trim();
  if (registeredTitle) {
    return registeredTitle;
  }

  try {
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets(properties(title))",
    });
    const guessedTitle = guessProject109TitleFromSheetTitles(
      (metadata.data.sheets || [])
        .map((sheet) => sheet.properties?.title || "")
        .filter((title): title is string => Boolean(title)),
    );

    if (guessedTitle) {
      return guessedTitle;
    }
  } catch {
    // ignore and throw explicit error below
  }

  throw new Error(`PROJECT_MAIN_SHEET_TITLE_UNRESOLVED:${spreadsheetId}`);
}

export async function readAuditCache(spreadsheetId: string): Promise<AuditCacheRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("audit_cache")
    .select("project_id, data_json, last_synced_at")
    .eq("project_id", spreadsheetId)
    .maybeSingle();

  if (error) {
    if (isMissingAuditCacheTableError(error)) {
      console.warn("[Audit] audit_cache table is missing. Falling back to live sheet reads.");
      return null;
    }
    throw error;
  }

  return (data as AuditCacheRow | null) || null;
}

export async function upsertAuditCache(
  spreadsheetId: string,
  snapshot: AuditSnapshot,
  lastSyncedAt: string,
): Promise<AuditCacheRow | null> {
  const supabase = getSupabaseAdminClient();
  const row = {
    project_id: spreadsheetId,
    data_json: snapshot,
    last_synced_at: lastSyncedAt,
  };

  const { data, error } = await supabase
    .from("audit_cache")
    .upsert(row, { onConflict: "project_id" })
    .select("project_id,last_synced_at")
    .single();

  if (error) {
    if (isMissingAuditCacheTableError(error)) {
      console.warn("[Audit] Skipping cache write because audit_cache table is missing.");
      return null;
    }
    throw error;
  }

  return {
    project_id: String((data as { project_id?: unknown } | null)?.project_id || spreadsheetId),
    data_json: snapshot,
    last_synced_at: String((data as { last_synced_at?: unknown } | null)?.last_synced_at || lastSyncedAt),
  };
}

export async function fetchLiveAuditSnapshot(spreadsheetIdInput?: string | string[] | null) {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const sheets = getSheetsClient();
  const sourceLastEditAt = await fetchSpreadsheetModifiedTime(spreadsheetId);
  const sheet109Title = await resolveSheet109Title(sheets, spreadsheetId);
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      buildProject109Range(sheet109Title, "C2"),
      buildProject109Range(sheet109Title, "A1:R120"),
      "'Unit Budget'!A:ZZ",
      "'Payable'!A:AZ",
      "'Final Detail'!A:AL",
      "'Draw request report'!A:AR",
      "'Unit Master'!A:M",
      "'Scoping'!A:Z",
    ],
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const ranges = response.data.valueRanges || [];
  const rows109 = asRows(ranges[1]);
  const projectName = String(asRows(ranges[0])[0]?.[0] || rows109[1]?.[2] || "Unnamed Project");
  const internalCompanies = await readInternalCompanies();
  const kpiRows = rows109;
  const unitBudgetRows = asRows(ranges[2]);
  const payableRows = asRows(ranges[3]);
  const finalDetailRows = asRows(ranges[4]);
  const drawRequestRows = asRows(ranges[5]);
  const unitMasterRows = asRows(ranges[6]);
  const scopingRows = asRows(ranges[7]);
  const rowsBySheetName: Record<string, SpreadsheetRow[]> = {
    [sheet109Title]: rows109,
    // Backward-compatibility alias for legacy resolvers that still use the logical "109" key.
    "109": rows109,
    "Unit Budget": unitBudgetRows,
    "Payable": payableRows,
    "Final Detail": finalDetailRows,
    "Draw request report": drawRequestRows,
    "Unit Master": unitMasterRows,
    "Scoping": scopingRows,
  };
  const discoveries = buildSheetDiscoveries(rowsBySheetName);
  const mappingHealth = {
    ...buildMappingWarningMetrics(discoveries),
    ...buildMappingScoreMetrics(discoveries),
  };
  const snapshot = buildAuditSnapshot({
    projectName,
    kpiRows,
    payableRows,
    finalDetailRows,
    drawRequestRows,
    unitBudgetRows,
    unitMasterRows,
    scopingRows,
    rows109,
    internalCompanies,
    mappingHealth,
  });

  return { spreadsheetId, snapshot, rowsBySheetName, sourceLastEditAt };
}

export async function getAuditSummary(spreadsheetIdInput?: string | string[] | null) {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const supabase = getSupabaseAdminClient();
  const currentSnapshot = await getCurrentAuditDashboardSnapshot(supabase, spreadsheetId);
  const cached = await readAuditCache(spreadsheetId);
  if (currentSnapshot && !isAuditCacheNewerThanCurrentSnapshot(cached, currentSnapshot)) {
    return {
      ...currentSnapshot.snapshot.dashboard_summary,
      last_synced_at: currentSnapshot.last_synced_at,
      from_cache: true,
      from_snapshot: true,
      snapshot_id: currentSnapshot.snapshot_id,
      snapshot_source_mode: currentSnapshot.source_mode || "snapshot_plus_dashboard",
      snapshot_at: currentSnapshot.snapshot_created_at,
      source_last_edit_at: currentSnapshot.source_last_edit_at,
    };
  }

  if (cached) {
    return {
      ...cached.data_json,
      last_synced_at: cached.last_synced_at,
      from_cache: true,
    };
  }

  const memoryCached = readMemoryAuditCache(spreadsheetId);
  if (memoryCached) {
    return {
      ...memoryCached.data_json,
      last_synced_at: memoryCached.last_synced_at,
      from_cache: true,
    };
  }

  if (shouldBlockLiveAuditSummaryFallback()) {
    throw new AuditSnapshotServiceError(
      "后台快照尚未生成或指标不可用",
      409,
      "AUDIT_SNAPSHOT_NOT_READY",
    );
  }

  const { snapshot } = await fetchLiveAuditSnapshot(spreadsheetId);
  const lastSyncedAt = new Date().toISOString();
  await upsertAuditCache(spreadsheetId, snapshot, lastSyncedAt);
  writeMemoryAuditCache(spreadsheetId, snapshot, lastSyncedAt);

  return {
    ...snapshot,
    last_synced_at: lastSyncedAt,
    from_cache: false,
  };
}

type PreparedAuditSummarySync = {
  spreadsheetId: string;
  supabase: SupabaseAdminClient;
  projectId: string | number | null;
  lock: AuditProjectRunLock | null;
  syncRunId: string | null;
};

async function prepareAuditSummarySync(spreadsheetIdInput?: string | string[] | null): Promise<PreparedAuditSummarySync> {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const supabase = getSupabaseAdminClient();
  const projectId = await resolveProjectIdBySpreadsheetId(supabase, spreadsheetId);
  const lock = projectId
    ? await acquireAuditProjectRunLock({
        supabase,
        projectId,
        operation: "audit_sync",
        owner: "next-api:audit_sync",
      })
    : null;
  const syncRunId = projectId
    ? await createAuditSyncRun({
        supabase,
        projectId,
        spreadsheetId,
      })
    : null;

  return {
    spreadsheetId,
    supabase,
    projectId,
    lock,
    syncRunId,
  };
}

async function runPreparedAuditSummarySync({
  spreadsheetId,
  supabase,
  projectId,
  lock,
  syncRunId,
}: PreparedAuditSummarySync) {
  try {
    const { snapshot, rowsBySheetName, sourceLastEditAt } = await fetchLiveAuditSnapshot(spreadsheetId);
    const persistedSnapshot = compactAuditSnapshotForPersistence(snapshot);
    await persistSheetFieldMappingCandidates({
      supabase,
      spreadsheetId,
      rowsBySheetName,
      sourceLastEditAt,
      projectId,
      syncRunId,
    });
    const lastSyncedAt = new Date().toISOString();
    try {
      await upsertAuditCache(spreadsheetId, persistedSnapshot, lastSyncedAt);
    } catch (error) {
      console.warn("[Audit] audit_cache write failed after live sync. Continuing with sync payload.", error);
    }
    try {
      await attachAuditDashboardSnapshotToCurrentSnapshot({
        supabase,
        spreadsheetId,
        snapshot: persistedSnapshot,
        lastSyncedAt,
        sourceLastEditAt,
      });
    } catch (error) {
      console.warn("[Audit] Failed to attach dashboard snapshot to current audit snapshot:", error);
    }
    writeMemoryAuditCache(spreadsheetId, persistedSnapshot, lastSyncedAt);

    return {
      spreadsheetId,
      last_synced_at: lastSyncedAt,
      source_last_edit_at: sourceLastEditAt,
      snapshot: persistedSnapshot,
    };
  } catch (error) {
    await markAuditSyncRunFailed({
      supabase,
      syncRunId,
      error,
    });
    throw error;
  } finally {
    if (lock) {
      await releaseAuditProjectRunLock({
        supabase,
        projectId: lock.project_id,
        lockToken: lock.lock_token,
      }).catch((error) => {
        console.warn("[Audit] Failed to release project run lock:", error);
      });
    }
  }
}

export async function startAuditSummarySync(spreadsheetIdInput?: string | string[] | null) {
  const prepared = await prepareAuditSummarySync(spreadsheetIdInput);
  return {
    spreadsheetId: prepared.spreadsheetId,
    sync_run_id: prepared.syncRunId,
    run: () => runPreparedAuditSummarySync(prepared),
  };
}

export async function syncAuditSummary(spreadsheetIdInput?: string | string[] | null) {
  const prepared = await prepareAuditSummarySync(spreadsheetIdInput);
  return runPreparedAuditSummarySync(prepared);
}
