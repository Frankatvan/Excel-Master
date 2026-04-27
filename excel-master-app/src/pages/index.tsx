import Head from "next/head";
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { signIn, signOut, useSession } from "next-auth/react";
import type { FormEvent } from "react";
import { Fragment, useEffect, useRef, useState } from "react";

import AuditAmountDetailDrawer, {
  type AuditAmountDetailMode,
  type AuditAmountDetailRow,
} from "@/components/AuditAmountDetailDrawer";
import { DEFAULT_SPREADSHEET_ID as FALLBACK_SPREADSHEET_ID } from "@/lib/audit-dashboard";
import { buildCostNameLabel } from "@/lib/audit-external-recon";
import { normalizeInternalCompanyName } from "@/lib/internal-company-registry";
import { RECLASS_RULES } from "@/lib/reclass-rules";
import {
  WORKBENCH_STAGES,
  canShowUnlockData,
  getAvailableProjectActions,
  getRollbackStageForDirtyState,
  getStageLabel,
  type ProjectAction,
} from "@/lib/workbench-stage";
import {
  PROJECT_SERIAL_ERROR_MESSAGE,
  isValidProjectSerial,
} from "@/lib/project-registry";

interface DashboardData {
  project_name: string;
  workflow_stage?: string;
  from_cache?: boolean;
  from_snapshot?: boolean;
  snapshot_id?: string;
  snapshot_source_mode?: string;
  snapshot_at?: string;
  source_last_edit_at?: string;
  last_synced_at?: string;
  highlights?: Array<{ label: string; value: string; color: string }>;
  audit_tabs?: {
    external_recon?: {
      summary?: string;
      discrepancies?: Array<{
        state: string;
        payable: number;
        final: number;
        diff: number;
      }>;
      cost_state_matrix?: Array<{
        cost_state: string;
        payable_amount: number;
        final_detail_amount: number;
        draw_request_amount: number;
        draw_request_diff_count: number;
      }>;
      cost_state_totals?: {
        payable: {
          grouped_total: number;
          raw_total: number;
          mismatch: boolean;
        };
        final_detail: {
          grouped_total: number;
          raw_total: number;
          mismatch: boolean;
        };
        draw_request: {
          grouped_total: number;
          raw_total: number;
          mismatch: boolean;
        };
      };
      unit_common_counts?: Array<{
        table_name: string;
        unit_count: number;
        common_count: number;
      }>;
      internal_company_cost_state_matrix?: Array<{
        company_name: string;
        cost_state: string;
        amount: number;
      }>;
      unit_budget_variances?: Array<{
        unit_code: string;
        total_budget: number;
        wip_budget: number;
        diff: number;
      }>;
      invoice_match_overview?: {
        payable_total_invoices: number;
        final_total_invoices: number;
        draw_total_invoices: number;
        matched_to_final: number;
        matched_to_draw: number;
        matched_to_both: number;
        payable_unmatched: number;
        final_only: number;
        draw_only: number;
      };
      detail_rows?: Array<{
        source_table: string;
        row_no: number;
        unit_code: string;
        vendor: string;
        old_cost_state: string;
        cost_name: string;
        amount: number;
      }>;
      comparison_rows?: Array<{
        comparison_key: string;
        invoice_label: string;
        vendor: string;
        unit_code: string;
        cost_code: string;
        amount: number;
        payable_cost_states: string[];
        final_detail_cost_states: string[];
        draw_request_cost_states: string[];
        is_fully_aligned: boolean;
      }>;
    };
    manual_input?: {
      profit_statement_entries?: Array<{
        cell_position: string;
        field_name: string;
        amount: number;
      }>;
      validation_errors?: Array<{
        rule_id: string;
        label: string;
        severity: string;
      }>;
      scoping_groups?: Array<{
        group: string;
        group_name?: string;
        scope_values?: string;
        e: string;
        f: string;
        g: string;
        h: string;
        i: string;
        j: string;
        warranty_months: string;
        warranty_due_date: string;
        budget_amount: number;
        incurred_amount: number;
        status: string;
      }>;
      unit_master_dates?: Array<{
        unit_code: string;
        co_date: string;
        final_date: string;
        actual_settlement_date: string;
        tbd_acceptance_date: string;
        final_date_invalid?: boolean;
        actual_settlement_date_invalid?: boolean;
        tbd_acceptance_date_invalid?: boolean;
      }>;
    };
    reclass_audit?: {
      overview?: {
        payable_amount?: number;
        payable_count?: number;
        final_detail_amount?: number;
        final_detail_count?: number;
        diff_count?: number;
        old_total: number;
        new_total: number;
        diff_amount: number;
        diff_invoice_count: number;
      };
      category_rows?: Array<{
        category: string;
        payable_amount?: number;
        payable_count?: number;
        final_detail_amount?: number;
        final_detail_count?: number;
        diff_count?: number;
        old_total: number;
        new_total: number;
        diff_amount: number;
        diff_invoice_count: number;
      }>;
      rule_rows?: Array<{
        rule_id: string;
        category: string;
        old_cost_states: string[];
        amount: number;
        diff_amount: number;
        invoice_count: number;
      }>;
      table_summaries?: ReclassTableSummary[];
      invoice_rows_total_count?: number;
      invoice_rows_truncated?: boolean;
      invoice_rows?: Array<{
        source_table?: "Payable" | "Final Detail";
        row_no?: number;
        vendor: string;
        amount: number;
        incurred_date: string;
        unit_code: string;
        cost_code: string;
        cost_name?: string;
        old_cost_state: string;
        new_category: string;
        rule_id: string;
        match_status: string;
        present_in_final_detail: boolean;
      }>;
      internal_company_category_matrix?: Array<{
        company_name: string;
        category: string;
        payable_amount: number;
        final_detail_amount: number;
        diff_amount: number;
      }>;
      sankey?: {
        nodes: Array<{ name: string }>;
        links: Array<{ source: number; target: number; value: number }>;
      };
    };
    compare_109?: {
      warnings?: Array<{
        code: "MAPPING_AMBIGUITY" | "MAPPING_FALLBACK";
        message: string;
      }>;
      mapping_health?: {
        fallback_count: number;
        fallback_fields: string[];
        mapping_score: number;
        mapping_field_count: number;
      };
      metric_rows?: Array<{
        label: string;
        year_rows: Array<{
          year_offset: number;
          year_label?: string;
          company: number;
          audit: number;
          diff: number;
          has_value?: boolean;
        }>;
      }>;
    };
    scoping_logic?: Array<{
      group_number: string;
      group_name: string;
      statuses: {
        gmp?: string;
        final_gmp?: string;
        fee?: string;
        wip?: string;
        wtc?: string;
        gc?: string;
        tbd?: string;
      };
      budget: number;
      incurred_amount: number;
    }>;
  };
}

interface AmountDetailState {
  mode: AuditAmountDetailMode;
  title: string;
  rows: AuditAmountDetailRow[];
}

type ReclassSourceTable = "Payable" | "Final Detail";

interface ReclassStateAmountRow {
  cost_state: string;
  amount: number;
  count: number;
}

interface ReclassTransitionRow {
  old_cost_state: string;
  new_cost_state: string;
  amount: number;
  count: number;
}

interface ReclassInternalCompanyTransitionRow extends ReclassTransitionRow {
  company_name: string;
}

interface ReclassTableSummary {
  source_table: ReclassSourceTable;
  total_amount: number;
  total_count: number;
  changed_amount: number;
  changed_count: number;
  unchanged_amount: number;
  unchanged_count: number;
  before_rows: ReclassStateAmountRow[];
  after_rows: ReclassStateAmountRow[];
  transition_rows: ReclassTransitionRow[];
  internal_company_transition_rows: ReclassInternalCompanyTransitionRow[];
}

interface ProjectListItem {
  id: string;
  name: string;
  spreadsheet_id: string;
  sheet_109_title?: string;
  project_sequence?: string;
  owner_email?: string;
  created_at?: string;
}

type ProjectListMode = "empty" | "direct" | "summary";
type ProjectStateLoadStatus = "idle" | "loading" | "ready" | "error";
type DetailDrawerPanel = "snapshot" | "lock" | "logs";
const LEGACY_DEFAULT_SPREADSHEET_ID = "MOCK_ID";

interface ProjectStateSnapshot {
  current_stage: string;
  external_data_dirty: boolean;
  manual_input_dirty: boolean;
  locked: boolean;
  can_write?: boolean;
  drive_role?: string | null;
  is_drive_owner?: boolean;
  is_owner_or_admin?: boolean;
  last_sync_at?: string;
  owner_email?: string;
}

interface AuditLogEntry {
  timestamp?: string;
  actor_email?: string;
  action?: string;
  status?: string;
  message?: string;
  previous_stage?: string;
  next_stage?: string;
}

interface EditLogEntry {
  timestamp?: string;
  actor_email?: string;
  sheet_name?: string;
  edited_range?: string;
  edit_area_type?: string;
  source?: string;
}

interface AuditSnapshotHistoryItem {
  snapshot_id: string;
  sync_run_id: string;
  created_at: string;
  is_current: boolean;
  sync_run_status: "queued" | "running" | "succeeded" | "failed" | "partial" | "unknown";
  source_last_edit_at?: string;
  decision_count: number;
  formula_template_count: number;
}

interface AuditSyncRunStatusPayload {
  status?: "queued" | "running" | "succeeded" | "failed" | "partial" | "unknown" | "stale";
  latest_run?: {
    sync_run_id?: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "partial" | "unknown" | "stale";
    created_at?: string;
    started_at?: string;
    finished_at?: string;
    error_message?: string;
  } | null;
}

interface SnapshotDiffPreview {
  decision_change_count: number;
  table_change_counts: {
    payable: number;
    final_detail: number;
  };
  formula_template_change_count: number;
}

interface LiveSheetProtectionSummary {
  title: string;
  description: string;
  protected_range: string;
  unprotected_ranges: string[];
}

interface LiveSheetStatusView {
  spreadsheet_id: string;
  verified_at: string;
  checks: {
    managed_sheets: string[];
    formula_lock_ranges_109: string[];
  };
  protections: LiveSheetProtectionSummary[];
}

interface ExternalImportTableStatus {
  detected_table: string;
  file_name: string;
  source_sheet: string;
  row_count: number;
  amount_total: number;
  semantic_target_zone: string;
  status: string;
  warnings: string[];
  blocking: string[];
}

interface ExternalImportStatusView {
  status?: string;
  import_job_id?: string;
  updated_at?: string;
  preview_hash?: string;
  confirm_allowed?: boolean;
  tables: ExternalImportTableStatus[];
}

const tabs = ["overview", "external-recon", "manual-input", "reclass-audit", "compare-109"] as const;
const TAB_LABELS: Record<(typeof tabs)[number], string> = {
  overview: "总览",
  "external-recon": "外部数据核对",
  "manual-input": "手工录入核对",
  "reclass-audit": "成本重分类",
  "compare-109": "项目利润表对比",
};
const METRIC_LABELS: Record<string, string> = {
  Revenue: "收入",
  "Actual Cost": "成本",
  "Gross Margin": "毛利",
  "Gross Profit": "毛利",
  "Current Period Revenue": "收入",
  "Current Period Cost": "成本",
  "POC (%)": "完工进度",
};
const shellClassName = "min-h-screen bg-[#F7F3EA] text-[#102A38]";
const cardClassName =
  "rounded-[28px] border border-[#D8E3DD] bg-[#FFFDF7] shadow-[0_18px_60px_rgba(16,42,56,0.08)]";
const primaryButtonClassName =
  "rounded-2xl bg-[#287A5C] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#1F6049] disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButtonClassName =
  "rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-5 py-3 text-sm font-semibold text-[#102A38] transition hover:bg-[#EEF6F1] disabled:cursor-not-allowed disabled:opacity-50";

const amountFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});
const RECLASSIFY_COOLDOWN_MS = 60 * 60 * 1000;

function formatCurrency(value?: number, options?: { showZero?: boolean }) {
  const amount = Number(value ?? 0);
  if (!options?.showZero && Math.abs(amount) < 0.005) {
    return "";
  }
  return amountFormatter.format(amount);
}

function formatNumber(value?: number) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

function compareCostStateValues(left: string, right: string) {
  if (left === "未分配") return 1;
  if (right === "未分配") return -1;
  return left.localeCompare(right);
}

function sortCostStateValues(values: string[]) {
  return [...values].sort(compareCostStateValues);
}

function normalizeReclassState(value?: string) {
  const text = String(value || "").trim();
  return text || "未分配";
}

function buildStateRowMap(rows: ReclassTransitionRow[], side: "old_cost_state" | "new_cost_state") {
  const map = new Map<string, ReclassStateAmountRow>();
  rows.forEach((row) => {
    const costState = normalizeReclassState(row[side]);
    const existing = map.get(costState) || { cost_state: costState, amount: 0, count: 0 };
    existing.amount += Number(row.amount || 0);
    existing.count += Number(row.count || 0);
    map.set(costState, existing);
  });

  return [...map.values()]
    .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
    .sort((left, right) => compareCostStateValues(left.cost_state, right.cost_state));
}

function deriveReclassTableSummaries(
  reclassAudit: NonNullable<DashboardData["audit_tabs"]>["reclass_audit"] | undefined,
): ReclassTableSummary[] {
  if (reclassAudit?.table_summaries?.length) {
    return reclassAudit.table_summaries;
  }

  const internalCompanyNames = new Set(
    (reclassAudit?.internal_company_category_matrix || []).map((row) => normalizeInternalCompanyName(row.company_name)),
  );
  if (reclassAudit?.invoice_rows_truncated) {
    return (["Payable", "Final Detail"] as const).map((sourceTable) => ({
      source_table: sourceTable,
      total_amount: 0,
      total_count: 0,
      changed_amount: 0,
      changed_count: 0,
      unchanged_amount: 0,
      unchanged_count: 0,
      before_rows: [],
      after_rows: [],
      transition_rows: [],
      internal_company_transition_rows: [],
    }));
  }

  return (["Payable", "Final Detail"] as const).map((sourceTable) => {
    const transitionMap = new Map<string, ReclassTransitionRow>();
    const internalTransitionMap = new Map<string, ReclassInternalCompanyTransitionRow>();

    (reclassAudit?.invoice_rows || [])
      .filter((row) => (row.source_table || "Payable") === sourceTable)
      .forEach((row) => {
        const oldCostState = normalizeReclassState(row.old_cost_state);
        const newCostState = normalizeReclassState(row.new_category);
        const amount = Number(row.amount || 0);
        const key = `${oldCostState}=>${newCostState}`;
        const transition = transitionMap.get(key) || {
          old_cost_state: oldCostState,
          new_cost_state: newCostState,
          amount: 0,
          count: 0,
        };
        transition.amount += amount;
        transition.count += 1;
        transitionMap.set(key, transition);

        if (row.vendor && internalCompanyNames.has(normalizeInternalCompanyName(row.vendor))) {
          const internalKey = `${row.vendor}::${key}`;
          const internalTransition = internalTransitionMap.get(internalKey) || {
            company_name: row.vendor,
            old_cost_state: oldCostState,
            new_cost_state: newCostState,
            amount: 0,
            count: 0,
          };
          internalTransition.amount += amount;
          internalTransition.count += 1;
          internalTransitionMap.set(internalKey, internalTransition);
        }
      });

    const transitionRows = [...transitionMap.values()]
      .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
      .sort((left, right) => {
        const oldStateOrder = compareCostStateValues(left.old_cost_state, right.old_cost_state);
        return oldStateOrder !== 0 ? oldStateOrder : compareCostStateValues(left.new_cost_state, right.new_cost_state);
      });
    const totalAmount = transitionRows.reduce((sum, row) => sum + row.amount, 0);
    const totalCount = transitionRows.reduce((sum, row) => sum + row.count, 0);
    const changedRows = transitionRows.filter((row) => row.old_cost_state !== row.new_cost_state);
    const changedAmount = changedRows.reduce((sum, row) => sum + row.amount, 0);
    const changedCount = changedRows.reduce((sum, row) => sum + row.count, 0);

    return {
      source_table: sourceTable,
      total_amount: Number(totalAmount.toFixed(2)),
      total_count: totalCount,
      changed_amount: Number(changedAmount.toFixed(2)),
      changed_count: changedCount,
      unchanged_amount: Number((totalAmount - changedAmount).toFixed(2)),
      unchanged_count: totalCount - changedCount,
      before_rows: buildStateRowMap(transitionRows, "old_cost_state"),
      after_rows: buildStateRowMap(transitionRows, "new_cost_state"),
      transition_rows: transitionRows,
      internal_company_transition_rows: [...internalTransitionMap.values()]
        .map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) }))
        .sort((left, right) => {
          if (left.company_name !== right.company_name) {
            return left.company_name.localeCompare(right.company_name);
          }
          const oldStateOrder = compareCostStateValues(left.old_cost_state, right.old_cost_state);
          return oldStateOrder !== 0 ? oldStateOrder : compareCostStateValues(left.new_cost_state, right.new_cost_state);
        }),
    };
  });
}

