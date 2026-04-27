import { google } from "googleapis";

import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import { WORKBENCH_STAGES, type WorkbenchStage } from "@/lib/workbench-stage";

export const PROJECT_STATE_SHEET = "AiWB_Project_State";
export const AUDIT_LOG_SHEET = "AiWB_Audit_Log";
export const EDIT_LOG_SHEET = "AiWB_Edit_Log";

export type PersistedProjectState = {
  current_stage: WorkbenchStage;
  external_data_dirty: boolean;
  manual_input_dirty: boolean;
  locked: boolean;
  owner_email: string;
  last_external_edit_at?: string;
  last_external_edit_by?: string;
  last_manual_edit_at?: string;
  last_manual_edit_by?: string;
  last_sync_at?: string;
  last_validate_input_at?: string;
  last_reclassify_at?: string;
  last_109_initial_approval_at?: string;
  locked_at?: string;
  locked_by?: string;
  unlocked_at?: string;
  unlocked_by?: string;
};

export type ProjectState = PersistedProjectState & {
  is_owner_or_admin?: boolean;
};

export type AuditLogInput = {
  actor_email: string;
  action: string;
  project_id?: string;
  previous_stage: string;
  next_stage: string;
  status: "success" | "failed";
  message: string;
};

const PROJECT_STATE_ORDERED_KEYS = [
  "current_stage",
  "external_data_dirty",
  "manual_input_dirty",
  "locked",
  "owner_email",
  "last_external_edit_at",
  "last_external_edit_by",
  "last_manual_edit_at",
  "last_manual_edit_by",
  "last_sync_at",
  "last_validate_input_at",
  "last_reclassify_at",
  "last_109_initial_approval_at",
  "locked_at",
  "locked_by",
  "unlocked_at",
  "unlocked_by",
] as const satisfies readonly (keyof PersistedProjectState)[];

const AUDIT_LOG_HEADER = [
  "timestamp",
  "actor_email",
  "action",
  "project_id",
  "spreadsheet_id",
  "previous_stage",
  "next_stage",
  "status",
  "message",
] as const;

const EDIT_LOG_HEADER = [
  "timestamp",
  "actor_email",
  "sheet_name",
  "edited_range",
  "edit_area_type",
  "old_value",
  "new_value",
  "source",
] as const;

