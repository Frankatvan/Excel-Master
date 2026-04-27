import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

// 加载环境变量
const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: envPath });

async function verify() {
  console.log("=== Auth Configuration Verification Script ===");
  
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const googleClientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const googleSheetId = process.env.GOOGLE_SHEET_ID;
  const googlePrivateKey = process.env.GOOGLE_PRIVATE_KEY;

  // 1. 验证环境变量是否存在
  console.log("\n[1/3] Checking Environment Variables...");
  const missing = [];
  if (!supabaseUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!supabaseServiceKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!googleClientEmail) missing.push("GOOGLE_CLIENT_EMAIL");
  if (!googleSheetId) missing.push("GOOGLE_SHEET_ID");
  if (!googlePrivateKey) missing.push("GOOGLE_PRIVATE_KEY");

  if (missing.length > 0) {
    console.error("❌ Missing environment variables:", missing.join(", "));
    return;
  }
  console.log("✅ All required environment variables are present.");

  // 2. 模拟 Google Drive API 调用 (verifySheetAccess)
  console.log("\n[2/3] Verifying Google Drive API Access...");
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: googleClientEmail,
        private_key: googlePrivateKey?.replace(/\\n/g, '\n'),
      },
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const drive = google.drive({ version: "v3", auth });
    console.log(`- Fetching permissions for Sheet ID: ${googleSheetId}`);
    
    const res = await drive.permissions.list({
      fileId: googleSheetId,
      fields: "permissions(emailAddress,role)",
      supportsAllDrives: true,
    });

    const permissions = res.data.permissions || [];
    console.log(`✅ Success: Found ${permissions.length} users with access.`);
    permissions.forEach((p) => {
      console.log(`   - ${p.emailAddress} (${p.role})`);
    });
  } catch (error: any) {
    console.error("❌ Google Drive API Error:", error.message);
  }

  // 3. 模拟 Supabase Upsert
  console.log("\n[3/3] Verifying Supabase Connectivity & Upsert...");
  try {
    const supabase = createClient(supabaseUrl!, supabaseServiceKey!);
    const mockUser = {
      sub: "test-auth-id-" + Date.now(),
      email: "verify-test@example.com",
      last_login: new Date().toISOString()
    };

    console.log(`- Upserting mock user: ${mockUser.email}`);
    const { data, error } = await supabase
      .from("profiles")
      .upsert(mockUser, { onConflict: 'sub' })
      .select();

    if (error) {
      throw error;
    }

    console.log("✅ Supabase Upsert Success!");
    console.log("   Data:", JSON.stringify(data, null, 2));

    // 清理测试数据 (可选)
    // await supabase.from("profiles").delete().eq("sub", mockUser.sub);
    // console.log("- Cleaned up mock user.");
    
  } catch (error: any) {
    console.error("❌ Supabase Error:", error.message);
    if (error.message.includes("relation \"profiles\" does not exist")) {
      console.log("   💡 Hint: The 'profiles' table has not been created in Supabase yet. Please run the SQL in supabase/init_db.sql.");
    }
  }

  console.log("\n=== Verification Complete ===");
}

verify();
