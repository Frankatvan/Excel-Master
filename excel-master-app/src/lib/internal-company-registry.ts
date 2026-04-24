import { createClient } from "@supabase/supabase-js";

import { DEFAULT_SUPABASE_URL } from "@/lib/project-registry";

export type InternalCompanyRegistryRow = {
  company_name: string;
  normalized_name: string;
};

export type InternalCompanyImportRow = {
  Company?: unknown;
  [key: string]: unknown;
};

export function normalizeInternalCompanyName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isInternalCompanyVendor(
  vendor: string,
  registry: readonly InternalCompanyRegistryRow[],
): boolean {
  const normalizedVendor = normalizeInternalCompanyName(vendor);
  return registry.some((row) => row.normalized_name === normalizedVendor);
}

export function validateInternalCompanyWorkbookHeaders(headers: readonly unknown[]): void {
  const hasCompanyColumn = headers.some((header) => String(header ?? "").trim() === "Company");

  if (!hasCompanyColumn) {
    throw new Error('Internal companies workbook must include a "Company" column.');
  }
}

export function buildInternalCompanyRegistryRows(
  rows: readonly InternalCompanyImportRow[],
): InternalCompanyRegistryRow[] {
  const deduped = new Map<string, string>();
  let sawCompanyColumn = false;

  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(row, "Company")) {
      sawCompanyColumn = true;
    }

    const companyName = String(row.Company || "").trim();
    if (!companyName) continue;
    deduped.set(normalizeInternalCompanyName(companyName), companyName);
  }

  if (!sawCompanyColumn) {
    throw new Error('Internal companies workbook must include a "Company" column.');
  }

  return Array.from(deduped.entries()).map(([normalized_name, company_name]) => ({
    company_name,
    normalized_name,
  }));
}

function getSupabaseAdminClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase URL or Service Role Key is not defined");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

export async function readInternalCompanies(): Promise<InternalCompanyRegistryRow[]> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("internal_companies")
    .select("company_name, normalized_name")
    .order("company_name", { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []).map((row) => ({
    company_name: row.company_name,
    normalized_name: row.normalized_name,
  }));
}