function toBool(value: unknown) {
  return String(value || "").trim().toLowerCase() === "true";
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function toBoolText(value: boolean) {
  return value ? "TRUE" : "FALSE";
}

function createSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function mapRows(values: unknown[][] | undefined) {
  const out = new Map<string, string>();
  for (const row of values || []) {
    const key = String(row[0] || "").trim();
    if (!key || key === "key") {
      continue;
    }
    out.set(key, String(row[1] || "").trim());
  }
  return out;
}

function stringifyStateValue(value: PersistedProjectState[keyof PersistedProjectState]) {
  if (typeof value === "boolean") {
    return toBoolText(value);
  }

  return String(value ?? "");
}

function createDefaultProjectState(ownerEmail = ""): PersistedProjectState {
  return {
    current_stage: WORKBENCH_STAGES.PROJECT_CREATED,
    external_data_dirty: false,
    manual_input_dirty: false,
    locked: false,
    owner_email: ownerEmail,
  };
}

function buildProjectStateRows(state: PersistedProjectState) {
  return [["key", "value"], ...PROJECT_STATE_ORDERED_KEYS.map((key) => [key, stringifyStateValue(state[key])])];
}

function extractGoogleApiErrorMessage(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof (error as { response?: unknown }).response === "object" &&
    (error as { response?: unknown }).response !== null
  ) {
    const response = (error as { response: { data?: unknown } }).response;
    if (
      typeof response.data === "object" &&
      response.data !== null &&
      "error" in response.data &&
      typeof (response.data as { error?: unknown }).error === "object" &&
      (response.data as { error?: unknown }).error !== null
    ) {
      const message = (response.data as { error: { message?: unknown } }).error.message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return "";
}

function isMissingSheetRangeError(error: unknown, sheetName: string) {
  const message = extractGoogleApiErrorMessage(error);
  return message.includes("Unable to parse range:") && message.includes(`${sheetName}!`);
}

async function ensureProjectSupportSheets(
  sheets: ReturnType<typeof createSheetsClient>,
  spreadsheetId: string,
  stateSeed?: PersistedProjectState,
) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title,hidden)",
  });
  const existingSheetTitles = new Set(
    (spreadsheet.data.sheets || [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => typeof title === "string" && title.trim().length > 0),
  );

  const missingTitles = [PROJECT_STATE_SHEET, AUDIT_LOG_SHEET, EDIT_LOG_SHEET].filter(
    (title) => !existingSheetTitles.has(title),
  );

  if (missingTitles.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missingTitles.map((title) => ({
          addSheet: {
            properties: {
              title,
              hidden: true,
            },
          },
        })),
      },
    });
  }

  const stateToWrite = stateSeed || createDefaultProjectState();
  if (!existingSheetTitles.has(PROJECT_STATE_SHEET)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${PROJECT_STATE_SHEET}!A:B`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: buildProjectStateRows(stateToWrite) },
    });
  }

  if (!existingSheetTitles.has(AUDIT_LOG_SHEET)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${AUDIT_LOG_SHEET}!A1:I1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [Array.from(AUDIT_LOG_HEADER)] },
    });
  }

  if (!existingSheetTitles.has(EDIT_LOG_SHEET)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${EDIT_LOG_SHEET}!A1:H1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [Array.from(EDIT_LOG_HEADER)] },
    });
  }

  return {
    stateCreated: !existingSheetTitles.has(PROJECT_STATE_SHEET),
  };
}

export async function getProjectState(spreadsheetId: string, actorEmail: string): Promise<ProjectState> {
  const sheets = createSheetsClient();
  let response;
  try {
    response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${PROJECT_STATE_SHEET}!A:B`,
      valueRenderOption: "FORMATTED_VALUE",
    });
  } catch (error) {
    if (!isMissingSheetRangeError(error, PROJECT_STATE_SHEET)) {
      throw error;
    }

    await ensureProjectSupportSheets(sheets, spreadsheetId, createDefaultProjectState());
    return {
      ...createDefaultProjectState(),
      is_owner_or_admin: false,
    };
  }
  const rows = mapRows(response.data.values as unknown[][] | undefined);
  const ownerEmail = rows.get("owner_email") || "";
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const normalizedActorEmail = normalizeEmail(actorEmail);

  return {
    current_stage: (rows.get("current_stage") as WorkbenchStage) || WORKBENCH_STAGES.PROJECT_CREATED,
    external_data_dirty: toBool(rows.get("external_data_dirty")),
    manual_input_dirty: toBool(rows.get("manual_input_dirty")),
    locked: toBool(rows.get("locked")),
    owner_email: ownerEmail,
    last_external_edit_at: rows.get("last_external_edit_at") || undefined,
    last_external_edit_by: rows.get("last_external_edit_by") || undefined,
    last_manual_edit_at: rows.get("last_manual_edit_at") || undefined,
    last_manual_edit_by: rows.get("last_manual_edit_by") || undefined,
    last_sync_at: rows.get("last_sync_at") || undefined,
    last_validate_input_at: rows.get("last_validate_input_at") || undefined,
    last_reclassify_at: rows.get("last_reclassify_at") || undefined,
    last_109_initial_approval_at: rows.get("last_109_initial_approval_at") || undefined,
    locked_at: rows.get("locked_at") || undefined,
    locked_by: rows.get("locked_by") || undefined,
    unlocked_at: rows.get("unlocked_at") || undefined,
    unlocked_by: rows.get("unlocked_by") || undefined,
    // MVP only checks owner equality; API-level admin expansion can come later.
    is_owner_or_admin: Boolean(
      normalizedOwnerEmail && normalizedActorEmail && normalizedOwnerEmail === normalizedActorEmail,
    ),
  };
}

export async function writeProjectState(spreadsheetId: string, state: PersistedProjectState) {
  const sheets = createSheetsClient();
  await ensureProjectSupportSheets(sheets, spreadsheetId, state);
  const rows = buildProjectStateRows(state);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${PROJECT_STATE_SHEET}!A:B`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
}

export async function appendAuditLog(spreadsheetId: string, input: AuditLogInput) {
  const sheets = createSheetsClient();
  await ensureProjectSupportSheets(sheets, spreadsheetId);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${AUDIT_LOG_SHEET}!A:I`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          new Date().toISOString(),
          input.actor_email,
          input.action,
          input.project_id || spreadsheetId,
          spreadsheetId,
          input.previous_stage,
          input.next_stage,
          input.status,
          input.message,
        ],
      ],
    },
  });
}
