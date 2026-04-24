import * as dotenv from "dotenv";
import xlsx from "xlsx";

import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  dotenv.config({ path: ".env.local" });
}

function normalizeInternalCompanyName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function main() {
  loadEnv();

  const workbookPath = process.argv[2];
  if (!workbookPath) {
    throw new Error("Usage: node scripts/import_internal_companies.mjs <workbook-path>");
  }

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("SUPABASE URL or SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  const workbook = xlsx.readFile(workbookPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  const deduped = new Map();

  for (const row of rows) {
    const companyName = String(row.Company || "").trim();
    if (!companyName) continue;
    deduped.set(normalizeInternalCompanyName(companyName), companyName);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { error } = await supabase.from("internal_companies").upsert(
    Array.from(deduped.entries()).map(([normalized_name, company_name]) => ({
      company_name,
      normalized_name,
    })),
    { onConflict: "normalized_name" },
  );

  if (error) {
    throw error;
  }

  console.log(`Imported ${deduped.size} internal companies.`);
}

main().catch((error) => {
  console.error("Internal company import failed:", error.message || error);
  process.exit(1);
});
