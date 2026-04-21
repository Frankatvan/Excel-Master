import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

import {
  buildAuditSnapshot,
  normalizeSpreadsheetId,
  type AuditSnapshot,
  type SpreadsheetRow,
} from "@/lib/audit-dashboard";

interface AuditCacheRow {
  project_id: string;
  data_json: AuditSnapshot;
  last_synced_at: string;
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

function getSheetsClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error("Google service account credentials are missing.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });

  return google.sheets({ version: "v4", auth });
}

function asRows(valueRange?: { values?: SpreadsheetRow[] }): SpreadsheetRow[] {
  return valueRange?.values || [];
}

export async function readAuditCache(spreadsheetId: string): Promise<AuditCacheRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("audit_cache")
    .select("project_id, data_json, last_synced_at")
    .eq("project_id", spreadsheetId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as AuditCacheRow | null) || null;
}

export async function upsertAuditCache(
  spreadsheetId: string,
  snapshot: AuditSnapshot,
  lastSyncedAt: string,
): Promise<AuditCacheRow> {
  const supabase = getSupabaseAdminClient();
  const row = {
    project_id: spreadsheetId,
    data_json: snapshot,
    last_synced_at: lastSyncedAt,
  };

  const { data, error } = await supabase
    .from("audit_cache")
    .upsert(row, { onConflict: "project_id" })
    .select("project_id, data_json, last_synced_at")
    .single();

  if (error) {
    throw error;
  }

  return data as AuditCacheRow;
}

export async function fetchLiveAuditSnapshot(spreadsheetIdInput?: string | string[] | null) {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [
      "'109'!C2",
      "'109'!A1:R80",
      "'Payable'!A1:AQ5000",
      "'Final Detail'!A1:AB5000",
      "'Draw request report'!A1:AK5000",
      "'Unit Master'!A1:M2000",
      "'Scoping'!A1:N1000",
    ],
    valueRenderOption: "FORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const ranges = response.data.valueRanges || [];
  const rows109 = asRows(ranges[1]);
  const projectName = String(asRows(ranges[0])[0]?.[0] || rows109[1]?.[2] || "Unnamed Project");
  const kpiRows = rows109;
  const payableRows = asRows(ranges[2]);
  const finalDetailRows = asRows(ranges[3]);
  const drawRequestRows = asRows(ranges[4]);
  const unitMasterRows = asRows(ranges[5]);
  const scopingRows = asRows(ranges[6]);
  const snapshot = buildAuditSnapshot({
    projectName,
    kpiRows,
    payableRows,
    finalDetailRows,
    drawRequestRows,
    unitMasterRows,
    scopingRows,
    rows109,
  });

  return { spreadsheetId, snapshot };
}

export async function getAuditSummary(spreadsheetIdInput?: string | string[] | null) {
  const spreadsheetId = normalizeSpreadsheetId(spreadsheetIdInput);
  const cached = await readAuditCache(spreadsheetId);

  if (cached) {
    return {
      ...cached.data_json,
      last_synced_at: cached.last_synced_at,
      from_cache: true,
    };
  }

  const { snapshot } = await fetchLiveAuditSnapshot(spreadsheetId);
  const lastSyncedAt = new Date().toISOString();
  await upsertAuditCache(spreadsheetId, snapshot, lastSyncedAt);

  return {
    ...snapshot,
    last_synced_at: lastSyncedAt,
    from_cache: false,
  };
}

export async function syncAuditSummary(spreadsheetIdInput?: string | string[] | null) {
  const { spreadsheetId, snapshot } = await fetchLiveAuditSnapshot(spreadsheetIdInput);
  const lastSyncedAt = new Date().toISOString();
  await upsertAuditCache(spreadsheetId, snapshot, lastSyncedAt);

  return {
    spreadsheetId,
    last_synced_at: lastSyncedAt,
    snapshot,
  };
}
