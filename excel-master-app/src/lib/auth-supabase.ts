import { createClient } from "@supabase/supabase-js";
import { DEFAULT_SUPABASE_URL } from "@/lib/project-registry";

export function getSupabaseClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Supabase auth environment variables are missing.");
  }

  return createClient(supabaseUrl, supabaseServiceKey);
}
