import { createClient } from "@supabase/supabase-js";

export const PROJECT_SERIAL_PATTERN = /^\d{3}$/;
export const PROJECT_SERIAL_ERROR_MESSAGE = "Project serial must be exactly 3 digits";
export const DEFAULT_SUPABASE_URL = "https://ysdraxoesuwxhjijctbd.supabase.co";
export const LEGACY_PROJECT_NAME = "WBWT Sandy Cove";

function normalizeProjectName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeProjectSerial(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function isValidProjectSerial(value: unknown) {
  return PROJECT_SERIAL_PATTERN.test(normalizeProjectSerial(value));
}

export function assertValidProjectSerial(value: unknown) {
  const normalizedValue = normalizeProjectSerial(value);
  if (!PROJECT_SERIAL_PATTERN.test(normalizedValue)) {
    throw new Error(PROJECT_SERIAL_ERROR_MESSAGE);
  }

  return normalizedValue;
}

function formatProjectLedgerDate(createdAt: Date) {
  return `${createdAt.getMonth() + 1}.${createdAt.getDate()}.${createdAt.getFullYear()}`;
}

export function buildProjectLedgerFileName({
  projectSerial,
  projectName,
  createdAt = new Date(),
}: {
  projectSerial: string;
  projectName: string;
  createdAt?: Date;
}) {
  const normalizedProjectSerial = assertValidProjectSerial(projectSerial);
  const normalizedProjectName = normalizeProjectName(projectName);

  if (!normalizedProjectName) {
    throw new Error("Project name is required");
  }

  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new Error("Project creation date is invalid");
  }

  return `Project Ledger_${normalizedProjectSerial}_${normalizedProjectName}_${formatProjectLedgerDate(createdAt)}`;
}

export type ProjectRegistryProject = {
  name?: string | null;
  sheet_109_title?: string | null;
  project_sequence?: string | null;
};

export type ProjectListFallbackItem = {
  id: string;
  name: string;
  spreadsheet_id: string;
  sheet_109_title: string;
  project_sequence?: string;
  owner_email?: string;
};

export function resolveProjectMainSheetTitle(project: {
  sheet_109_title?: string | null;
  project_sequence?: string | null;
}) {
  const configuredTitle = typeof project.sheet_109_title === "string" ? project.sheet_109_title.trim() : "";
  if (configuredTitle) {
    return configuredTitle;
  }
  const projectSequence = typeof project.project_sequence === "string" ? project.project_sequence.trim() : "";
  return projectSequence;
}

function getSupabaseAdminClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase URL or Service Role Key is not defined");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

export function isMissingProjectsTableError(error: unknown): error is { code?: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "PGRST205";
}

export function isMissingProjectSequenceColumnError(error: unknown): error is { code?: string; message?: string } {
  if (!error || typeof error !== "object") {
    return false;
  }
  const typed = error as { code?: string; message?: string };
  if (typed.code !== "42703") {
    return false;
  }
  return typeof typed.message === "string" && typed.message.toLowerCase().includes("project_sequence");
}

export function getLegacySpreadsheetId() {
  return process.env.GOOGLE_SHEET_ID?.trim() || process.env.GOOGLE_SHEET_TEMPLATE_ID?.trim() || "";
}

export function buildLegacyProjectFallback(ownerEmail?: string): ProjectListFallbackItem | null {
  const spreadsheetId = getLegacySpreadsheetId();
  if (!spreadsheetId) {
    return null;
  }
  const legacyProjectSequence = normalizeProjectSerial(process.env.LEGACY_PROJECT_SEQUENCE || "");
  const legacyMainSheetTitle = resolveProjectMainSheetTitle({
    sheet_109_title: process.env.LEGACY_MAIN_SHEET_TITLE || "",
    project_sequence: legacyProjectSequence,
  });

  return {
    id: `legacy-${spreadsheetId}`,
    name: LEGACY_PROJECT_NAME,
    spreadsheet_id: spreadsheetId,
    sheet_109_title: legacyMainSheetTitle,
    project_sequence: legacyProjectSequence || undefined,
    ...(ownerEmail?.trim() ? { owner_email: ownerEmail.trim() } : {}),
  };
}

export async function getProjectRegistryProject(spreadsheetId: string) {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  if (!normalizedSpreadsheetId) {
    return null;
  }

  const supabase = getSupabaseAdminClient();
  let { data, error } = await supabase
    .from("projects")
    .select("name,sheet_109_title,project_sequence")
    .eq("spreadsheet_id", normalizedSpreadsheetId)
    .maybeSingle<ProjectRegistryProject>();

  if (isMissingProjectSequenceColumnError(error)) {
    const fallback = await supabase
      .from("projects")
      .select("name,sheet_109_title")
      .eq("spreadsheet_id", normalizedSpreadsheetId)
      .maybeSingle<Pick<ProjectRegistryProject, "name" | "sheet_109_title">>();
    data = fallback.data ? { ...fallback.data, project_sequence: null } : null;
    error = fallback.error;
  }

  if (error) {
    if (isMissingProjectsTableError(error)) {
      const legacySpreadsheetId = getLegacySpreadsheetId();
      if (legacySpreadsheetId && legacySpreadsheetId === normalizedSpreadsheetId) {
        const legacyProjectSequence = normalizeProjectSerial(process.env.LEGACY_PROJECT_SEQUENCE || "");
        return {
          name: LEGACY_PROJECT_NAME,
          sheet_109_title: process.env.LEGACY_MAIN_SHEET_TITLE || "",
          project_sequence: legacyProjectSequence || null,
        };
      }
      return null;
    }
    throw error;
  }

  return data || null;
}
