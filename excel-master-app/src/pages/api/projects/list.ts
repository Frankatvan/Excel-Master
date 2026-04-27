import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";
import { createClient } from "@supabase/supabase-js";
import { authOptions } from "../auth/[...nextauth]";
import {
  buildLegacyProjectFallback,
  DEFAULT_SUPABASE_URL,
  isMissingProjectSequenceColumnError,
  isMissingProjectsTableError,
} from "@/lib/project-registry";
import { getProjectAccess } from "@/lib/project-access";

type ProjectListMode = "empty" | "direct" | "summary";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error("Supabase URL or Service Role Key is not defined");
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

function getProjectListMode(projectCount: number): ProjectListMode {
  if (projectCount === 0) {
    return "empty";
  }

  if (projectCount === 1) {
    return "direct";
  }

  return "summary";
}

async function filterProjectsByAccess(projects: Array<Record<string, unknown>>, email: string) {
  const accessibleProjects: Array<Record<string, unknown>> = [];

  for (const project of projects) {
    const spreadsheetId = typeof project.spreadsheet_id === "string" ? project.spreadsheet_id.trim() : "";
    if (!spreadsheetId) {
      continue;
    }

    try {
      const access = await getProjectAccess(spreadsheetId, email);
      if (access.canAccess) {
        accessibleProjects.push(project);
      }
    } catch (error) {
      console.warn("Project access lookup failed:", { spreadsheetId, error });
    }
  }

  return accessibleProjects;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  const email = session?.user?.email;

  if (!email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const queryProjects = async (includeProjectSequence: boolean) =>
      (supabase.from("projects") as unknown as {
        select: (columns: string) => {
          order: (column: string, options: { ascending: boolean }) => Promise<{
            data: Array<Record<string, unknown>> | null;
            error: unknown;
          }>;
        };
      })
        .select(
          includeProjectSequence
            ? "id,name,spreadsheet_id,sheet_109_title,project_sequence,owner_email,created_at"
            : "id,name,spreadsheet_id,sheet_109_title,owner_email,created_at",
        )
        .order("created_at", { ascending: false });

    let { data: projects, error: projectsError } = await queryProjects(true);

    if (isMissingProjectSequenceColumnError(projectsError)) {
      const fallback = await queryProjects(false);
      projects = (fallback.data || []).map((item) => ({ ...(item as Record<string, unknown>), project_sequence: null }));
      projectsError = fallback.error;
    }

    if (projectsError) {
      if (isMissingProjectsTableError(projectsError)) {
        const legacyProject = buildLegacyProjectFallback(email);
        const projectList = legacyProject ? await filterProjectsByAccess([legacyProject], email) : [];
        return res.status(200).json({
          mode: getProjectListMode(projectList.length),
          projects: projectList,
        });
      }
      console.error("Projects lookup error:", projectsError);
      return res.status(500).json({ error: "Failed to load projects" });
    }

    const projectList = await filterProjectsByAccess(projects || [], email);

    return res.status(200).json({
      mode: getProjectListMode(projectList.length),
      projects: projectList,
    });
  } catch (error) {
    console.error("Project list error:", error);
    return res.status(500).json({ error: "Failed to load projects" });
  }
}
