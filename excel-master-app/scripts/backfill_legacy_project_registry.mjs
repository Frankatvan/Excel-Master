import * as dotenv from "dotenv";
import * as path from "path";

import { createClient } from "@supabase/supabase-js";

const LEGACY_PROJECT = {
  name: "WBWT Sandy Cove",
  spreadsheet_id: "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw",
  sheet_109_title: "109",
};

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  dotenv.config({ path: envPath });
}

function readOwnerEmail(argv) {
  const ownerEmailArg = argv.find((arg) => arg.startsWith("--owner-email="));
  if (ownerEmailArg) {
    return ownerEmailArg.slice("--owner-email=".length).trim();
  }

  return (
    process.env.LEGACY_PROJECT_OWNER_EMAIL?.trim() ||
    process.env.PROJECT_OWNER_EMAIL?.trim() ||
    process.env.OWNER_EMAIL?.trim() ||
    ""
  );
}

async function main() {
  loadEnv();

  const ownerEmail = readOwnerEmail(process.argv.slice(2));
  if (!ownerEmail) {
    throw new Error(
      "owner_email is required. Pass --owner-email=<email> or set LEGACY_PROJECT_OWNER_EMAIL.",
    );
  }

  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("SUPABASE URL or SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const payload = {
    ...LEGACY_PROJECT,
    owner_email: ownerEmail,
  };

  const { data, error } = await supabase
    .from("projects")
    .upsert(payload, { onConflict: "spreadsheet_id" })
    .select("id,name,spreadsheet_id,sheet_109_title,owner_email")
    .single();

  if (error) {
    throw error;
  }

  console.log("Legacy project registry backfill complete.");
  console.log(JSON.stringify(data, null, 2));
}

main().catch((error) => {
  console.error("Legacy project registry backfill failed:", error.message || error);
  process.exit(1);
});
