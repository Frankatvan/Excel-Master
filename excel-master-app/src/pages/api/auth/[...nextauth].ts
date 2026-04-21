import NextAuth from "next-auth"
import GoogleProvider from "next-auth/providers/google"
import { google } from "googleapis"
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function verifySheetAccess(email: string): Promise<boolean> {
  const normalizedEmail = email.toLowerCase();
  console.log(`[Auth] Verifying access for: ${normalizedEmail}`);

  try {
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
