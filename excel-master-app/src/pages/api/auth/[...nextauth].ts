import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import EmailProvider from "next-auth/providers/email"
import { google } from "googleapis"
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function verifySheetAccess(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase();
  console.log(`[Auth] Verifying access for: ${normalizedEmail}`);

  try {
    // 1. 优先查询数据库缓存 (whitelisted_users)
    const { data: cachedUser } = await supabase
      .from("whitelisted_users")
      .select("email")
      .eq("email", normalizedEmail)
      .single();

    if (cachedUser) {
      console.log(`[Auth] Cache HIT for ${normalizedEmail}`);
      return true;
    }

    // 2. 缓存未命中，穿透到 Google Drive API
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });

    const drive = google.drive({ version: "v3", auth });
    const res = await drive.permissions.list({
      fileId: process.env.GOOGLE_SHEET_ID!,
      fields: "permissions(emailAddress,role)",
    });

    const permissions = res.data.permissions || [];
    const hasAccess = permissions.some(
      (p) => p.emailAddress?.toLowerCase() === normalizedEmail
    );

    if (hasAccess) {
      // 3. 同步回数据库缓存
      await supabase.from("whitelisted_users").upsert({ 
        email: normalizedEmail, 
        last_synced_at: new Date().toISOString() 
      });
      console.log(`[Auth] Access GRANTED and CACHED for ${normalizedEmail}`);
    } else {
      console.warn(`[Auth] Access DENIED for ${normalizedEmail}: Not in sharing list.`);
    }

    return hasAccess;
  } catch (error: any) {
    console.error("Critical: verifySheetAccess failed:", error.message);
    return false;
  }
}

export const authOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    EmailProvider({
      server: {
        host: process.env.EMAIL_SERVER_HOST,
        port: Number(process.env.EMAIL_SERVER_PORT || 587),
        auth: {
          user: process.env.EMAIL_SERVER_USER,
          pass: process.env.EMAIL_SERVER_PASSWORD,
        },
      },
      from: process.env.EMAIL_FROM,
    }),
  ],
  callbacks: {
    async signIn({ user }: { user: { email?: string | null } }) {
      if (!user.email) return false;
      return await verifySheetAccess(user.email);
    },
    async session({ session, token }: any) {
      if (session.user) {
        session.user.sub = token.sub;
      }
      return session;
    }
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export default NextAuth(authOptions);
