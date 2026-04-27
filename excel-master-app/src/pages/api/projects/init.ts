
import type { NextApiRequest, NextApiResponse } from 'next'
import { getServerSession } from "next-auth/next"
import { authOptions } from "../auth/[...nextauth]"
import { createClient } from '@supabase/supabase-js'
import { bootstrapProjectSpreadsheet, cleanupProjectSpreadsheet } from "@/lib/project-bootstrap"
import {
  DEFAULT_SUPABASE_URL,
  PROJECT_SERIAL_ERROR_MESSAGE,
  assertValidProjectSerial,
  isMissingProjectSequenceColumnError,
} from "@/lib/project-registry"

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role for backend operations

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Supabase URL or Service Role Key is not defined")
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

class ProjectInitRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ProjectInitRequestError"
    this.status = status
  }
}

function resolveGoldenTemplateId() {
  return (
    process.env.GOLDEN_TEMPLATE_ID?.trim() ||
    process.env.GOOGLE_SHEET_TEMPLATE_ID?.trim() ||
    process.env.GOOGLE_SHEET_ID?.trim() ||
    ""
  )
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  let createdSpreadsheetId: string | null = null

  if (req.method !== 'POST') {
    res.setHeader("Allow", "POST")
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const session = await getServerSession(req, res, authOptions)
  if (!session || !session.user || !session.user.email) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const userSub =
    typeof (session.user as { sub?: unknown }).sub === "string"
      ? ((session.user as { sub?: string }).sub ?? "").trim()
      : ""

  const projectName = typeof req.body?.projectName === "string" ? req.body.projectName.trim() : ""
  const projectShortName =
    typeof req.body?.projectShortName === "string"
      ? req.body.projectShortName.trim()
      : typeof req.body?.shortName === "string"
        ? req.body.shortName.trim()
        : ""
  const projectOwner = typeof req.body?.projectOwner === "string" ? req.body.projectOwner.trim() : ""
  const requestedProjectSerial =
    typeof req.body?.projectSerial === "string" ? req.body.projectSerial.trim() : ""

  if (!projectShortName) {
    return res.status(400).json({ error: "Project short name is required" })
  }

  if (!projectOwner) {
    return res.status(400).json({ error: 'Project owner is required' })
  }

  let projectSerial = ""
  try {
    projectSerial = assertValidProjectSerial(requestedProjectSerial)
  } catch {
    return res.status(400).json({ error: PROJECT_SERIAL_ERROR_MESSAGE })
  }

  try {
    const serialFilters = [
      `project_sequence.eq.${projectSerial},sheet_109_title.eq.${projectSerial}`,
      `sheet_109_title.eq.${projectSerial}`,
    ];
    let { data: existingProjects, error: existingProjectsError } = await supabase
      .from("projects")
      .select("id")
      .or(serialFilters[0])
      .limit(1);

    if (isMissingProjectSequenceColumnError(existingProjectsError)) {
      const fallback = await supabase
        .from("projects")
        .select("id")
        .or(serialFilters[1])
        .limit(1);
      existingProjects = fallback.data;
      existingProjectsError = fallback.error;
    }

    if (existingProjectsError) {
      console.error("Project serial lookup error:", existingProjectsError)
      throw new Error("Failed to validate project serial")
    }

    if ((existingProjects || []).length > 0) {
      return res.status(409).json({ error: `Project serial ${projectSerial} already exists` })
    }

    const goldenTemplateId = resolveGoldenTemplateId()

    if (!goldenTemplateId) {
      throw new Error("Golden template spreadsheet id is not configured")
    }

    const { spreadsheetId, spreadsheetUrl } = await bootstrapProjectSpreadsheet({
      req,
      projectName: projectName || projectShortName,
      projectShortName,
      projectOwner,
      projectSerial,
      goldenTemplateId,
      userEmail: session.user.email,
    })
    createdSpreadsheetId = spreadsheetId

    if (!userSub) {
      throw new Error("Failed to resolve user identity")
    }

    const baseInsertPayload = {
      user_id_sub: userSub,
      spreadsheet_id: spreadsheetId,
      name: projectName || projectShortName,
      sheet_109_title: projectSerial,
      owner_email: session.user.email,
    };
    let { data: projectData, error: projectError } = await supabase
      .from("projects")
      .insert({
        ...baseInsertPayload,
        project_sequence: projectSerial,
      })
      .select()
      .single();

    if (isMissingProjectSequenceColumnError(projectError)) {
      const fallback = await supabase
        .from("projects")
        .insert(baseInsertPayload)
        .select()
        .single();
      projectData = fallback.data;
      projectError = fallback.error;
    }

    if (projectError) {
      console.error("Supabase project insert error:", projectError);
      if (projectError.code === "23505") {
        throw new ProjectInitRequestError(409, `Project serial ${projectSerial} already exists`)
      }
      throw new Error("Failed to record project in database");
    }

    res.status(200).json({ 
      success: true, 
      projectId: projectData.id, 
      project: projectData,
      spreadsheetId,
      spreadsheetUrl,
    });

  } catch (error: any) {
    if (createdSpreadsheetId) {
      try {
        await cleanupProjectSpreadsheet(createdSpreadsheetId)
      } catch (cleanupError) {
        console.error("Project spreadsheet cleanup error:", cleanupError)
      }
    }
    console.error("Project init error:", error);
    const status = error instanceof ProjectInitRequestError ? error.status : 500
    res.status(status).json({ error: error.message || 'Internal server error' });
  }
}
