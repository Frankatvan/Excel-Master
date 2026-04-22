import { google } from "googleapis";

import { getSupabaseClient } from "@/lib/auth-supabase";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function verifySheetAccess(email: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  console.log(`[Auth] Verifying access for: ${normalizedEmail}`);

  try {
    const supabase = getSupabaseClient();
    const { data: cachedUser } = await supabase
      .from("whitelisted_users")
      .select("email")
      .eq("email", normalizedEmail)
      .single();

    if (cachedUser) {
      console.log(`[Auth] Cache HIT for ${normalizedEmail}`);
      return true;
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const drive = google.drive({ version: "v3", auth });
    const res = await drive.permissions.list({
      fileId: process.env.GOOGLE_SHEET_ID!,
      fields: "permissions(emailAddress,role)",
    });

    const permissions = res.data.permissions || [];
    const matchedPermission = permissions.find(
      (permission) => permission.emailAddress?.toLowerCase() === normalizedEmail,
    );

    if (!matchedPermission) {
      console.warn(`[Auth] Access DENIED for ${normalizedEmail}: Not in sharing list.`);
      return false;
    }

    const { error: upsertError } = await supabase.from("whitelisted_users").upsert({
      email: normalizedEmail,
      role: matchedPermission.role || null,
      last_synced_at: new Date().toISOString(),
    });

    if (upsertError) {
      throw upsertError;
    }

    console.log(`[Auth] Access GRANTED and CACHED for ${normalizedEmail}`);
    return true;
  } catch (error: any) {
    console.error("Critical: verifySheetAccess failed:", error.message);
    return false;
  }
}
