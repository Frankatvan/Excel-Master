import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_SUPABASE_URL,
  isMissingProjectSequenceColumnError,
  isMissingProjectsTableError,
  resolveProjectMainSheetTitle,
} from "@/lib/project-registry";

type Project109Registration = {
  sheet_109_title?: string | null;
  project_sequence?: string | null;
};

function getSupabaseAdminClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

export function quoteProjectSheetName(name: string) {
  return `'${name.replace(/'/g, "''")}'`;
}

export function buildProject109Range(sheet109Title: string, a1Range: string) {
  return `${quoteProjectSheetName(sheet109Title)}!${a1Range}`;
}

export async function getProject109Title(spreadsheetId: string) {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  if (!normalizedSpreadsheetId) {
    return "";
  }

  const supabase = getSupabaseAdminClient();
  let { data, error } = await supabase
    .from("projects")
    .select("sheet_109_title,project_sequence")
    .eq("spreadsheet_id", normalizedSpreadsheetId)
    .maybeSingle<Project109Registration>();

  if (isMissingProjectSequenceColumnError(error)) {
    const fallback = await supabase
      .from("projects")
      .select("sheet_109_title")
      .eq("spreadsheet_id", normalizedSpreadsheetId)
      .maybeSingle<Pick<Project109Registration, "sheet_109_title">>();
    data = fallback.data ? { ...fallback.data, project_sequence: null } : null;
    error = fallback.error;
  }

  if (error) {
    if (isMissingProjectsTableError(error)) {
      return "";
    }
    throw error;
  }
  return resolveProjectMainSheetTitle(data || {});
}
