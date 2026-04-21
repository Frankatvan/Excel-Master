
import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
import { google } from "googleapis"
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role for backend operations

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Supabase URL or Service Role Key is not defined")
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session || !session.user || !session.user.email) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { projectName } = req.body

  if (!projectName) {
    return res.status(400).json({ error: 'Project name is required' })
  }

  try {
    // 1. Setup Google Auth
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ["https://www.googleapis.com/auth/drive"],
    });

    const drive = google.drive({ version: "v3", auth });

    // 2. Clone the template sheet
    const templateId = process.env.GOOGLE_SHEET_TEMPLATE_ID;
    if (!templateId) {
      throw new Error("GOOGLE_SHEET_TEMPLATE_ID is not defined");
    }

    console.log(`Cloning template ${templateId} for project ${projectName}...`);
    const copyRes = await drive.files.copy({
      fileId: templateId,
      requestBody: {
        name: projectName,
      },
    });

    const newSheetId = copyRes.data.id;
    if (!newSheetId) {
      throw new Error("Failed to clone the sheet");
    }

    // 3. Save project to Supabase
    // Note: We use the user's email as the identifier for simplicity in this MVP, 
    // as it matches the profiles table created in signIn.
    const { data: userData, error: userError } = await supabase
      .from("profiles")
      .select("sub")
      .eq("email", session.user.email)
      .single();

    if (userError || !userData) {
      throw new Error("User profile not found");
    }

    const { data: projectData, error: projectError } = await supabase
      .from("projects")
      .insert({
        user_id_sub: userData.sub, // Mapping sub from profiles
        spreadsheet_id: newSheetId,
        name: projectName,
      })
      .select()
      .single();

    if (projectError) {
      console.error("Supabase project insert error:", projectError);
      throw new Error("Failed to record project in database");
    }

    res.status(200).json({ 
      success: true, 
      projectId: projectData.id, 
      spreadsheetId: newSheetId 
    });

  } catch (error: any) {
    console.error("Project init error:", error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