function formatTimestamp(value?: string) {
  if (!value) {
    return "未同步";
  }

  return new Date(value).toLocaleString("zh-CN");
}

function formatRemainingCooldown(remainingMs: number) {
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours} 小时 ${minutes} 分钟后可再次执行`;
  }

  if (hours > 0) {
    return `${hours} 小时后可再次执行`;
  }

  return `${minutes} 分钟后可再次执行`;
}

function getReclassifyCooldownKey(spreadsheetId: string) {
  return `aiwb:reclassify-cooldown:${spreadsheetId}`;
}

type Compare109MetricRow = NonNullable<
  NonNullable<NonNullable<DashboardData["audit_tabs"]>["compare_109"]>["metric_rows"]
>[number];

function hasCompare109Value(row: Compare109MetricRow["year_rows"][number]) {
  if ("has_value" in row) {
    return Boolean(row.has_value);
  }
  return [row.company, row.audit, row.diff].some((value) => Math.abs(Number(value || 0)) >= 0.005);
}

function buildCompare109YearRows(metricRows: Compare109MetricRow[] = []) {
  const yearMap = new Map<
    string,
    {
      year_offset: number;
      year_label: string;
      metrics: Record<string, { company: number; audit: number; diff: number; has_value: boolean }>;
    }
  >();

  metricRows.forEach((metric) => {
    const metricLabel = mapMetricLabel(metric.label);
    metric.year_rows.forEach((row) => {
      const key = `${row.year_label || `Y${row.year_offset + 1}`}::${row.year_offset}`;
      const existing = yearMap.get(key) || {
        year_offset: row.year_offset,
        year_label: row.year_label || `Y${row.year_offset + 1}`,
        metrics: {},
      };
      existing.metrics[metricLabel] = {
        company: Number(row.company || 0),
        audit: Number(row.audit || 0),
        diff: Number(row.diff || 0),
        has_value: hasCompare109Value(row),
      };
      yearMap.set(key, existing);
    });
  });

  return [...yearMap.values()]
    .filter((row) => Object.values(row.metrics).some((metric) => metric.has_value))
    .sort((left, right) => left.year_offset - right.year_offset);
}

function parseSpreadsheetColumnIndex(cellPosition?: string) {
  const letters = String(cellPosition || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase();
  if (!letters) {
    return null;
  }
  return letters.split("").reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function inferManualEntryYear(cellPosition?: string) {
  const columnIndex = parseSpreadsheetColumnIndex(cellPosition);
  if (columnIndex === null) {
    return "";
  }
  if (columnIndex >= 5 && columnIndex <= 10) {
    return String(2021 + columnIndex - 5);
  }
  if (columnIndex >= 12 && columnIndex <= 17) {
    return String(2021 + columnIndex - 12);
  }
  return "";
}

type ManualProfitEntry = NonNullable<
  NonNullable<NonNullable<DashboardData["audit_tabs"]>["manual_input"]>["profit_statement_entries"]
>[number];

function buildManualProfitYearRows(entries: ManualProfitEntry[] = []) {
  const fieldNames = [...new Set(entries.map((entry) => entry.field_name).filter(Boolean))];
  const yearRows = new Map<string, { year: string; values: Record<string, number>; cells: Record<string, string> }>();

  entries.forEach((entry) => {
    const year = inferManualEntryYear(entry.cell_position);
    if (!year) {
      return;
    }
    const row = yearRows.get(year) || { year, values: {}, cells: {} };
    row.values[entry.field_name] = Number((row.values[entry.field_name] || 0) + Number(entry.amount || 0));
    row.cells[entry.field_name] = [row.cells[entry.field_name], entry.cell_position].filter(Boolean).join(", ");
    yearRows.set(year, row);
  });

  return {
    fieldNames,
    yearRows: [...yearRows.values()].sort((left, right) => left.year.localeCompare(right.year)),
  };
}

function mapMetricLabel(value?: string) {
  if (!value) {
    return "";
  }

  return METRIC_LABELS[value] || value;
}

function resolveErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const maybeError = (payload as { error?: unknown; message?: unknown }).error;
    const maybeMessage = (payload as { error?: unknown; message?: unknown }).message;

    if (typeof maybeError === "string" && maybeError.trim()) {
      return maybeError;
    }

    if (typeof maybeMessage === "string" && maybeMessage.trim()) {
      return maybeMessage;
    }
  }

  return fallback;
}

async function parseResponseBody(response: Response) {
  if (typeof response.text === "function") {
    const raw = await response.text();
    if (!raw.trim()) {
      return null;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return { error: raw };
    }
  }

  if (typeof response.json === "function") {
    return response.json();
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLogEntries(value: unknown): AuditLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .map((item) => ({
      timestamp:
        typeof item.timestamp === "string"
          ? item.timestamp
          : typeof item.created_at === "string"
            ? item.created_at
            : undefined,
      actor_email:
        typeof item.actor_email === "string"
          ? item.actor_email
          : typeof item.actor === "string"
            ? item.actor
            : undefined,
      action: typeof item.action === "string" ? item.action : undefined,
      status: typeof item.status === "string" ? item.status : undefined,
      message: typeof item.message === "string" ? item.message : undefined,
      previous_stage:
        typeof item.previous_stage === "string"
          ? item.previous_stage
          : typeof item.from_stage === "string"
            ? item.from_stage
            : undefined,
      next_stage:
        typeof item.next_stage === "string"
          ? item.next_stage
          : typeof item.to_stage === "string"
            ? item.to_stage
            : undefined,
    }));
}

function normalizeEditLogEntries(value: unknown): EditLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => isRecord(item))
    .map((item) => ({
      timestamp:
        typeof item.timestamp === "string"
          ? item.timestamp
          : typeof item.created_at === "string"
            ? item.created_at
            : undefined,
      actor_email:
        typeof item.actor_email === "string"
          ? item.actor_email
          : typeof item.actor === "string"
            ? item.actor
            : undefined,
      sheet_name:
        typeof item.sheet_name === "string"
          ? item.sheet_name
          : typeof item.sheet === "string"
            ? item.sheet
            : undefined,
      edited_range:
        typeof item.edited_range === "string"
          ? item.edited_range
          : typeof item.range === "string"
            ? item.range
            : undefined,
      edit_area_type:
        typeof item.edit_area_type === "string"
          ? item.edit_area_type
          : typeof item.area_type === "string"
            ? item.area_type
            : undefined,
      source: typeof item.source === "string" ? item.source : undefined,
    }));
}

function parseProjectStatePayload(payload: unknown) {
  if (!isRecord(payload)) {
    return { state: null, logs: [], editLogs: [] };
  }

  const stateCandidate =
    (isRecord(payload.state) ? payload.state : undefined) ||
    (isRecord(payload.project_state) ? payload.project_state : undefined) ||
    undefined;
  const logsCandidate =
    payload.logs ?? payload.audit_logs ?? (isRecord(payload.state) ? payload.state.logs : undefined);
  const editLogsCandidate =
    payload.edit_logs ??
    payload.editLogs ??
    payload.table_edit_logs ??
    (isRecord(payload.state) ? payload.state.edit_logs : undefined);

  const state =
    stateCandidate &&
    typeof stateCandidate.current_stage === "string" &&
    typeof stateCandidate.external_data_dirty === "boolean" &&
    typeof stateCandidate.manual_input_dirty === "boolean" &&
    typeof stateCandidate.locked === "boolean"
      ? ({
          current_stage: stateCandidate.current_stage,
          external_data_dirty: stateCandidate.external_data_dirty,
          manual_input_dirty: stateCandidate.manual_input_dirty,
          locked: stateCandidate.locked,
          can_write: typeof stateCandidate.can_write === "boolean" ? stateCandidate.can_write : undefined,
          drive_role:
            typeof stateCandidate.drive_role === "string" || stateCandidate.drive_role === null
              ? stateCandidate.drive_role
              : undefined,
          is_drive_owner:
            typeof stateCandidate.is_drive_owner === "boolean"
              ? stateCandidate.is_drive_owner
              : undefined,
          is_owner_or_admin:
            typeof stateCandidate.is_owner_or_admin === "boolean"
              ? stateCandidate.is_owner_or_admin
              : undefined,
          last_sync_at: typeof stateCandidate.last_sync_at === "string" ? stateCandidate.last_sync_at : undefined,
          owner_email: typeof stateCandidate.owner_email === "string" ? stateCandidate.owner_email : undefined,
        } satisfies ProjectStateSnapshot)
      : null;

  return {
    state,
    logs: normalizeLogEntries(logsCandidate),
    editLogs: normalizeEditLogEntries(editLogsCandidate),
  };
}

function normalizeLiveSheetStatus(payload: unknown): LiveSheetStatusView | null {
  if (!isRecord(payload)) {
    return null;
  }
  const candidate = isRecord(payload.live_status) ? payload.live_status : payload;
  if (!isRecord(candidate)) {
    return null;
  }

  const checks = isRecord(candidate.checks) ? candidate.checks : {};
  const protections = Array.isArray(candidate.protections)
    ? candidate.protections
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          title: typeof item.title === "string" ? item.title : "",
          description: typeof item.description === "string" ? item.description : "",
          protected_range: typeof item.protected_range === "string" ? item.protected_range : "",
          unprotected_ranges: Array.isArray(item.unprotected_ranges)
            ? item.unprotected_ranges.filter((range): range is string => typeof range === "string")
            : [],
        }))
        .filter((item) => item.title && item.description)
    : [];

  return {
    spreadsheet_id: typeof candidate.spreadsheet_id === "string" ? candidate.spreadsheet_id : "",
    verified_at: typeof candidate.verified_at === "string" ? candidate.verified_at : "",
    checks: {
      managed_sheets: Array.isArray(checks.managed_sheets)
        ? checks.managed_sheets.filter((item): item is string => typeof item === "string")
        : [],
      formula_lock_ranges_109: Array.isArray(checks.formula_lock_ranges_109)
        ? checks.formula_lock_ranges_109.filter((item): item is string => typeof item === "string")
        : [],
    },
    protections,
  };
}

function getStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeExternalImportTableStatus(value: unknown): ExternalImportTableStatus | null {
  if (!isRecord(value)) {
    return null;
  }

  const detectedTable =
    typeof value.detected_table === "string"
      ? value.detected_table
      : typeof value.source_role === "string"
        ? value.source_role
        : typeof value.source_table === "string"
          ? value.source_table
          : typeof value.table_name === "string"
            ? value.table_name
            : "";

  return {
    detected_table: detectedTable,
    file_name:
      typeof value.file_name === "string"
        ? value.file_name
        : typeof value.source_file_name === "string"
          ? value.source_file_name
          : "",
    source_sheet:
      typeof value.source_sheet === "string"
        ? value.source_sheet
        : typeof value.source_sheet_name === "string"
          ? value.source_sheet_name
          : "",
    row_count: Number(value.row_count || 0),
    amount_total: Number(value.amount_total || value.total_amount || 0),
    semantic_target_zone:
      typeof value.semantic_target_zone === "string"
        ? value.semantic_target_zone
        : typeof value.target_zone_id === "string"
          ? value.target_zone_id
          : typeof value.target_zone_key === "string"
            ? value.target_zone_key
            : "",
    status: typeof value.status === "string" ? value.status : "",
    warnings:
      getStringArray(value.warnings).length > 0
        ? getStringArray(value.warnings)
        : isRecord(value.schema_drift) && Array.isArray(value.schema_drift.warnings)
          ? getStringArray(value.schema_drift.warnings)
          : [],
    blocking:
      getStringArray(value.blocking).length > 0
        ? getStringArray(value.blocking)
        : getStringArray(value.blocking_issues),
  };
}

function normalizeExternalImportStatus(payload: unknown): ExternalImportStatusView | null {
  if (!isRecord(payload)) {
    return null;
  }

  const manifest = isRecord(payload.manifest) ? payload.manifest : payload;
  const tablesCandidate =
    (Array.isArray(manifest.tables) && manifest.tables) ||
    (Array.isArray(manifest.statuses) && manifest.statuses) ||
    (Array.isArray(payload.source_tables) && payload.source_tables) ||
    (Array.isArray(payload.manifest_items) && payload.manifest_items) ||
    (Array.isArray(payload.tables) && payload.tables) ||
    [];
  const tables = tablesCandidate
    .map((item) => normalizeExternalImportTableStatus(item))
    .filter((item): item is ExternalImportTableStatus => Boolean(item));

  return {
    status: typeof payload.status === "string" ? payload.status : typeof manifest.status === "string" ? manifest.status : undefined,
    import_job_id:
      typeof payload.import_job_id === "string"
        ? payload.import_job_id
        : typeof payload.job_id === "string"
          ? payload.job_id
          : undefined,
    preview_hash: typeof payload.preview_hash === "string" ? payload.preview_hash : undefined,
    confirm_allowed: typeof payload.confirm_allowed === "boolean" ? payload.confirm_allowed : undefined,
    updated_at:
      typeof payload.updated_at === "string"
        ? payload.updated_at
        : typeof manifest.updated_at === "string"
          ? manifest.updated_at
          : undefined,
    tables,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function readFileAsBase64(file: File) {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer().then(arrayBufferToBase64);
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read import file."));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(arrayBufferToBase64(result));
        return;
      }
      reject(new Error("Failed to read import file."));
    };
    reader.readAsArrayBuffer(file);
  });
}

function panelClassName(extra = "") {
  return `${cardClassName} ${extra}`.trim();
}

function ReclassRulesIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7h7" strokeLinecap="round" />
      <path d="M13 17h7" strokeLinecap="round" />
      <path d="M4 17h3" strokeLinecap="round" />
      <path d="M17 7h3" strokeLinecap="round" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

function OperatorGuideIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M7 3h7l4 4v14H7z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 3v5h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 12h5" strokeLinecap="round" />
      <path d="M10 16h5" strokeLinecap="round" />
    </svg>
  );
}

function SnapshotHistoryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 12a8 8 0 1 0 2.34-5.66" strokeLinecap="round" />
      <path d="M4 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockAreaIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" strokeLinecap="round" />
      <path d="M12 15v2" strokeLinecap="round" />
    </svg>
  );
}

function ProjectLogsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 7h12" strokeLinecap="round" />
      <path d="M6 12h12" strokeLinecap="round" />
      <path d="M6 17h8" strokeLinecap="round" />
    </svg>
  );
}

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    props: {
      defaultSpreadsheetId:
        process.env.NEXT_PUBLIC_DEFAULT_SPREADSHEET_ID?.trim() ||
        process.env.GOOGLE_SHEET_ID?.trim() ||
        FALLBACK_SPREADSHEET_ID,
    },
  };
};

export default function Home({ defaultSpreadsheetId }: { defaultSpreadsheetId: string }) {
  const { data: session } = useSession();
  const router = useRouter();
  const spreadsheetId = Array.isArray(router.query.spreadsheetId)
    ? router.query.spreadsheetId[0]
    : router.query.spreadsheetId;
  const normalizedSpreadsheetId = typeof spreadsheetId === "string" ? spreadsheetId.trim() : "";

  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("overview");
  const [projectMode, setProjectMode] = useState<ProjectListMode>("empty");
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [projectListLoading, setProjectListLoading] = useState(false);
  const [projectData, setProjectData] = useState<DashboardData | null>(null);
  const [projectState, setProjectState] = useState<ProjectStateSnapshot | null>(null);
  const [projectStateForId, setProjectStateForId] = useState<string | null>(null);
  const [projectStateLoadStatus, setProjectStateLoadStatus] = useState<ProjectStateLoadStatus>("idle");
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [editLogs, setEditLogs] = useState<EditLogEntry[]>([]);
  const [detailDrawerPanel, setDetailDrawerPanel] = useState<DetailDrawerPanel | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [projectActionPending, setProjectActionPending] = useState<"validate_input" | "approve_109" | "unlock_data" | null>(
    null,
  );
  const [reclassifying, setReclassifying] = useState(false);
  const [fetchTime, setFetchTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpRequested, setOtpRequested] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [reclassifyStatus, setReclassifyStatus] = useState<string | null>(null);
  const [projectActionStatus, setProjectActionStatus] = useState<string | null>(null);
  const [projectInitStatus, setProjectInitStatus] = useState<string | null>(null);
  const [reclassifyCooldownUntil, setReclassifyCooldownUntil] = useState<number | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectOwnerInput, setProjectOwnerInput] = useState("");
  const [projectSerialInput, setProjectSerialInput] = useState("");
  const [projectInitSubmitting, setProjectInitSubmitting] = useState(false);
  const [amountDetailState, setAmountDetailState] = useState<AmountDetailState | null>(null);
  const [snapshotHistory, setSnapshotHistory] = useState<AuditSnapshotHistoryItem[]>([]);
  const [snapshotHistoryLoading, setSnapshotHistoryLoading] = useState(false);
  const [snapshotPromotingId, setSnapshotPromotingId] = useState<string | null>(null);
  const [snapshotDiffPreviewById, setSnapshotDiffPreviewById] = useState<Record<string, SnapshotDiffPreview>>({});
  const [liveSheetStatus, setLiveSheetStatus] = useState<LiveSheetStatusView | null>(null);
  const [liveSheetStatusLoading, setLiveSheetStatusLoading] = useState(false);
  const [externalImportStatus, setExternalImportStatus] = useState<ExternalImportStatusView | null>(null);
  const [externalImportStatusLoading, setExternalImportStatusLoading] = useState(false);
  const [externalImportFile, setExternalImportFile] = useState<File | null>(null);
  const [externalImportPreviewHash, setExternalImportPreviewHash] = useState<string | null>(null);
  const [externalImportPreviewing, setExternalImportPreviewing] = useState(false);
  const [externalImportConfirming, setExternalImportConfirming] = useState(false);
  const [externalImportMessage, setExternalImportMessage] = useState<string | null>(null);

  const isLegacySpreadsheetId = normalizedSpreadsheetId === LEGACY_DEFAULT_SPREADSHEET_ID;
  const routeSpreadsheetId =
    normalizedSpreadsheetId && normalizedSpreadsheetId !== LEGACY_DEFAULT_SPREADSHEET_ID ? normalizedSpreadsheetId : "";
  const directSpreadsheetId =
    projectMode === "direct"
      ? (projects.find((item) => item.spreadsheet_id?.trim())?.spreadsheet_id || "").trim()
      : "";
  const currentId = routeSpreadsheetId || (isLegacySpreadsheetId ? defaultSpreadsheetId : "") || directSpreadsheetId;
  const latestSpreadsheetIdRef = useRef(currentId);
  latestSpreadsheetIdRef.current = currentId;
  const activeProjectState = projectStateForId === currentId ? projectState : null;
  const isProjectSummaryView = projectMode === "summary" && !routeSpreadsheetId && !isLegacySpreadsheetId;
  const isProjectEmptyView = projectMode === "empty" && !routeSpreadsheetId && !isLegacySpreadsheetId;
  const canShowProjectDetail = Boolean(currentId) && !isProjectSummaryView && !isProjectEmptyView;
  const selectedProject =
    projects.find((item) => item.spreadsheet_id.trim() === currentId) ||
    projects.find((item) => item.spreadsheet_id.trim() === routeSpreadsheetId) ||
    null;
  const normalizedStage =
    activeProjectState &&
    Object.values(WORKBENCH_STAGES).includes(
      activeProjectState.current_stage as (typeof WORKBENCH_STAGES)[keyof typeof WORKBENCH_STAGES],
    )
      ? (activeProjectState.current_stage as (typeof WORKBENCH_STAGES)[keyof typeof WORKBENCH_STAGES])
      : WORKBENCH_STAGES.PROJECT_CREATED;
  const hasWritableProjectState = Boolean(activeProjectState) && projectStateLoadStatus === "ready";
  const canWriteProject = activeProjectState?.can_write ?? true;
  const canWriteExternalImport = hasWritableProjectState && canWriteProject;
  const isDriveOwner = activeProjectState?.is_drive_owner ?? activeProjectState?.is_owner_or_admin ?? false;
  const availableActions = getAvailableProjectActions({
    current_stage: normalizedStage,
    locked: Boolean(activeProjectState?.locked),
    isOwnerOrAdmin: Boolean(isDriveOwner),
  });
  const visibleActions: ProjectAction[] = hasWritableProjectState
    ? availableActions.filter((action) =>
        action === "sync_data" ||
        action === "validate_input" ||
        action === "reclassify" ||
        action === "approve_109"
          ? canWriteProject
          : true,
      )
    : ["open_sheet"];
  const showUnlockAction =
    hasWritableProjectState &&
    canShowUnlockData({
      current_stage: normalizedStage,
      locked: Boolean(activeProjectState?.locked),
      isOwnerOrAdmin: Boolean(isDriveOwner),
    });
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(currentId)}/edit`;
  const externalRecon = projectData?.audit_tabs?.external_recon;
  const manualInput = projectData?.audit_tabs?.manual_input;
  const reclassAudit = projectData?.audit_tabs?.reclass_audit;
  const compare109 = projectData?.audit_tabs?.compare_109;
  const externalReconDetailRows = externalRecon?.detail_rows || [];
  const externalReconComparisonRows = externalRecon?.comparison_rows || [];
  const externalUnitCommonCounts = externalRecon?.unit_common_counts || [];
  const externalInternalCompanyRows = externalRecon?.internal_company_cost_state_matrix || [];
  const externalInternalCompanyStates = sortCostStateValues(
    Array.from(new Set(externalInternalCompanyRows.map((row) => row.cost_state))),
  );
  const externalInternalCompanyNames = [...new Set(externalInternalCompanyRows.map((row) => row.company_name))].sort(
    (left, right) => left.localeCompare(right),
  );
  const externalInternalCompanyMatrix = new Map(
    externalInternalCompanyRows.map((row) => [`${row.company_name}::${row.cost_state}`, row.amount]),
  );
  const reclassTableSummaries = deriveReclassTableSummaries(reclassAudit);
  const totalReclassChangedCount = reclassTableSummaries.reduce((sum, row) => sum + row.changed_count, 0);
  const manualValidationCount = manualInput?.validation_errors?.length ?? 0;
  const manualEntryCount = manualInput?.profit_statement_entries?.length ?? 0;
  const discrepancyCount = externalRecon?.discrepancies?.filter((item) => Math.abs(item.diff) > 1).length ?? 0;
  const unitVarianceCount = externalRecon?.unit_budget_variances?.filter((item) => Math.abs(item.diff) > 1).length ?? 0;
  const compareYearRows = buildCompare109YearRows(compare109?.metric_rows || []);
  const compareMetrics = ["收入", "成本", "毛利"];
  const manualProfitYearView = buildManualProfitYearRows(manualInput?.profit_statement_entries || []);
  const compareDiffTotal = compareYearRows.reduce(
    (total, yearRow) =>
      total + compareMetrics.reduce((sum, metric) => sum + Math.abs(yearRow.metrics[metric]?.diff || 0), 0),
    0,
  );
  const compareYearCount = compareYearRows.length;
  const stageLabel = getStageLabel(
    activeProjectState?.current_stage || projectData?.workflow_stage || WORKBENCH_STAGES.PROJECT_CREATED,
  );
  const snapshotAtMs = projectData?.snapshot_at ? new Date(projectData.snapshot_at).getTime() : NaN;
  const sourceLastEditMs = projectData?.source_last_edit_at ? new Date(projectData.source_last_edit_at).getTime() : NaN;
  const snapshotIsStale =
    Boolean(projectData?.from_snapshot) &&
    Number.isFinite(snapshotAtMs) &&
    Number.isFinite(sourceLastEditMs) &&
    sourceLastEditMs > snapshotAtMs;
  const nextAction =
    totalReclassChangedCount > 0
      ? `变更 ${formatNumber(totalReclassChangedCount)} 条`
      : "可执行";
  const trimmedProjectName = projectNameInput.trim();
  const trimmedProjectOwner = projectOwnerInput.trim();
  const trimmedProjectSerial = projectSerialInput.trim();
  const projectSerialInvalid = !isValidProjectSerial(trimmedProjectSerial);
  const projectFormInvalid = !trimmedProjectName || !trimmedProjectOwner || projectSerialInvalid;
  const cooldownRemainingMs = reclassifyCooldownUntil ? Math.max(0, reclassifyCooldownUntil - clockNow) : 0;
  const isReclassifyCoolingDown = cooldownRemainingMs > 0;
  const isBusy = syncing || reclassifying || projectActionPending !== null;
  const reclassifyBlocked = isBusy || isReclassifyCoolingDown;
  const reclassifyStatusText = isReclassifyCoolingDown
    ? [reclassifyStatus, formatRemainingCooldown(cooldownRemainingMs)].filter(Boolean).join("，")
    : reclassifyStatus;
  const highlightCards =
    projectData?.highlights && projectData.highlights.length > 0
      ? projectData.highlights
      : [
          { label: "收入", value: "-", color: "slate" },
          { label: "成本", value: "-", color: "slate" },
          { label: "毛利", value: "-", color: "slate" },
          { label: "完工进度", value: "-", color: "slate" },
        ];
  const highlightCardMap = new Map(highlightCards.map((item) => [mapMetricLabel(item.label), item.value]));
  const summaryHighlightRows = ["收入", "成本", "毛利", "完工进度"].map((label) => ({
    label,
    value: highlightCardMap.get(label) || "-",
  }));
  const rollbackStage = getRollbackStageForDirtyState({
    external_data_dirty: Boolean(activeProjectState?.external_data_dirty),
    manual_input_dirty: Boolean(activeProjectState?.manual_input_dirty),
  });
  const dirtyWarning = activeProjectState?.external_data_dirty || activeProjectState?.manual_input_dirty;
  const dirtyWarningText = activeProjectState?.external_data_dirty
    ? activeProjectState.manual_input_dirty
      ? "外部数据区与人工录入区已修改，当前结果待刷新"
      : "外部数据区已修改，建议先验证录入数据"
    : activeProjectState?.manual_input_dirty
      ? "人工录入区已修改，建议重新执行成本重分类"
      : null;
  const rollbackHint = rollbackStage ? `建议阶段：${getStageLabel(rollbackStage)}` : null;
  const selectedProjectMainSheetTitle =
    selectedProject?.project_sequence?.trim() || selectedProject?.sheet_109_title?.trim() || "";
  const registeredProjectName = selectedProject?.name?.trim() || "";
  const dashboardProjectName = projectData?.project_name?.trim() || "";
  const displayProjectNameCore =
    (loading && canShowProjectDetail ? "加载中" : "") ||
    registeredProjectName ||
    dashboardProjectName ||
    "未命名项目";
  const projectDisplayName =
    selectedProjectMainSheetTitle && displayProjectNameCore && displayProjectNameCore !== "加载中"
      ? `${selectedProjectMainSheetTitle} · ${displayProjectNameCore}`
      : displayProjectNameCore;
  const currentSnapshotItem = snapshotHistory.find((item) => item.is_current) || null;
  const formulaLockRanges109 = liveSheetStatus?.checks.formula_lock_ranges_109 || [];
  const formulaLockProtections109 =
    liveSheetStatus?.protections.filter(
      (item) => item.description.startsWith("AiWB managed formula lock") && item.title === (selectedProject?.sheet_109_title || item.title),
    ) || [];

  function getExternalReconAmountRows(sourceTable: string, costState: string) {
    return externalReconDetailRows.filter(
      (row) => row.source_table === sourceTable && row.old_cost_state === costState,
    );
  }

  function openExternalReconAmountDetail(sourceTable: string, costState: string) {
    const rows = getExternalReconAmountRows(sourceTable, costState);
    setAmountDetailState({
      mode: "external_recon",
      title: `${costState} / ${sourceTable}`,
      rows,
    });
  }

  function getExternalReconDiffRows(costState: string): AuditAmountDetailRow[] {
    const matchesCostState = (row: {
      payable_cost_states: string[];
      final_detail_cost_states: string[];
      draw_request_cost_states: string[];
    }) => {
      const states = new Set<string>([
        ...(row.payable_cost_states || []),
        ...(row.final_detail_cost_states || []),
        ...(row.draw_request_cost_states || []),
      ]);

      if (states.size === 0) {
        states.add("未分配");
      }

      return states.has(costState);
    };

    return externalReconComparisonRows
      .filter((row) => !row.is_fully_aligned && matchesCostState(row))
      .map((row, index) => ({
        source_table: row.comparison_key || `comparison-${index + 1}`,
        row_no: index + 1,
        unit_code: row.unit_code,
        vendor: row.vendor,
        old_cost_state: row.draw_request_cost_states.join(", "),
        cost_name: row.cost_code,
        cost_code: row.cost_code,
        amount: row.amount,
        invoice_label: row.invoice_label,
        payable_cost_states: row.payable_cost_states,
        final_detail_cost_states: row.final_detail_cost_states,
        draw_request_cost_states: row.draw_request_cost_states,
      }));
  }

  function openExternalReconDiffDetail(costState: string) {
    setAmountDetailState({
      mode: "external_recon_diff",
      title: `${costState} / 差异条数`,
      rows: getExternalReconDiffRows(costState),
    });
  }

  function getExternalReconTotalAmount(sourceTable: string) {
    return externalReconDetailRows
      .filter((row) => row.source_table === sourceTable)
      .reduce((sum, row) => sum + (row.amount || 0), 0);
  }

  function getCostStateMatrixTotal(sourceKey: "payable_amount" | "final_detail_amount" | "draw_request_amount") {
    return (externalRecon?.cost_state_matrix || []).reduce((sum, row) => sum + (row[sourceKey] || 0), 0);
  }

  function getCostStateDiffCountTotal() {
    return (externalRecon?.cost_state_matrix || []).reduce((sum, row) => sum + (row.draw_request_diff_count || 0), 0);
  }

  function getExternalInternalCompanyAmountRows(companyName: string, costState: string) {
    const normalizedCompany = normalizeInternalCompanyName(companyName);
    return externalReconDetailRows.filter(
      (row) =>
        row.source_table === "Payable" &&
        normalizeInternalCompanyName(row.vendor) === normalizedCompany &&
        row.old_cost_state === costState,
    );
  }

  function openExternalInternalCompanyAmountDetail(companyName: string, costState: string) {
    setAmountDetailState({
      mode: "external_recon",
      title: `${companyName} / ${costState}`,
      rows: getExternalInternalCompanyAmountRows(companyName, costState),
    });
  }

  function getReclassTransitionAmountRows(
    sourceTable: ReclassSourceTable,
    oldCostState: string,
    newCostState: string,
  ) {
    return (reclassAudit?.invoice_rows || [])
      .filter(
        (row) =>
          (row.source_table || "Payable") === sourceTable &&
          normalizeReclassState(row.old_cost_state) === oldCostState &&
          normalizeReclassState(row.new_category) === newCostState,
      )
      .map((row, index) => ({
        source_table: row.source_table || "Payable",
        row_no: row.row_no || index + 1,
        unit_code: row.unit_code,
        vendor: row.vendor,
        old_cost_state: row.old_cost_state,
        cost_name: row.cost_name || buildCostNameLabel(row.cost_code, ""),
        amount: row.amount,
        reclass_category: row.new_category,
      }));
  }

  function isReclassDetailComplete(rows: AuditAmountDetailRow[], amount: number, count: number) {
    if (rows.length !== count) {
      return false;
    }
    const rowAmount = Number(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2));
    return Math.abs(rowAmount - Number(amount || 0)) < 0.01;
  }

  async function fetchReclassTransitionAmountRows({
    sourceTable,
    oldCostState,
    newCostState,
    companyName,
  }: {
    sourceTable: ReclassSourceTable;
    oldCostState: string;
    newCostState: string;
    companyName?: string;
  }): Promise<AuditAmountDetailRow[]> {
    const params = new URLSearchParams({
      spreadsheet_id: currentId,
      source_table: sourceTable,
      old_cost_state: oldCostState,
      new_cost_state: newCostState,
    });
    if (companyName) {
      params.set("company_name", companyName);
    }
    const res = await fetch(`/api/audit_reclass_detail?${params.toString()}`);
    const data = await parseResponseBody(res);
    if (!res.ok || !data || typeof data !== "object" || !Array.isArray((data as { rows?: unknown }).rows)) {
      throw new Error(resolveErrorMessage(data, "重分类明细加载失败"));
    }
    return (data as { rows: AuditAmountDetailRow[] }).rows;
  }

  function openReclassTransitionAmountDetail(
    sourceTable: ReclassSourceTable,
    oldCostState: string,
    newCostState: string,
    expectedAmount?: number,
    expectedCount?: number,
  ) {
    const localRows = getReclassTransitionAmountRows(sourceTable, oldCostState, newCostState);
    setAmountDetailState({
      mode: "reclass_audit",
      title: `${sourceTable} / ${oldCostState} -> ${newCostState}`,
      rows: localRows,
    });
    if (
      expectedAmount !== undefined &&
      expectedCount !== undefined &&
      isReclassDetailComplete(localRows, expectedAmount, expectedCount)
    ) {
      return;
    }
    void fetchReclassTransitionAmountRows({ sourceTable, oldCostState, newCostState })
      .then((rows) => {
        setAmountDetailState({
          mode: "reclass_audit",
          title: `${sourceTable} / ${oldCostState} -> ${newCostState}`,
          rows,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "重分类明细加载失败";
        setProjectActionStatus(message);
      });
  }

  function getReclassInternalCompanyAmountRows(
    companyName: string,
    sourceTable: ReclassSourceTable,
    oldCostState: string,
    newCostState: string,
  ) {
    const normalizedCompany = normalizeInternalCompanyName(companyName);
    return getReclassTransitionAmountRows(sourceTable, oldCostState, newCostState).filter(
      (row) => normalizeInternalCompanyName(row.vendor) === normalizedCompany,
    );
  }

  function openReclassInternalCompanyAmountDetail(
    companyName: string,
    sourceTable: ReclassSourceTable,
    oldCostState: string,
    newCostState: string,
    expectedAmount?: number,
    expectedCount?: number,
  ) {
    const localRows = getReclassInternalCompanyAmountRows(companyName, sourceTable, oldCostState, newCostState);
    setAmountDetailState({
      mode: "reclass_audit",
      title: `${companyName} / ${sourceTable} / ${oldCostState} -> ${newCostState}`,
      rows: localRows,
    });
    if (
      expectedAmount !== undefined &&
      expectedCount !== undefined &&
      isReclassDetailComplete(localRows, expectedAmount, expectedCount)
    ) {
      return;
    }
    void fetchReclassTransitionAmountRows({ sourceTable, oldCostState, newCostState, companyName })
      .then((rows) => {
        setAmountDetailState({
          mode: "reclass_audit",
          title: `${companyName} / ${sourceTable} / ${oldCostState} -> ${newCostState}`,
          rows,
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "重分类明细加载失败";
        setProjectActionStatus(message);
      });
  }

  async function loadDashboard(spreadsheetId: string) {
    if (!spreadsheetId) {
      if (!latestSpreadsheetIdRef.current) {
        setProjectData(null);
      }
      return;
    }

    const start = performance.now();
    if (latestSpreadsheetIdRef.current === spreadsheetId) {
      setLoading(true);
      setError(null);
    }

    try {
      const res = await fetch(`/api/audit_summary?spreadsheet_id=${encodeURIComponent(spreadsheetId)}`);
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "加载失败"));
      }
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      setProjectData((data || null) as DashboardData | null);
      setFetchTime(Math.round(performance.now() - start));
    } catch (loadError) {
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      const message = loadError instanceof Error ? loadError.message : "加载失败";
      setError(message);
    } finally {
      if (latestSpreadsheetIdRef.current === spreadsheetId) {
        setLoading(false);
      }
    }
  }

  async function loadLiveSheetStatus(spreadsheetId: string) {
    if (!spreadsheetId) {
      if (!latestSpreadsheetIdRef.current) {
        setLiveSheetStatus(null);
      }
      return;
    }

    if (latestSpreadsheetIdRef.current === spreadsheetId) {
      setLiveSheetStatusLoading(true);
    }

    try {
      const res = await fetch(`/api/live_sheet_status?spreadsheet_id=${encodeURIComponent(spreadsheetId)}`);
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "锁定状态读取失败"));
      }
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      setLiveSheetStatus(normalizeLiveSheetStatus(data));
    } catch (_loadError) {
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      setLiveSheetStatus(null);
    } finally {
      if (latestSpreadsheetIdRef.current === spreadsheetId) {
        setLiveSheetStatusLoading(false);
      }
    }
  }

  async function loadExternalImportStatus(spreadsheetId: string, importJobId?: string | null) {
    if (!spreadsheetId) {
      if (!latestSpreadsheetIdRef.current) {
        setExternalImportStatus(null);
      }
      return null;
    }

    if (latestSpreadsheetIdRef.current === spreadsheetId) {
      setExternalImportStatusLoading(true);
    }

    try {
      const params = new URLSearchParams({ spreadsheet_id: spreadsheetId });
      if (importJobId) {
        params.set("job_id", importJobId);
      }
      const res = await fetch(`/api/external_import/status?${params.toString()}`);
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "外部导入状态读取失败"));
      }
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return null;
      }
      const nextStatus = normalizeExternalImportStatus(data);
      setExternalImportStatus(nextStatus);
      return nextStatus;
    } catch (statusError) {
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return null;
      }
      const message = statusError instanceof Error ? statusError.message : "外部导入状态读取失败";
      setExternalImportMessage(message);
      return null;
    } finally {
      if (latestSpreadsheetIdRef.current === spreadsheetId) {
        setExternalImportStatusLoading(false);
      }
    }
  }

  async function loadProjectList() {
    setProjectListLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/projects/list");
      const data = await parseResponseBody(res);
      if (!res.ok || !isRecord(data)) {
        throw new Error(resolveErrorMessage(data, "加载项目列表失败"));
      }

      const modeValue =
        data.mode === "direct" || data.mode === "summary" || data.mode === "empty" ? data.mode : "empty";
      const projectItems = Array.isArray(data.projects)
        ? data.projects
            .filter((item): item is Record<string, unknown> => isRecord(item))
            .map((item) => ({
              id: typeof item.id === "string" ? item.id : "",
              name: typeof item.name === "string" ? item.name : "未命名项目",
              spreadsheet_id: typeof item.spreadsheet_id === "string" ? item.spreadsheet_id : "",
              sheet_109_title: typeof item.sheet_109_title === "string" ? item.sheet_109_title : undefined,
              project_sequence: typeof item.project_sequence === "string" ? item.project_sequence : undefined,
              owner_email: typeof item.owner_email === "string" ? item.owner_email : undefined,
              created_at: typeof item.created_at === "string" ? item.created_at : undefined,
            }))
            .filter((item) => item.spreadsheet_id.trim())
        : [];

      setProjectMode(modeValue);
      setProjects(projectItems);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "加载项目列表失败";
      setError(message);
      setProjectMode("empty");
      setProjects([]);
    } finally {
      setProjectListLoading(false);
    }
  }

  async function loadProjectState(spreadsheetId: string) {
    if (!spreadsheetId) {
      if (!latestSpreadsheetIdRef.current) {
        setProjectStateLoadStatus("idle");
        setProjectStateForId(null);
        setProjectState(null);
        setAuditLogs([]);
        setEditLogs([]);
      }
      return;
    }

    if (latestSpreadsheetIdRef.current === spreadsheetId) {
      setProjectStateLoadStatus("loading");
      setProjectStateForId(null);
      setProjectState(null);
      setAuditLogs([]);
      setEditLogs([]);
      setError(null);
    }

    try {
      const res = await fetch(`/api/projects/state?spreadsheet_id=${encodeURIComponent(spreadsheetId)}`);
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "加载项目状态失败"));
      }
      const parsed = parseProjectStatePayload(data);
      if (!parsed.state) {
        throw new Error("加载项目状态失败");
      }
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      setProjectState(parsed.state);
      setProjectStateForId(spreadsheetId);
      setAuditLogs(parsed.logs);
      setEditLogs(parsed.editLogs);
      setProjectStateLoadStatus("ready");
    } catch (loadError) {
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      const message = loadError instanceof Error ? loadError.message : "加载项目状态失败";
      setError(message);
      setProjectStateLoadStatus("error");
      setProjectStateForId(null);
      setProjectState(null);
      setAuditLogs([]);
      setEditLogs([]);
    }
  }

  async function loadSnapshotHistory(spreadsheetId: string) {
    if (!spreadsheetId) {
      if (!latestSpreadsheetIdRef.current) {
        setSnapshotHistory([]);
        setSnapshotDiffPreviewById({});
      }
      return;
    }

    if (latestSpreadsheetIdRef.current === spreadsheetId) {
      setSnapshotHistoryLoading(true);
    }

    try {
      const res = await fetch(`/api/audit_snapshots?spreadsheet_id=${encodeURIComponent(spreadsheetId)}&limit=10`);
      const data = await parseResponseBody(res);
      if (!res.ok || !isRecord(data)) {
        throw new Error(resolveErrorMessage(data, "加载快照历史失败"));
      }
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }

      const items: AuditSnapshotHistoryItem[] = Array.isArray(data.items)
        ? data.items
            .filter((item): item is Record<string, unknown> => isRecord(item))
            .map((item): AuditSnapshotHistoryItem => {
              const syncRunStatus: AuditSnapshotHistoryItem["sync_run_status"] =
                item.sync_run_status === "queued" ||
                item.sync_run_status === "running" ||
                item.sync_run_status === "succeeded" ||
                item.sync_run_status === "failed" ||
                item.sync_run_status === "partial"
                  ? item.sync_run_status
                  : "unknown";
              return {
                snapshot_id: typeof item.snapshot_id === "string" ? item.snapshot_id : "",
                sync_run_id: typeof item.sync_run_id === "string" ? item.sync_run_id : "",
                created_at: typeof item.created_at === "string" ? item.created_at : "",
                is_current: Boolean(item.is_current),
                sync_run_status: syncRunStatus,
                source_last_edit_at:
                  typeof item.source_last_edit_at === "string" && item.source_last_edit_at.trim()
                    ? item.source_last_edit_at
                    : undefined,
                decision_count: Number(item.decision_count || 0),
                formula_template_count: Number(item.formula_template_count || 0),
              };
            })
            .filter((item) => item.snapshot_id)
        : [];

      setSnapshotHistory(items);
      setSnapshotDiffPreviewById((current) =>
        Object.fromEntries(Object.entries(current).filter(([snapshotId]) => items.some((item) => item.snapshot_id === snapshotId))),
      );
    } catch (loadError) {
      if (latestSpreadsheetIdRef.current !== spreadsheetId) {
        return;
      }
      const message = loadError instanceof Error ? loadError.message : "加载快照历史失败";
      setError(message);
      setSnapshotHistory([]);
    } finally {
      if (latestSpreadsheetIdRef.current === spreadsheetId) {
        setSnapshotHistoryLoading(false);
      }
    }
  }

  async function handlePreviewSnapshotDiff(snapshotId: string) {
    if (!currentId || !snapshotId) {
      return;
    }

    setError(null);
    try {
      const res = await fetch(
        `/api/audit_snapshots/diff?spreadsheet_id=${encodeURIComponent(currentId)}&target_snapshot_id=${encodeURIComponent(snapshotId)}`,
      );
      const data = await parseResponseBody(res);
      if (!res.ok || !isRecord(data)) {
        throw new Error(resolveErrorMessage(data, "快照差异预览失败"));
      }

      const preview: SnapshotDiffPreview = {
        decision_change_count: Number(data.decision_change_count || 0),
        table_change_counts: {
          payable: Number(isRecord(data.table_change_counts) ? data.table_change_counts.payable || 0 : 0),
          final_detail: Number(isRecord(data.table_change_counts) ? data.table_change_counts.final_detail || 0 : 0),
        },
        formula_template_change_count: Number(data.formula_template_change_count || 0),
      };
      setSnapshotDiffPreviewById((current) => ({
        ...current,
        [snapshotId]: preview,
      }));
      setProjectActionStatus(`已预览快照差异：${preview.decision_change_count} 条决策变化`);
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "快照差异预览失败";
      setError(message);
    }
  }

  async function handlePromoteSnapshot(snapshotId: string) {
    if (!currentId || !snapshotId || isBusy || snapshotPromotingId) {
      return;
    }

    setSnapshotPromotingId(snapshotId);
    setError(null);
    setProjectActionStatus(null);

    try {
      if (!snapshotDiffPreviewById[snapshotId]) {
        await handlePreviewSnapshotDiff(snapshotId);
      }

      const res = await fetch("/api/audit_snapshots/promote", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          spreadsheet_id: currentId,
          snapshot_id: snapshotId,
        }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok || !isRecord(data)) {
        throw new Error(resolveErrorMessage(data, "快照切换失败"));
      }

      await Promise.all([
        loadProjectState(currentId),
        loadDashboard(currentId),
        loadSnapshotHistory(currentId),
        loadLiveSheetStatus(currentId),
      ]);
      setProjectActionStatus("快照已切换为当前版本");
    } catch (promoteError) {
      const message = promoteError instanceof Error ? promoteError.message : "快照切换失败";
      setError(message);
    } finally {
      setSnapshotPromotingId(null);
    }
  }

  useEffect(() => {
    if (typeof window === "undefined" || !currentId) {
      return;
    }

    const raw = window.localStorage.getItem(getReclassifyCooldownKey(currentId));
    if (!raw) {
      setReclassifyCooldownUntil(null);
      return;
    }

    const nextTimestamp = Number.parseInt(raw, 10);
    if (!Number.isFinite(nextTimestamp) || nextTimestamp <= Date.now()) {
      window.localStorage.removeItem(getReclassifyCooldownKey(currentId));
      setReclassifyCooldownUntil(null);
      return;
    }

    setReclassifyCooldownUntil(nextTimestamp);
  }, [currentId]);

  useEffect(() => {
    if (!reclassifyCooldownUntil) {
      return;
    }

    const timer = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);

    return () => window.clearInterval(timer);
  }, [reclassifyCooldownUntil]);

  useEffect(() => {
    if (!reclassifyCooldownUntil || cooldownRemainingMs > 0 || typeof window === "undefined" || !currentId) {
      return;
    }

    window.localStorage.removeItem(getReclassifyCooldownKey(currentId));
    setReclassifyCooldownUntil(null);
  }, [cooldownRemainingMs, currentId, reclassifyCooldownUntil]);

  async function refreshWorkbenchData(targetId: string) {
    await Promise.all([
      loadProjectState(targetId),
      loadDashboard(targetId),
      loadSnapshotHistory(targetId),
      loadLiveSheetStatus(targetId),
      loadExternalImportStatus(targetId),
    ]);
  }

  async function loadAuditSyncStatus(
    targetId: string,
    syncRunId?: string | null,
  ): Promise<AuditSyncRunStatusPayload | null> {
    try {
      const params = new URLSearchParams({ spreadsheet_id: targetId });
      if (syncRunId) {
        params.set("sync_run_id", syncRunId);
      }
      const res = await fetch(`/api/audit_sync_status?${params.toString()}`);
      const data = await parseResponseBody(res);
      if (!res.ok || !isRecord(data)) {
        return null;
      }
      return data as AuditSyncRunStatusPayload;
    } catch {
      return null;
    }
  }

  function applyAuditSyncStatusMessage(statusPayload: AuditSyncRunStatusPayload | null) {
    const latestRun = statusPayload?.latest_run;
    if (!latestRun) {
      return false;
    }

    if (statusPayload?.status === "stale" || latestRun.status === "stale") {
      setProjectActionStatus("同步任务可能已超时，请稍后重试或联系管理员清理运行锁。");
      return true;
    }

    if (latestRun.status === "succeeded") {
      setProjectActionStatus(
        latestRun.finished_at ? `后台同步完成：${formatTimestamp(latestRun.finished_at)}` : "后台同步完成",
      );
      return true;
    }

    if (latestRun.status === "failed") {
      setProjectActionStatus(latestRun.error_message || "后台同步失败");
      return true;
    }

    if (latestRun.status === "running" || latestRun.status === "queued") {
      setProjectActionStatus("后台同步中，正在刷新快照");
    }

    return false;
  }

  async function refreshAfterAsyncSync(targetId: string, syncRunId?: string | null) {
    const refreshDelaysMs = [3000, 7000, 12000];

    if (applyAuditSyncStatusMessage(await loadAuditSyncStatus(targetId, syncRunId))) {
      await refreshWorkbenchData(targetId);
      return;
    }

    for (const delayMs of refreshDelaysMs) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      if (latestSpreadsheetIdRef.current !== targetId) {
        return;
      }
      if (applyAuditSyncStatusMessage(await loadAuditSyncStatus(targetId, syncRunId))) {
        await refreshWorkbenchData(targetId);
        return;
      }
      await refreshWorkbenchData(targetId);
    }

    if (latestSpreadsheetIdRef.current === targetId) {
      setProjectActionStatus("后台同步已提交，稍后可再次刷新查看最新快照");
    }
  }

  async function handleSync() {
    if (!currentId || isBusy) {
      return;
    }

    const targetId = currentId;
    setSyncing(true);
    setError(null);
    setProjectActionStatus(null);

    try {
      const res = await fetch("/api/audit_sync", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheet_id: targetId }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "同步失败"));
      }

      const asyncAccepted = isRecord(data) && data.status === "accepted";
      if (asyncAccepted) {
        const syncRunId =
          typeof data.sync_run_id === "string" && data.sync_run_id.trim() ? data.sync_run_id.trim() : null;
        const message =
          typeof data.message === "string" && data.message.trim()
            ? data.message.trim()
            : "同步已开始，后台完成后会刷新快照";
        setProjectActionStatus(message);
        await refreshWorkbenchData(targetId);
        void refreshAfterAsyncSync(targetId, syncRunId);
        return;
      }

      await refreshWorkbenchData(targetId);
      setProjectActionStatus(
        data && typeof data === "object" && typeof (data as { last_synced_at?: unknown }).last_synced_at === "string"
          ? `同步完成：${formatTimestamp((data as { last_synced_at: string }).last_synced_at)}`
          : "同步完成",
      );
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : "同步失败";
      setError(message);
    } finally {
      setSyncing(false);
    }
  }

  async function refreshAfterExternalImportConfirm(targetId: string, importJobId?: string | null) {
    const immediateStatus = await loadExternalImportStatus(targetId, importJobId);
    const latestStatus = immediateStatus?.status || "";
    if (latestStatus === "succeeded" || latestStatus === "failed" || latestStatus === "partial") {
      await refreshWorkbenchData(targetId);
      return;
    }

    window.setTimeout(() => {
      if (latestSpreadsheetIdRef.current === targetId) {
        void loadExternalImportStatus(targetId, importJobId);
      }
    }, 3000);
  }

  async function handleExternalImportPreview() {
    if (!currentId || !externalImportFile || !canWriteExternalImport || externalImportPreviewing) {
      return;
    }

    const targetId = currentId;

    setExternalImportPreviewing(true);
    setExternalImportPreviewHash(null);
    setExternalImportMessage(null);
    setError(null);

    try {
      const contentBase64 = await readFileAsBase64(externalImportFile);
      const res = await fetch("/api/external_import/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          spreadsheet_id: targetId,
          files: [
            {
              file_name: externalImportFile.name,
              content_base64: contentBase64,
            },
          ],
        }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "外部数据导入预览失败"));
      }

      const preview = normalizeExternalImportStatus(data);
      setExternalImportStatus(preview);
      setExternalImportPreviewHash(preview?.preview_hash || null);
      setExternalImportMessage(preview?.confirm_allowed === false ? "预览存在阻塞问题，不能确认导入" : "预览完成，可以确认导入");
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "外部数据导入预览失败";
      setExternalImportMessage(message);
      setError(message);
    } finally {
      setExternalImportPreviewing(false);
    }
  }

  async function handleExternalImportConfirm() {
    if (!currentId || !externalImportPreviewHash || !canWriteExternalImport || externalImportConfirming) {
      return;
    }

    const targetId = currentId;
    setExternalImportConfirming(true);
    setExternalImportMessage(null);
    setError(null);

    try {
      const res = await fetch("/api/external_import/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheet_id: targetId, preview_hash: externalImportPreviewHash }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "外部数据导入提交失败"));
      }

      const importJobId =
        isRecord(data) && typeof data.import_job_id === "string"
          ? data.import_job_id
          : isRecord(data) && typeof data.job_id === "string"
            ? data.job_id
          : null;
      setExternalImportMessage("外部数据导入已提交，正在刷新状态");
      setExternalImportFile(null);
      setExternalImportPreviewHash(null);
      await refreshAfterExternalImportConfirm(targetId, importJobId);
    } catch (confirmError) {
      const message = confirmError instanceof Error ? confirmError.message : "外部数据导入提交失败";
      setExternalImportMessage(message);
      setError(message);
    } finally {
      setExternalImportConfirming(false);
    }
  }

  async function handleReclassify() {
    if (!currentId || isBusy) {
      return;
    }

    const targetId = currentId;
    if (isReclassifyCoolingDown) {
      setReclassifyStatus(formatRemainingCooldown(cooldownRemainingMs));
      return;
    }

    setReclassifying(true);
    setError(null);
    setReclassifyStatus("正在提交重分类");

    try {
      const res = await fetch("/api/reclassify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheet_id: targetId, project_id: targetId }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        if (
          res.status === 429 &&
          data &&
          typeof data === "object" &&
          typeof (data as { retry_at?: unknown }).retry_at === "string"
        ) {
          const nextRetryAt = new Date((data as { retry_at: string }).retry_at).getTime();
          if (Number.isFinite(nextRetryAt)) {
            setClockNow(Date.now());
            setReclassifyCooldownUntil(nextRetryAt);
          }
        }
        throw new Error(resolveErrorMessage(data, "成本重分类失败"));
      }
      setReclassifyStatus("正在刷新工作台");
      await Promise.all([
        loadProjectState(targetId),
        loadDashboard(targetId),
        loadSnapshotHistory(targetId),
        loadLiveSheetStatus(targetId),
      ]);
      const triggeredAt =
        data && typeof data === "object" && typeof (data as { triggered_at?: unknown }).triggered_at === "string"
          ? (data as { triggered_at: string }).triggered_at
          : new Date().toISOString();
      const nextAvailableAt = new Date(triggeredAt).getTime() + RECLASSIFY_COOLDOWN_MS;
      const serverRetryAt =
        data && typeof data === "object" && typeof (data as { retry_at?: unknown }).retry_at === "string"
          ? new Date((data as { retry_at: string }).retry_at).getTime()
          : nextAvailableAt;
      if (typeof window !== "undefined" && Number.isFinite(nextAvailableAt)) {
        window.localStorage.setItem(getReclassifyCooldownKey(targetId), String(serverRetryAt));
      }
      setClockNow(Date.now());
      setReclassifyCooldownUntil(serverRetryAt);
      setReclassifyStatus(
        data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string"
          ? (data as { message: string }).message
          : "成本重分类已完成",
      );
      setActiveTab("reclass-audit");
      setProjectActionStatus(null);
    } catch (reclassifyError) {
      const message = reclassifyError instanceof Error ? reclassifyError.message : "成本重分类失败";
      setError(message);
      setReclassifyStatus(message);
    } finally {
      setReclassifying(false);
    }
  }

  async function handleProjectAction(action: "validate_input" | "approve_109" | "unlock_data") {
    if (!currentId || isBusy) {
      return;
    }

    const targetId = currentId;
    setProjectActionPending(action);
    setProjectActionStatus(null);
    setError(null);

    try {
      const res = await fetch("/api/projects/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ spreadsheet_id: targetId, action }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "项目操作失败"));
      }

      setProjectActionStatus(
        action === "validate_input"
          ? "验证录入数据已完成"
          : action === "approve_109"
            ? "提交审计确认已记录"
            : "项目已解除锁定",
      );
      await Promise.all([
        loadProjectState(targetId),
        loadDashboard(targetId),
        loadSnapshotHistory(targetId),
        loadLiveSheetStatus(targetId),
      ]);
    } catch (projectActionError) {
      const message = projectActionError instanceof Error ? projectActionError.message : "项目操作失败";
      setError(message);
      setProjectActionStatus(message);
    } finally {
      setProjectActionPending(null);
    }
  }

  async function handleProjectInitSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!trimmedProjectName || !trimmedProjectOwner || projectSerialInvalid) {
      setError(
        !trimmedProjectName || !trimmedProjectOwner
          ? "Project Short Name and Project Owner are required"
          : PROJECT_SERIAL_ERROR_MESSAGE,
      );
      setProjectInitStatus(null);
      return;
    }

    setProjectInitSubmitting(true);
    setError(null);
    setProjectInitStatus(null);

    try {
      const res = await fetch("/api/projects/init", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectShortName: trimmedProjectName,
          projectName: trimmedProjectName,
          projectOwner: trimmedProjectOwner,
          projectSerial: trimmedProjectSerial,
        }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "创建项目失败"));
      }

      const nextSpreadsheetId =
        data && typeof data === "object" && typeof (data as { spreadsheetId?: unknown }).spreadsheetId === "string"
          ? (data as { spreadsheetId: string }).spreadsheetId.trim()
          : "";

      if (!nextSpreadsheetId) {
        throw new Error("创建项目成功，但未返回新的 spreadsheetId");
      }

      setProjectInitStatus("项目已创建，正在打开新表");
      setProjectNameInput("");
      setProjectOwnerInput("");
      setProjectSerialInput("");
      setProjectFormOpen(false);
      await loadProjectList();
      await router.replace(`/?spreadsheetId=${nextSpreadsheetId}`);
    } catch (projectInitError) {
      const message = projectInitError instanceof Error ? projectInitError.message : "创建项目失败";
      setError(message);
      setProjectInitStatus(null);
    } finally {
      setProjectInitSubmitting(false);
    }
  }

  async function handleRequestOtp() {
    setAuthLoading(true);
    setAuthMessage(null);

    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });
      const data = await parseResponseBody(res);
      if (!res.ok) {
        throw new Error(resolveErrorMessage(data, "验证码发送失败"));
      }

      setOtpRequested(true);
      setAuthMessage(`验证码已发送至 ${(data as { email?: string } | null)?.email || email}`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "验证码发送失败";
      setAuthMessage(message);
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleOtpSignIn() {
    setAuthLoading(true);
    setAuthMessage(null);

    try {
      const result = await signIn("email-otp", {
        redirect: false,
        email,
        code: otpCode,
        callbackUrl: "/",
      });

      if (!result || result.error) {
        throw new Error("验证码无效或已过期");
      }

      await router.replace(router.asPath);
    } catch (signInError) {
      const message = signInError instanceof Error ? signInError.message : "登录失败";
      setAuthMessage(message);
    } finally {
      setAuthLoading(false);
    }
  }

  useEffect(() => {
    if (!session?.user?.email) {
      setProjects([]);
      setProjectMode("empty");
      setProjectData(null);
      setProjectState(null);
      setProjectStateForId(null);
      setProjectStateLoadStatus("idle");
      setAuditLogs([]);
      setEditLogs([]);
      setLiveSheetStatus(null);
      setExternalImportStatus(null);
      return;
    }

    void loadProjectList();
  }, [session?.user?.email]);

  useEffect(() => {
    if (!session?.user?.email) {
      return;
    }

    if (projectMode === "direct" && !routeSpreadsheetId && !isLegacySpreadsheetId && directSpreadsheetId) {
      void router.replace(`/?spreadsheetId=${directSpreadsheetId}`);
    }
  }, [directSpreadsheetId, isLegacySpreadsheetId, projectMode, routeSpreadsheetId, router, session?.user?.email]);

  useEffect(() => {
    if (!session?.user?.email || !canShowProjectDetail) {
      if (!canShowProjectDetail) {
        setProjectData(null);
        setProjectState(null);
        setProjectStateForId(null);
        setProjectStateLoadStatus("idle");
        setAuditLogs([]);
        setEditLogs([]);
        setSnapshotHistory([]);
        setSnapshotDiffPreviewById({});
        setLiveSheetStatus(null);
        setExternalImportStatus(null);
      }
      return;
    }

    void Promise.all([
      loadProjectState(currentId),
      loadDashboard(currentId),
      loadSnapshotHistory(currentId),
      loadLiveSheetStatus(currentId),
      loadExternalImportStatus(currentId),
    ]);
  }, [canShowProjectDetail, currentId, session?.user?.email]);

  useEffect(() => {
    setDetailDrawerPanel(null);
    setRulesOpen(false);
    setAmountDetailState(null);
    setSnapshotDiffPreviewById({});
    setExternalImportFile(null);
    setExternalImportPreviewHash(null);
    setExternalImportMessage(null);
  }, [currentId]);

  return (
    <div className={shellClassName}>
      <Head>
        <title>审计工作台</title>
      </Head>

      <nav className="border-b border-[#D8E3DD] bg-[#FFFDF7]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <img src="/logo.svg" alt="AiWB" className="h-8 w-auto" />
            <span className="text-lg font-bold tracking-tight text-[#102A38]">审计工作台</span>
            {session && (
              <button
                type="button"
                aria-label="重分类规则"
                onClick={() => setRulesOpen(true)}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#C9D8D1] bg-[#FFFDF7] text-[#287A5C] transition hover:bg-[#EEF6F1]"
              >
                <ReclassRulesIcon />
              </button>
            )}
            {session && (
              <a
                href="/operator-guide"
                target="_blank"
                rel="noreferrer"
                aria-label="财务人员操作说明"
                title="财务人员操作说明"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#C9D8D1] bg-[#FFFDF7] text-[#287A5C] transition hover:bg-[#EEF6F1]"
              >
                <OperatorGuideIcon />
              </a>
            )}
            {session && (
              <button
                type="button"
                aria-label="添加新项目"
                onClick={() => {
                  setProjectFormOpen((current) => !current);
                  setProjectInitStatus(null);
                  setError(null);
                }}
                disabled={projectInitSubmitting}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#C9D8D1] bg-[#FFFDF7] text-lg font-semibold text-[#287A5C] transition hover:bg-[#EEF6F1] disabled:cursor-not-allowed disabled:opacity-50"
              >
                +
              </button>
            )}
          </div>

          {session && (
            <div className="flex items-center gap-4 text-sm text-[#335768]">
              {fetchTime !== null && <span>加载 {fetchTime}ms</span>}
              <span className="hidden sm:inline">{session.user?.email}</span>
              <button onClick={() => signOut()} className={secondaryButtonClassName}>
                退出
              </button>
            </div>
          )}
        </div>
      </nav>

      {session && projectFormOpen && (
        <div className="mx-auto mt-4 max-w-7xl px-6">
          <form onSubmit={handleProjectInitSubmit} className={panelClassName("p-5")}>
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_auto]">
              <div>
                <label htmlFor="project-name" className="mb-2 block text-sm font-medium text-[#335768]">
                  Project Short Name
                </label>
                <input
                  id="project-name"
                  type="text"
                  value={projectNameInput}
                  onChange={(event) => setProjectNameInput(event.target.value)}
                  placeholder="Sandy Cove"
                  className="w-full rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-3 outline-none transition focus:border-[#287A5C]"
                />
              </div>
              <div>
                <label htmlFor="project-owner" className="mb-2 block text-sm font-medium text-[#335768]">
                  Project Owner
                </label>
                <input
                  id="project-owner"
                  type="text"
                  value={projectOwnerInput}
                  onChange={(event) => setProjectOwnerInput(event.target.value)}
                  placeholder="Taylor Chen"
                  className="w-full rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-3 outline-none transition focus:border-[#287A5C]"
                />
              </div>
              <div>
                <label htmlFor="project-serial" className="mb-2 block text-sm font-medium text-[#335768]">
                  Project Serial
                </label>
                <input
                  id="project-serial"
                  type="text"
                  inputMode="numeric"
                  maxLength={3}
                  pattern="[0-9]{3}"
                  value={projectSerialInput}
                  onChange={(event) => setProjectSerialInput(event.target.value.replace(/\D/g, "").slice(0, 3))}
                  placeholder="777"
                  className="w-full rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-3 outline-none transition focus:border-[#287A5C]"
                />
                <div className="mt-2 text-xs text-[#5B7A88]">
                  {projectSerialInput && projectSerialInvalid ? PROJECT_SERIAL_ERROR_MESSAGE : "3 digits, e.g. 777"}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <button type="submit" disabled={projectInitSubmitting || projectFormInvalid} className={primaryButtonClassName}>
                  {projectInitSubmitting ? "创建中" : "创建项目"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProjectFormOpen(false);
                    setProjectInitStatus(null);
                    setError(null);
                  }}
                  disabled={projectInitSubmitting}
                  className={secondaryButtonClassName}
                >
                  取消
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {!session ? (
        <main className="mx-auto flex min-h-[calc(100vh-73px)] max-w-5xl items-center px-6 py-10">
          <div className="grid w-full gap-6 md:grid-cols-[1fr_1.1fr]">
            <section className={panelClassName("p-8")}>
              <h1 className="text-3xl font-bold tracking-tight text-[#102A38]">Start</h1>
              <div className="mt-6 space-y-3">
                <button onClick={() => signIn("google")} className={secondaryButtonClassName}>
                  <span className="inline-flex items-center gap-3">
                    <img src="https://www.google.com/favicon.ico" alt="" aria-hidden="true" className="h-5 w-5" />
                    <span>Gmail 登录</span>
                  </span>
                </button>
              </div>
            </section>

            <section className={panelClassName("p-8")}>
              <h2 className="text-base font-semibold text-[#335768]">已登记非 Gmail 邮箱</h2>
              <div className="mt-4 space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-[#335768]">邮箱</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@company.com"
                    className="w-full rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-3 outline-none transition focus:border-[#287A5C]"
                  />
                </div>

                {otpRequested && (
                  <div>
                    <label className="mb-2 block text-sm font-medium text-[#335768]">验证码</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={otpCode}
                      onChange={(event) => setOtpCode(event.target.value)}
                      placeholder="6 位验证码"
                      className="w-full rounded-2xl border border-[#C9D8D1] bg-[#FFFDF7] px-4 py-3 outline-none transition focus:border-[#287A5C]"
                    />
                  </div>
                )}

                {authMessage && (
                  <div className="rounded-2xl border border-[#D8E3DD] bg-[#F3F9F5] px-4 py-3 text-sm text-[#1F6049]">
                    {authMessage}
                  </div>
                )}

                <button
                  onClick={otpRequested ? handleOtpSignIn : handleRequestOtp}
                  disabled={authLoading || !email.trim() || (otpRequested && !otpCode.trim())}
                  className={`w-full ${primaryButtonClassName}`}
                >
                  {authLoading ? "处理中" : otpRequested ? "验证码登录" : "发送验证码"}
                </button>

                {otpRequested && (
                  <button
                    onClick={handleRequestOtp}
                    disabled={authLoading || !email.trim()}
                    className={`w-full ${secondaryButtonClassName}`}
                  >
                    重新发送
                  </button>
                )}
              </div>
            </section>
          </div>
        </main>
      ) : (
        <main className="mx-auto max-w-7xl px-6 py-6">
          {projectListLoading && (
            <div className="rounded-2xl border border-[#D8E3DD] bg-[#FFFDF7] px-4 py-3 text-sm text-[#335768]">加载项目中</div>
          )}

          {projectInitStatus && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {projectInitStatus}
            </div>
          )}

          {isProjectSummaryView && !projectListLoading && (
            <section className={panelClassName("mt-4 p-6")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h1 className="text-2xl font-bold tracking-tight">项目汇总</h1>
                <button
                  type="button"
                  onClick={() => setProjectFormOpen(true)}
                  disabled={projectInitSubmitting}
                  className={primaryButtonClassName}
                >
                  添加新项目
                </button>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {projects.map((item) => (
                  <div key={item.id || item.spreadsheet_id} className="rounded-2xl border border-[#D8E3DD] bg-[#FFFDF7] p-4">
                    <div className="text-sm text-[#5B7A88]">项目</div>
                    <div className="mt-1 text-lg font-semibold">{item.name || "未命名项目"}</div>
                    <div className="mt-2 text-sm text-[#5B7A88]">ID: {item.spreadsheet_id}</div>
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => router.replace(`/?spreadsheetId=${item.spreadsheet_id}`)}
                        className={secondaryButtonClassName}
                        aria-label={`打开项目 ${item.name || item.spreadsheet_id}`}
                      >
                        打开项目 {item.name || item.spreadsheet_id}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {isProjectEmptyView && !projectListLoading && (
            <section className={panelClassName("mt-4 p-8 text-center")}>
              <h1 className="text-2xl font-bold tracking-tight">项目汇总</h1>
              <p className="mt-3 text-sm text-[#5B7A88]">
                当前账号暂无可访问项目。请确认该邮箱已加入项目 Google Sheet 分享名单，或创建一个新项目。
              </p>
              <button
                type="button"
                onClick={() => setProjectFormOpen(true)}
                disabled={projectInitSubmitting}
                className={`mt-5 ${primaryButtonClassName}`}
              >
                添加新项目
              </button>
            </section>
          )}

          {canShowProjectDetail && (
            <>
              <section className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
                <div className={panelClassName("p-6")}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setDetailDrawerPanel("snapshot")}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#C9D8D1] bg-[#FFFDF7] text-[#335768] transition hover:bg-[#EEF6F1]"
                          aria-label="快照历史"
                          title="快照历史"
                        >
                          <SnapshotHistoryIcon />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailDrawerPanel("lock")}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#C9D8D1] bg-[#FFFDF7] text-[#335768] transition hover:bg-[#EEF6F1]"
                          aria-label="物理锁定区域"
                          title="物理锁定区域"
                        >
                          <LockAreaIcon />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDetailDrawerPanel("logs")}
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#C9D8D1] bg-[#FFFDF7] text-[#335768] transition hover:bg-[#EEF6F1]"
                          aria-label="项目日志"
                          title="项目日志"
                        >
                          <ProjectLogsIcon />
                        </button>
                      </div>
                      <h1 className="text-3xl font-bold tracking-tight">{projectDisplayName}</h1>
                    </div>
                    <button
                      type="button"
                      className="invisible h-10 w-[124px] shrink-0"
                      aria-hidden="true"
                      tabIndex={-1}
                    >
                    </button>
                  </div>

                  <div className="mt-4 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
                    <div>
                      <div className="flex flex-wrap gap-2">
                        {projectData?.from_snapshot ? (
                          <span className="rounded-full border border-[#D8E3DD] bg-[#F3F9F5] px-3 py-1 text-xs font-semibold text-[#1F6049]">
                            已由后台快照加速
                          </span>
                        ) : !currentSnapshotItem ? (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                            初始化中（尚未生成后台快照）
                          </span>
                        ) : projectData?.from_cache ? (
                          <span className="rounded-full border border-[#D8E3DD] bg-[#F3F9F5] px-3 py-1 text-xs font-semibold text-[#1F6049]">
                            缓存
                          </span>
                        ) : null}
                        {activeProjectState?.locked && (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                            数据已锁定
                          </span>
                        )}
                      </div>

                      {dirtyWarning && (
                        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                          <div>{dirtyWarningText}</div>
                          {rollbackHint && <div className="mt-1">{rollbackHint}</div>}
                        </div>
                      )}

                      {snapshotIsStale && (
                        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                          <div className="font-semibold">快照过期</div>
                          <div className="mt-1">
                            源文件更新时间：{formatTimestamp(projectData?.source_last_edit_at)} · 快照时间：
                            {formatTimestamp(projectData?.snapshot_at)}
                          </div>
                        </div>
                      )}

                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-3">
                          <div className="text-xs text-[#5B7A88]">阶段</div>
                          <div className="mt-1 text-sm font-semibold text-[#102A38]">{stageLabel}</div>
                        </div>
                        <div className="rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-3">
                          <div className="text-xs text-[#5B7A88]">阶段状态</div>
                          <div className="mt-1 text-sm font-semibold text-[#102A38]">{nextAction}</div>
                        </div>
                        <div className="rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-3">
                          <div className="text-xs text-[#5B7A88]">同步时间</div>
                          <div className="mt-1 text-sm font-semibold text-[#102A38]">
                            {formatTimestamp(activeProjectState?.last_sync_at || projectData?.last_synced_at)}
                          </div>
                        </div>
                        {projectData?.from_snapshot && (
                          <div className="rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-3">
                            <div className="text-xs text-[#5B7A88]">快照时间</div>
                            <div className="mt-1 text-sm font-semibold text-[#102A38]">
                              {formatTimestamp(projectData.snapshot_at)}
                            </div>
                          </div>
                        )}
                        {projectData?.from_snapshot && (
                          <div className="rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-3">
                            <div className="text-xs text-[#5B7A88]">源文件更新时间</div>
                            <div className="mt-1 text-sm font-semibold text-[#102A38]">
                              {formatTimestamp(projectData.source_last_edit_at)}
                            </div>
                          </div>
                        )}
                        <div className="rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-3">
                          <div className="text-xs text-[#5B7A88]">项目 ID</div>
                          <div className="mt-1 break-all text-sm font-semibold text-[#102A38]">{currentId}</div>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-2">
                      {summaryHighlightRows.map((item) => (
                        <div
                          key={item.label}
                          className="flex min-h-[56px] items-center justify-between gap-4 rounded-2xl border border-[#E2EBE6] bg-[#F8FBF9] px-4 py-2.5"
                        >
                          <div className="shrink-0 text-sm text-[#5B7A88]">{item.label}</div>
                          <div className="truncate text-base font-bold leading-tight text-[#102A38] lg:text-lg">
                            {item.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className={panelClassName("p-6")}>
                  <div className="grid gap-3">
                    <a
                      href={sheetUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={`block text-center ${primaryButtonClassName}`}
                    >
                      当前项目 Google Sheet
                    </a>
                    {visibleActions.includes("sync_data") && (
                      <button onClick={handleSync} disabled={isBusy} className={secondaryButtonClassName}>
                        {syncing ? "同步中" : "同步数据"}
                      </button>
                    )}
                    {(projectStateLoadStatus === "loading" || projectStateLoadStatus === "error") && (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                        {projectStateLoadStatus === "loading"
                          ? "项目状态加载中，写操作已禁用"
                          : "项目状态加载失败，写操作已禁用"}
                      </div>
                    )}
                    <div className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h2 className="text-sm font-semibold text-[#102A38]">外部数据导入</h2>
                        <span className="text-xs text-[#5B7A88]">
                          {externalImportStatusLoading
                            ? "状态读取中"
                            : externalImportStatus?.status || externalImportStatus?.updated_at
                              ? [externalImportStatus.status, formatTimestamp(externalImportStatus.updated_at)]
                                  .filter(Boolean)
                                  .join(" · ")
                              : "暂无导入任务"}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-1 text-xs leading-5 text-[#335768]">
                        <div>只会替换本次识别到的外部表。未上传的表保留当前版本。</div>
                        <div>导入成功后会自动验证录入数据。</div>
                        {!canWriteExternalImport && <div>Reader/Commenter 只能查看导入状态，不能上传。</div>}
                      </div>

                      {canWriteExternalImport && (
                        <div className="mt-3 grid gap-2">
                          <label
                            htmlFor="external-import-file"
                            className="block text-xs font-semibold text-[#335768]"
                          >
                            选择外部导入文件
                          </label>
                          <input
                            id="external-import-file"
                            type="file"
                            accept=".xlsx,.xls,.csv"
                            aria-label="选择外部导入文件"
                            onChange={(event) => {
                              setExternalImportFile(event.target.files?.[0] || null);
                              setExternalImportPreviewHash(null);
                            }}
                            className="block w-full text-xs text-[#335768] file:mr-3 file:rounded-xl file:border file:border-[#C9D8D1] file:bg-[#FFFDF7] file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#102A38]"
                          />
                          {externalImportFile && (
                            <div className="break-all text-xs font-medium text-[#1F6049]">
                              已选择 {externalImportFile.name}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={handleExternalImportPreview}
                            disabled={!externalImportFile || externalImportPreviewing}
                            className={secondaryButtonClassName}
                          >
                            {externalImportPreviewing ? "预览中" : "预览导入"}
                          </button>
                          <button
                            type="button"
                            onClick={handleExternalImportConfirm}
                            disabled={!externalImportPreviewHash || externalImportStatus?.confirm_allowed === false || externalImportConfirming}
                            className={secondaryButtonClassName}
                          >
                            {externalImportConfirming ? "提交中" : "确认导入"}
                          </button>
                        </div>
                      )}

                      {externalImportMessage && (
                        <div className="mt-3 rounded-xl border border-[#D8E3DD] bg-[#FFFDF7] px-3 py-2 text-xs text-[#335768]">
                          {externalImportMessage}
                        </div>
                      )}

                      {(externalImportStatus?.tables.length || 0) > 0 ? (
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-[720px] w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-[#D8E3DD] text-[#5B7A88]">
                                <th className="pb-2 pr-3 font-medium">detected table</th>
                                <th className="pb-2 pr-3 font-medium">file name</th>
                                <th className="pb-2 pr-3 font-medium">source sheet</th>
                                <th className="pb-2 pr-3 text-right font-medium">row count</th>
                                <th className="pb-2 pr-3 text-right font-medium">amount total</th>
                                <th className="pb-2 pr-3 font-medium">semantic target zone</th>
                                <th className="pb-2 pr-3 font-medium">status</th>
                                <th className="pb-2 font-medium">warnings/blocking</th>
                              </tr>
                            </thead>
                            <tbody>
                              {externalImportStatus?.tables.map((table, index) => (
                                <tr
                                  key={`${table.detected_table}-${table.file_name}-${index}`}
                                  className="border-b border-[#E2EBE6] align-top"
                                >
                                  <td className="py-2 pr-3 font-semibold text-[#102A38]">{table.detected_table || "-"}</td>
                                  <td className="py-2 pr-3 break-all text-[#335768]">{table.file_name || "-"}</td>
                                  <td className="py-2 pr-3 text-[#335768]">{table.source_sheet || "-"}</td>
                                  <td className="py-2 pr-3 text-right text-[#335768]">{formatNumber(table.row_count)}</td>
                                  <td className="py-2 pr-3 text-right text-[#335768]">
                                    {formatCurrency(table.amount_total, { showZero: true })}
                                  </td>
                                  <td className="py-2 pr-3 break-all text-[#335768]">{table.semantic_target_zone || "-"}</td>
                                  <td className="py-2 pr-3 font-semibold text-[#335768]">{table.status || "-"}</td>
                                  <td className="py-2 text-[#335768]">
                                    {[...table.warnings, ...table.blocking].length > 0
                                      ? [...table.warnings, ...table.blocking].map((message) => (
                                          <div key={message} className="break-words">
                                            {message}
                                          </div>
                                        ))
                                      : "-"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="mt-3 rounded-xl border border-[#E2EBE6] bg-[#FFFDF7] px-3 py-2 text-xs text-[#5B7A88]">
                          暂无外部导入 manifest
                        </div>
                      )}
                    </div>
                    {visibleActions.includes("validate_input") && (
                      <button
                        onClick={() => handleProjectAction("validate_input")}
                        disabled={isBusy}
                        className={secondaryButtonClassName}
                      >
                        {projectActionPending === "validate_input" ? "验证中" : "验证录入数据"}
                      </button>
                    )}
                    {visibleActions.includes("reclassify") && (
                      <button onClick={handleReclassify} disabled={reclassifyBlocked} className={secondaryButtonClassName}>
                        成本重分类
                      </button>
                    )}
                    {visibleActions.includes("approve_109") && (
                      <button
                        onClick={() => handleProjectAction("approve_109")}
                        disabled={isBusy}
                        className={secondaryButtonClassName}
                      >
                        {projectActionPending === "approve_109" ? "提交中" : "提交审计确认"}
                      </button>
                    )}
                    {showUnlockAction && (
                      <button
                        onClick={() => handleProjectAction("unlock_data")}
                        disabled={isBusy}
                        className={secondaryButtonClassName}
                      >
                        {projectActionPending === "unlock_data" ? "解除中" : "解除锁定数据"}
                      </button>
                    )}
                    {reclassifyStatusText && (
                      <div className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-3 text-sm text-[#335768]">
                        {reclassifyStatusText}
                      </div>
                    )}
                    {projectActionStatus && (
                      <div className="rounded-2xl border border-[#D8E3DD] bg-[#F3F9F5] px-4 py-3 text-sm text-[#1F6049]">
                        {projectActionStatus}
                      </div>
                    )}
                    {projects.length > 1 && (
                      <button
                        type="button"
                        onClick={() => router.replace("/")}
                        className="text-sm font-semibold text-[#335768] underline underline-offset-4 transition hover:text-[#102A38]"
                      >
                        返回项目汇总
                      </button>
                    )}
                  </div>
                </div>
              </section>

              {error && (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                  {error}
                </div>
              )}

              <section className="mt-6 flex flex-wrap gap-2">
            {tabs.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                aria-label={`标签页-${TAB_LABELS[tab]}`}
                className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                  activeTab === tab
                    ? "bg-[#287A5C] text-white"
                    : "border border-[#C9D8D1] bg-[#FFFDF7] text-[#335768] hover:bg-[#EEF6F1]"
                }`}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </section>

          <section className="mt-6 min-h-[420px]">
            {activeTab === "overview" && (
              <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
                <div className={panelClassName("p-6")}>
                  <h2 className="text-lg font-semibold">概览</h2>
                  <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <button
                      type="button"
                      onClick={() => setActiveTab("external-recon")}
                      className="rounded-2xl bg-slate-50 p-4 text-left transition hover:bg-slate-100"
                    >
                      <div className="text-sm text-slate-500">外部数据核对</div>
                      <div className="mt-2 text-2xl font-bold">{formatNumber(discrepancyCount + unitVarianceCount)}</div>
                      <div className="mt-2 text-sm text-slate-600">{externalRecon?.summary || "暂无数据"}</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("manual-input")}
                      className="rounded-2xl bg-slate-50 p-4 text-left transition hover:bg-slate-100"
                    >
                      <div className="text-sm text-slate-500">手工录入核对</div>
                      <div className="mt-2 text-2xl font-bold">{formatNumber(manualValidationCount)}</div>
                      <div className="mt-2 text-sm text-slate-600">
                        {manualEntryCount > 0 ? `${formatNumber(manualEntryCount)} 条利润表录入` : "暂无数据"}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("reclass-audit")}
                      className="rounded-2xl bg-slate-50 p-4 text-left transition hover:bg-slate-100"
                    >
                      <div className="text-sm text-slate-500">成本重分类</div>
                      <div className="mt-2 text-2xl font-bold">{formatNumber(totalReclassChangedCount)}</div>
                      <div className="mt-2 text-sm text-slate-600">重分类变更</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("compare-109")}
                      className="rounded-2xl bg-slate-50 p-4 text-left transition hover:bg-slate-100"
                    >
                      <div className="text-sm text-slate-500">项目利润表对比</div>
                      <div className="mt-2 text-2xl font-bold">{formatCurrency(compareDiffTotal)}</div>
                      <div className="mt-2 text-sm text-slate-600">总差异</div>
                    </button>
                  </div>
                </div>

                <div className={panelClassName("p-6")}>
                  <h2 className="text-lg font-semibold">当前状态</h2>
                  <div className="mt-4 grid gap-3">
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">外部数据核对</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">{externalRecon?.summary || "暂无数据"}</div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">数据刷新</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">
                        {syncing ? "刷新中" : "同步会先检查工作表结构，再校验并刷新审计快照。"}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">手工录入核对</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">
                        {manualValidationCount > 0
                          ? `${formatNumber(manualValidationCount)} 条校验异常`
                          : manualEntryCount > 0
                            ? `${formatNumber(manualEntryCount)} 条利润表录入`
                            : "暂无数据"}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">成本重分类</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">{nextAction}</div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">项目利润表对比</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">
                        {compareYearCount > 0 ? `${formatNumber(compareYearCount)} 个年份` : "暂无数据"}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-slate-50 p-4">
                      <div className="text-sm text-slate-500">锁定状态</div>
                      <div className="mt-2 text-sm font-medium text-slate-700">
                        {activeProjectState ? (activeProjectState.locked ? "已锁定" : "未锁定") : "未知"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "external-recon" && (
              <div className="grid gap-6">
                <div className={panelClassName("p-6")}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-lg font-semibold">外部数据核对</h2>
                    <span className="text-sm text-slate-500">{externalRecon?.summary || "暂无数据"}</span>
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
                  <div className={panelClassName("p-6")}>
                    <h3 className="text-base font-semibold">Unit/Common 个数</h3>
                    {externalUnitCommonCounts.length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500">
                              <th className="pb-3 font-medium">来源表</th>
                              <th className="pb-3 text-right font-medium">Unit 个数</th>
                              <th className="pb-3 text-right font-medium">Common 个数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {externalUnitCommonCounts.map((row) => (
                              <tr key={row.table_name} className="border-b border-slate-100">
                                <td className="py-3 font-medium">{row.table_name}</td>
                                <td className="py-3 text-right text-slate-600">{formatNumber(row.unit_count)}</td>
                                <td className="py-3 text-right text-slate-600">{formatNumber(row.common_count)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                    )}
                  </div>

                  <div className={panelClassName("p-6")}>
                    <h3 className="text-base font-semibold">Payable 内部公司矩阵</h3>
                    {externalInternalCompanyNames.length > 0 && externalInternalCompanyStates.length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-[760px] w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500">
                              <th className="pb-3 font-medium">公司</th>
                              {externalInternalCompanyStates.map((state) => (
                                <th key={state} className="pb-3 text-right font-medium">
                                  {state}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {externalInternalCompanyNames.map((companyName) => (
                              <tr key={companyName} className="border-b border-slate-100">
                                <td className="py-3 font-medium">{companyName}</td>
                                {externalInternalCompanyStates.map((state) => {
                                  const amount = externalInternalCompanyMatrix.get(`${companyName}::${state}`) || 0;
                                  const detailRows = getExternalInternalCompanyAmountRows(companyName, state);

                                  return (
                                    <td key={`${companyName}-${state}`} className="py-3 text-right">
                                      {detailRows.length > 0 ? (
                                        <button
                                          type="button"
                                          aria-label={`查看内部公司 ${companyName} ${state} 金额明细`}
                                          onClick={() => openExternalInternalCompanyAmountDetail(companyName, state)}
                                          className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                        >
                                          {formatCurrency(amount)}
                                        </button>
                                      ) : (
                                        <span className="text-slate-600">{formatCurrency(amount)}</span>
                                      )}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                    )}
                  </div>
                </div>

                <div className={panelClassName("p-6")}>
                  <h3 className="text-base font-semibold">Cost State 金额矩阵</h3>
                  {(externalRecon?.cost_state_matrix || []).length > 0 ? (
                    <div className="mt-4 overflow-x-auto">
                      <table className="min-w-[760px] w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500">
                            <th className="pb-3 font-medium">Cost State</th>
                            <th className="pb-3 text-right font-medium">Payable</th>
                            <th className="pb-3 text-right font-medium">Final Detail</th>
                            <th className="pb-3 text-right font-medium">Draw Request report</th>
                            <th className="pb-3 text-right font-medium">差异条数</th>
                          </tr>
                        </thead>
                        <tbody>
                          {externalRecon?.cost_state_matrix?.map((row) => {
                            const payableRows = getExternalReconAmountRows("Payable", row.cost_state);
                            const finalDetailRows = getExternalReconAmountRows("Final Detail", row.cost_state);
                            const drawRequestRows = getExternalReconAmountRows("Draw Request report", row.cost_state);

                            return (
                              <tr key={row.cost_state} className="border-b border-slate-100">
                                <td className="py-3 font-medium">{row.cost_state}</td>
                                <td className="py-3 text-right">
                                  {payableRows.length > 0 ? (
                                    <button
                                      type="button"
                                      aria-label={`查看 ${row.cost_state} Payable 金额明细`}
                                      onClick={() => openExternalReconAmountDetail("Payable", row.cost_state)}
                                      className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                    >
                                      {formatCurrency(row.payable_amount)}
                                    </button>
                                  ) : (
                                    <span className="text-slate-600">{formatCurrency(row.payable_amount)}</span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  {finalDetailRows.length > 0 ? (
                                    <button
                                      type="button"
                                      aria-label={`查看 ${row.cost_state} Final Detail 金额明细`}
                                      onClick={() => openExternalReconAmountDetail("Final Detail", row.cost_state)}
                                      className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                    >
                                      {formatCurrency(row.final_detail_amount)}
                                    </button>
                                  ) : (
                                    <span className="text-slate-600">{formatCurrency(row.final_detail_amount)}</span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  {drawRequestRows.length > 0 ? (
                                    <button
                                      type="button"
                                      aria-label={`查看 ${row.cost_state} Draw Request report 金额明细`}
                                      onClick={() => openExternalReconAmountDetail("Draw Request report", row.cost_state)}
                                      className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                    >
                                      {formatCurrency(row.draw_request_amount)}
                                    </button>
                                  ) : (
                                    <span className="text-slate-600">{formatCurrency(row.draw_request_amount)}</span>
                                  )}
                                </td>
                                <td className="py-3 text-right">
                                  {row.draw_request_diff_count > 0 ? (
                                    <button
                                      type="button"
                                      aria-label={`查看 ${row.cost_state} 差异条数明细`}
                                      onClick={() => openExternalReconDiffDetail(row.cost_state)}
                                      className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                    >
                                      {row.draw_request_diff_count}
                                    </button>
                                  ) : (
                                    <span className="text-slate-600">{row.draw_request_diff_count || 0}</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          <tr className="border-b border-slate-200 bg-slate-50">
                            <td className="py-3 font-semibold">Cost State 汇总合计</td>
                            <td className="py-3 text-right font-semibold">
                              {formatCurrency(
                                externalRecon?.cost_state_totals?.payable.grouped_total ??
                                  getCostStateMatrixTotal("payable_amount"),
                                { showZero: true },
                              )}
                            </td>
                            <td className="py-3 text-right font-semibold">
                              {formatCurrency(
                                externalRecon?.cost_state_totals?.final_detail.grouped_total ??
                                  getCostStateMatrixTotal("final_detail_amount"),
                                { showZero: true },
                              )}
                            </td>
                            <td className="py-3 text-right font-semibold">
                              {formatCurrency(
                                externalRecon?.cost_state_totals?.draw_request.grouped_total ??
                                  getCostStateMatrixTotal("draw_request_amount"),
                                { showZero: true },
                              )}
                            </td>
                            <td className="py-3 text-right font-semibold">
                              {formatNumber(getCostStateDiffCountTotal())}
                            </td>
                          </tr>
                          <tr className="bg-slate-50/80">
                            <td className="py-3 font-semibold">原始 Amount 合计</td>
                            <td
                              className={`py-3 text-right font-semibold ${
                                (externalRecon?.cost_state_totals?.payable.mismatch ??
                                  (Math.abs(
                                    getExternalReconTotalAmount("Payable") - getCostStateMatrixTotal("payable_amount"),
                                  ) > 0.01))
                                  ? "text-red-600"
                                  : ""
                              }`}
                            >
                              {formatCurrency(
                                externalRecon?.cost_state_totals?.payable.raw_total ??
                                  getExternalReconTotalAmount("Payable"),
                                { showZero: true },
                              )}
                            </td>
                            <td
                              className={`py-3 text-right font-semibold ${
                                (externalRecon?.cost_state_totals?.final_detail.mismatch ??
                                  (Math.abs(
                                    getExternalReconTotalAmount("Final Detail") -
                                      getCostStateMatrixTotal("final_detail_amount"),
                                  ) > 0.01))
                                  ? "text-red-600"
                                  : ""
                              }`}
                            >
                              {formatCurrency(
                                externalRecon?.cost_state_totals?.final_detail.raw_total ??
                                  getExternalReconTotalAmount("Final Detail"),
                                { showZero: true },
                              )}
                            </td>
                            <td
                              className={`py-3 text-right font-semibold ${
                                (externalRecon?.cost_state_totals?.draw_request.mismatch ??
                                  (Math.abs(
                                    getExternalReconTotalAmount("Draw Request report") -
                                      getCostStateMatrixTotal("draw_request_amount"),
                                  ) > 0.01))
                                  ? "text-red-600"
                                  : ""
                              }`}
                            >
                              {formatCurrency(
                                externalRecon?.cost_state_totals?.draw_request.raw_total ??
                                  getExternalReconTotalAmount("Draw Request report"),
                                { showZero: true },
                              )}
                            </td>
                            <td className="py-3 text-right font-semibold">-</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "manual-input" && (
              <div className="grid gap-6">
                <div className="grid gap-6">
                  <div className={panelClassName("p-6")}>
                    <h2 className="text-lg font-semibold">项目利润表录入金额</h2>
                    {manualProfitYearView.yearRows.length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-[760px] w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500">
                              <th className="pb-3 font-medium">年份</th>
                              {manualProfitYearView.fieldNames.map((fieldName) => (
                                <th key={fieldName} className="pb-3 text-right font-medium">{fieldName}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {manualProfitYearView.yearRows.map((row) => (
                              <tr key={row.year} className="border-b border-slate-100">
                                <td className="py-3 font-medium">{row.year}</td>
                                {manualProfitYearView.fieldNames.map((fieldName) => (
                                  <td key={`${row.year}-${fieldName}`} className="py-3 text-right font-semibold">
                                    {formatCurrency(row.values[fieldName])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                    )}
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-2">
                  <div className={panelClassName("p-6")}>
                    <h2 className="text-lg font-semibold">Scoping</h2>
                    {(manualInput?.scoping_groups || []).length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-[760px] w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500">
                              <th className="pb-3 font-medium">Group</th>
                              <th className="pb-3 font-medium">Group Name</th>
                              <th className="pb-3 font-medium">Scoping</th>
                              <th className="pb-3 font-medium">保修月数</th>
                              <th className="pb-3 font-medium">保修到期日</th>
                            </tr>
                          </thead>
                          <tbody>
                            {manualInput?.scoping_groups?.map((row) => (
                              <tr key={row.group} className="border-b border-slate-100">
                                <td className="py-3 font-medium">{row.group}</td>
                                <td className="py-3 text-slate-600">{row.group_name || "-"}</td>
                                <td className="py-3 text-slate-600">{row.scope_values || "-"}</td>
                                <td className="py-3 text-slate-600">{row.warranty_months || "-"}</td>
                                <td className="py-3 text-slate-600">{row.warranty_due_date || "-"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                    )}
                  </div>

                  <div className={panelClassName("p-6")}>
                    <h2 className="text-lg font-semibold">Unit Master 日期链</h2>
                    {(manualInput?.unit_master_dates || []).length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500">
                              <th className="pb-3 font-medium">Unit Code</th>
                              <th className="pb-3 font-medium">C/O date</th>
                              <th className="pb-3 font-medium">TBD Acceptance Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {manualInput?.unit_master_dates?.map((row) => (
                              <tr key={row.unit_code} className="border-b border-slate-100">
                                <td className="py-3 font-medium">{row.unit_code}</td>
                                <td className="py-3 text-slate-600">{row.co_date || "-"}</td>
                                <td
                                  className={`py-3 ${
                                    row.tbd_acceptance_date_invalid ? "text-red-600" : "text-slate-600"
                                  }`}
                                >
                                  {row.tbd_acceptance_date || "-"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === "reclass-audit" && (
              <div className="grid gap-6">
                <div className="grid gap-4 md:grid-cols-4">
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">Payable 变更金额</div>
                    <div className="mt-2 text-2xl font-bold">{formatCurrency(reclassTableSummaries[0]?.changed_amount)}</div>
                  </div>
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">Payable 变更数量</div>
                    <div className="mt-2 text-2xl font-bold">{formatNumber(reclassTableSummaries[0]?.changed_count)}</div>
                  </div>
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">Final Detail 变更金额</div>
                    <div className="mt-2 text-2xl font-bold">{formatCurrency(reclassTableSummaries[1]?.changed_amount)}</div>
                  </div>
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">Final Detail 变更数量</div>
                    <div className="mt-2 text-2xl font-bold">{formatNumber(reclassTableSummaries[1]?.changed_count)}</div>
                  </div>
                </div>

                {reclassTableSummaries.map((summary) => (
                  <div key={summary.source_table} className={panelClassName("p-6")}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-lg font-semibold">{summary.source_table} 表内重分类对比</h2>
                      <div className="text-sm text-slate-500">
                        {`总计 ${formatNumber(summary.total_count)} 条 / 变更 ${formatNumber(summary.changed_count)} 条`}
                      </div>
                    </div>

                    {summary.transition_rows.length > 0 ? (
                      <div className="mt-4 overflow-x-auto">
                        <table className="min-w-[760px] w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500">
                              <th className="pb-3 font-medium">重分类前后</th>
                              <th className="pb-3 text-right font-medium">金额</th>
                              <th className="pb-3 text-right font-medium">数量</th>
                            </tr>
                          </thead>
                          <tbody>
                            {summary.transition_rows.map((row) => {
                              const label = `${row.old_cost_state} → ${row.new_cost_state}`;

                              return (
                                <tr
                                  key={`${summary.source_table}-${row.old_cost_state}-${row.new_cost_state}`}
                                  className="border-b border-slate-100"
                                >
                                  <td className="py-3 font-medium">{label}</td>
                                  <td className="py-3 text-right">
                                    <button
                                      type="button"
                                      aria-label={`查看 ${summary.source_table} ${row.old_cost_state} 到 ${row.new_cost_state} 金额明细`}
                                      onClick={() =>
                                        openReclassTransitionAmountDetail(
                                          summary.source_table,
                                          row.old_cost_state,
                                          row.new_cost_state,
                                          row.amount,
                                          row.count,
                                        )
                                      }
                                      className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                    >
                                      {formatCurrency(row.amount)}
                                    </button>
                                  </td>
                                  <td className="py-3 text-right text-slate-600">{formatNumber(row.count)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-500">暂无数据</div>
                    )}

                    <div className="mt-6 grid gap-6 xl:grid-cols-2">
                      <div>
                        <h3 className="text-base font-semibold">重分类前 Cost State</h3>
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead>
                              <tr className="border-b border-slate-200 text-slate-500">
                                <th className="pb-3 font-medium">Cost State</th>
                                <th className="pb-3 text-right font-medium">金额</th>
                                <th className="pb-3 text-right font-medium">数量</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summary.before_rows.map((row) => (
                                <tr key={`${summary.source_table}-before-${row.cost_state}`} className="border-b border-slate-100">
                                  <td className="py-3 font-medium">{row.cost_state}</td>
                                  <td className="py-3 text-right text-slate-600">{formatCurrency(row.amount)}</td>
                                  <td className="py-3 text-right text-slate-600">{formatNumber(row.count)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <h3 className="text-base font-semibold">重分类后 Cost State</h3>
                        <div className="mt-3 overflow-x-auto">
                          <table className="w-full text-left text-sm">
                            <thead>
                              <tr className="border-b border-slate-200 text-slate-500">
                                <th className="pb-3 font-medium">Cost State</th>
                                <th className="pb-3 text-right font-medium">金额</th>
                                <th className="pb-3 text-right font-medium">数量</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summary.after_rows.map((row) => (
                                <tr key={`${summary.source_table}-after-${row.cost_state}`} className="border-b border-slate-100">
                                  <td className="py-3 font-medium">{row.cost_state}</td>
                                  <td className="py-3 text-right text-slate-600">{formatCurrency(row.amount)}</td>
                                  <td className="py-3 text-right text-slate-600">{formatNumber(row.count)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>

                    {summary.internal_company_transition_rows.length > 0 && (
                      <div className="mt-6">
                        <h3 className="text-base font-semibold">内部公司重分类对比</h3>
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-[760px] w-full text-left text-sm">
                            <thead>
                              <tr className="border-b border-slate-200 text-slate-500">
                                <th className="pb-3 font-medium">公司</th>
                                <th className="pb-3 font-medium">重分类前后</th>
                                <th className="pb-3 text-right font-medium">金额</th>
                                <th className="pb-3 text-right font-medium">数量</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summary.internal_company_transition_rows.map((row) => {
                                return (
                                  <tr
                                    key={`${summary.source_table}-${row.company_name}-${row.old_cost_state}-${row.new_cost_state}`}
                                    className="border-b border-slate-100"
                                  >
                                    <td className="py-3 font-medium">{row.company_name}</td>
                                    <td className="py-3 text-slate-600">{`${row.old_cost_state} → ${row.new_cost_state}`}</td>
                                    <td className="py-3 text-right">
                                      <button
                                        type="button"
                                        aria-label={`查看内部公司 ${row.company_name} ${summary.source_table} ${row.old_cost_state} 到 ${row.new_cost_state} 金额明细`}
                                        onClick={() =>
                                          openReclassInternalCompanyAmountDetail(
                                            row.company_name,
                                            summary.source_table,
                                            row.old_cost_state,
                                            row.new_cost_state,
                                            row.amount,
                                            row.count,
                                          )
                                        }
                                        className="font-semibold text-[#287A5C] transition hover:text-[#1F6049]"
                                      >
                                        {formatCurrency(row.amount)}
                                      </button>
                                    </td>
                                    <td className="py-3 text-right text-slate-600">{formatNumber(row.count)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {activeTab === "compare-109" && (
              <div className="grid gap-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">指标数</div>
                    <div className="mt-2 text-2xl font-bold">{formatNumber(compare109?.metric_rows?.length)}</div>
                  </div>
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">总差异</div>
                    <div className="mt-2 text-2xl font-bold text-red-600">{formatCurrency(compareDiffTotal)}</div>
                  </div>
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">Mapping Score</div>
                    <div className="mt-2 text-2xl font-bold text-emerald-700">
                      {`${((compare109?.mapping_health?.mapping_score || 0) * 100).toFixed(1)}%`}
                    </div>
                  </div>
                  <div className={panelClassName("p-5")}>
                    <div className="text-sm text-slate-500">Fallback Count</div>
                    <div className="mt-2 text-2xl font-bold text-amber-700">
                      {formatNumber(compare109?.mapping_health?.fallback_count || 0)}
                    </div>
                  </div>
                </div>

                {(compare109?.warnings || []).length > 0 && (
                  <div className={panelClassName("border-amber-300 bg-amber-50/70 p-4")}>
                    <div className="text-sm font-semibold text-amber-900">MAPPING_AMBIGUITY</div>
                    <div className="mt-2 grid gap-1 text-sm text-amber-900">
                      {(compare109?.warnings || []).map((warning, index) => (
                        <div key={`${warning.code}-${index}`}>
                          [{warning.code}] {warning.message}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {compareYearRows.length > 0 ? (
                  <div className={panelClassName("p-6")}>
                    <h2 className="text-lg font-semibold">项目利润表年度对比</h2>
                    <div className="mt-4 overflow-x-auto">
                      <table className="min-w-[1080px] w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500">
                            <th className="pb-3 font-medium">年份</th>
                            {compareMetrics.map((metric) => (
                              <Fragment key={metric}>
                                <th className="pb-3 text-right font-medium">{metric} 公司</th>
                                <th className="pb-3 text-right font-medium">{metric} 审计</th>
                                <th className="pb-3 text-right font-medium">{metric} 差异</th>
                              </Fragment>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {compareYearRows.map((yearRow) => (
                            <tr key={`${yearRow.year_label}-${yearRow.year_offset}`} className="border-b border-slate-100">
                              <td className="py-3 font-medium">{yearRow.year_label}</td>
                              {compareMetrics.map((metric) => {
                                const values = yearRow.metrics[metric] || {
                                  company: 0,
                                  audit: 0,
                                  diff: 0,
                                  has_value: false,
                                };
                                return (
                                  <Fragment key={`${yearRow.year_label}-${metric}`}>
                                    <td className="py-3 text-right text-slate-600">
                                      {values.has_value ? formatCurrency(values.company) : ""}
                                    </td>
                                    <td className="py-3 text-right text-slate-600">
                                      {values.has_value ? formatCurrency(values.audit) : ""}
                                    </td>
                                    <td className="py-3 text-right font-semibold text-red-600">
                                      {values.has_value ? formatCurrency(values.diff, { showZero: true }) : ""}
                                    </td>
                                  </Fragment>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className={panelClassName("px-4 py-6 text-sm text-slate-500")}>暂无数据</div>
                )}
              </div>
            )}
              </section>
            </>
          )}
        </main>
      )}

      {detailDrawerPanel && canShowProjectDetail && (
        <div className="fixed inset-0 z-40 flex">
          <button
            type="button"
            aria-label="关闭详情"
            className="h-full flex-1 bg-slate-900/35"
            onClick={() => setDetailDrawerPanel(null)}
          />
          <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-[#D8E3DD] bg-[#FFFDF7] p-5 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[#102A38]">
                {detailDrawerPanel === "snapshot"
                  ? "快照历史详情"
                  : detailDrawerPanel === "lock"
                    ? "物理锁定区域详情"
                    : "项目日志"}
              </h2>
              <button type="button" className={secondaryButtonClassName} onClick={() => setDetailDrawerPanel(null)}>
                关闭
              </button>
            </div>

            {detailDrawerPanel === "snapshot" && (
              <section className="mt-5">
                <div className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-[#102A38]">快照历史</div>
                    {currentSnapshotItem && (
                      <div className="text-xs text-[#5B7A88]">当前：{formatTimestamp(currentSnapshotItem.created_at)}</div>
                    )}
                  </div>
                  {snapshotHistoryLoading ? (
                    <div className="mt-2 text-xs text-[#5B7A88]">快照加载中</div>
                  ) : snapshotHistory.length === 0 ? (
                    <div className="mt-2 text-xs text-[#5B7A88]">暂无快照</div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {snapshotHistory.map((item) => {
                        const preview = snapshotDiffPreviewById[item.snapshot_id];
                        const canPromote = !item.is_current && item.sync_run_status === "succeeded";
                        return (
                          <div key={item.snapshot_id} className="rounded-xl border border-[#D8E3DD] bg-[#FFFDF7] px-3 py-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="text-xs font-semibold text-[#102A38]">{formatTimestamp(item.created_at)}</div>
                                <div className="mt-1 text-[11px] text-[#5B7A88]">
                                  {`状态: ${item.sync_run_status} · 决策 ${formatNumber(item.decision_count)} · 公式 ${formatNumber(item.formula_template_count)}`}
                                </div>
                              </div>
                              {item.is_current && (
                                <span className="rounded-full border border-[#D8E3DD] bg-[#F3F9F5] px-2 py-0.5 text-[11px] font-semibold text-[#1F6049]">
                                  当前
                                </span>
                              )}
                            </div>
                            {preview && (
                              <div className="mt-1 text-[11px] text-[#335768]">
                                {`差异: ${formatNumber(preview.decision_change_count)}（Payable ${formatNumber(preview.table_change_counts.payable)} / Final ${formatNumber(preview.table_change_counts.final_detail)}）`}
                              </div>
                            )}
                            {canPromote && (
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => handlePreviewSnapshotDiff(item.snapshot_id)}
                                  className="rounded-xl border border-[#C9D8D1] bg-[#FFFDF7] px-2 py-1 text-xs font-semibold text-[#335768] transition hover:bg-[#EEF6F1]"
                                >
                                  预览差异
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handlePromoteSnapshot(item.snapshot_id)}
                                  disabled={Boolean(snapshotPromotingId)}
                                  className="rounded-xl border border-[#C9D8D1] bg-[#FFFDF7] px-2 py-1 text-xs font-semibold text-[#335768] transition hover:bg-[#EEF6F1] disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {snapshotPromotingId === item.snapshot_id ? "切换中" : "设为当前"}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </section>
            )}

            {detailDrawerPanel === "lock" && (
              <section className="mt-5">
                <div className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-[#102A38]">物理锁定区域</div>
                    {liveSheetStatus?.verified_at && (
                      <div className="text-xs text-[#5B7A88]">{formatTimestamp(liveSheetStatus.verified_at)}</div>
                    )}
                  </div>
                  {liveSheetStatusLoading ? (
                    <div className="mt-2 text-xs text-[#5B7A88]">锁定状态读取中</div>
                  ) : formulaLockRanges109.length === 0 ? (
                    <div className="mt-2 text-xs text-[#5B7A88]">暂无公式锁定区域</div>
                  ) : (
                    <div className="mt-2 space-y-1">
                      <div className="text-[11px] text-[#5B7A88]">{`主表公式锁定 ${formatNumber(formulaLockRanges109.length)} 处`}</div>
                      {formulaLockProtections109.slice(0, 12).map((item) => (
                        <div
                          key={`${item.description}:${item.protected_range}`}
                          className="rounded-xl border border-[#E2EBE6] bg-[#FFFDF7] px-2 py-1 text-[11px] text-[#335768]"
                        >
                          {item.protected_range}
                        </div>
                      ))}
                      {formulaLockRanges109.length > 12 && (
                        <div className="text-[11px] text-[#5B7A88]">{`其余 ${formatNumber(formulaLockRanges109.length - 12)} 处已省略`}</div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {detailDrawerPanel === "logs" && (
              <>
                <section className="mt-5">
                  <h3 className="text-base font-semibold text-[#335768]">流程操作</h3>
                  <div className="mt-3 space-y-3">
                    {auditLogs.length > 0 ? (
                      auditLogs.map((item, index) => (
                        <div key={`${item.timestamp || "audit"}-${item.action || index}`} className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] p-3 text-sm">
                          <div className="font-semibold text-[#102A38]">{item.action || "unknown"}</div>
                          <div className="mt-1 text-[#5B7A88]">
                            {(item.actor_email || "unknown")} · {formatTimestamp(item.timestamp)}
                          </div>
                          {(item.previous_stage || item.next_stage) && (
                            <div className="mt-1 text-[#335768]">
                              {getStageLabel(item.previous_stage)} → {getStageLabel(item.next_stage)}
                            </div>
                          )}
                          {item.message && <div className="mt-1 text-[#335768]">{item.message}</div>}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-3 text-sm text-[#5B7A88]">暂无流程操作日志</div>
                    )}
                  </div>
                </section>

                <section className="mt-6">
                  <h3 className="text-base font-semibold text-[#335768]">表格修改</h3>
                  <div className="mt-3 space-y-3">
                    {editLogs.length > 0 ? (
                      editLogs.map((item, index) => (
                        <div key={`${item.timestamp || "edit"}-${item.sheet_name || index}`} className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] p-3 text-sm">
                          <div className="font-semibold text-[#102A38]">{item.sheet_name || "未命名 Sheet"}</div>
                          <div className="mt-1 text-[#5B7A88]">
                            {(item.actor_email || "unknown")} · {formatTimestamp(item.timestamp)}
                          </div>
                          <div className="mt-1 text-[#335768]">
                            范围: {item.edited_range || "-"} / 区域: {item.edit_area_type || "other"}
                          </div>
                          {item.source && <div className="mt-1 text-[#5B7A88]">来源: {item.source}</div>}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] px-4 py-3 text-sm text-[#5B7A88]">暂无表格修改日志</div>
                    )}
                  </div>
                </section>
              </>
            )}
          </aside>
        </div>
      )}

      {rulesOpen && session && (
        <div className="fixed inset-0 z-40 flex">
          <button
            type="button"
            aria-label="关闭重分类规则"
            className="h-full flex-1 bg-slate-900/35"
            onClick={() => setRulesOpen(false)}
          />
          <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-[#D8E3DD] bg-[#FFFDF7] p-5 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-[#102A38]">重分类规则</h2>
                <div className="mt-1 text-sm text-[#5B7A88]">规则库 {RECLASS_RULES.length} 条</div>
              </div>
              <button type="button" className={secondaryButtonClassName} onClick={() => setRulesOpen(false)}>
                关闭
              </button>
            </div>

            <section className="mt-5 space-y-3">
              {RECLASS_RULES.map((rule) => {
                return (
                  <article
                    key={rule.rule_id}
                    className="rounded-2xl border border-[#D8E3DD] bg-[#F8FBF9] p-4 text-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-bold text-[#102A38]">{rule.rule_id}</span>
                          <span className="rounded-full border border-[#D8E3DD] bg-[#FFFDF7] px-2.5 py-1 text-xs font-semibold text-[#335768]">
                            {rule.category}
                          </span>
                        </div>
                        <div className="mt-2 text-xs font-medium text-[#5B7A88]">
                          {rule.sheet_scope.join(" / ")}
                        </div>
                      </div>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                        规则库
                      </span>
                    </div>

                    <div className="mt-3 text-[#335768]">{rule.reason_zh}</div>
                    <div className="mt-2 text-xs leading-5 text-[#5B7A88]">{rule.reason_en}</div>
                  </article>
                );
              })}
            </section>
          </aside>
        </div>
      )}

      <AuditAmountDetailDrawer
        open={Boolean(amountDetailState)}
        title={amountDetailState?.title}
        mode={amountDetailState?.mode || "external_recon"}
        rows={amountDetailState?.rows || []}
        onClose={() => setAmountDetailState(null)}
      />
    </div>
  );
}
