import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import { DEFAULT_SUPABASE_URL, getLegacySpreadsheetId, isMissingProjectsTableError } from "@/lib/project-registry";

export type DriveProjectRole = "owner" | "organizer" | "fileOrganizer" | "writer" | "commenter" | "reader";

export type ProjectAccess = {
  canAccess: boolean;
  canWrite: boolean;
  isDriveOwner: boolean;
  driveRole: DriveProjectRole | null;
};

export class ProjectAccessError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "ProjectAccessError";
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, ProjectAccessError.prototype);
  }
}

const ACCESS_ROLES = new Set<DriveProjectRole>([
  "owner",
  "organizer",
  "fileOrganizer",
  "writer",
  "commenter",
  "reader",
]);
const WRITABLE_ROLES = new Set<DriveProjectRole>(["owner", "organizer", "fileOrganizer", "writer"]);

const DENIED_ACCESS: ProjectAccess = {
  canAccess: false,
  canWrite: false,
  isDriveOwner: false,
  driveRole: null,
};

export function normalizeAccessEmail(email: string) {
  return email.trim().toLowerCase();
}

function isDriveProjectRole(role: unknown): role is DriveProjectRole {
  return typeof role === "string" && ACCESS_ROLES.has(role as DriveProjectRole);
}

function createDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

function createSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase environment variables are missing.");
  }

  return createClient(supabaseUrl, serviceRoleKey);
}

export async function getProjectAccess(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  const normalizedEmail = normalizeAccessEmail(email);

  if (!normalizedSpreadsheetId || !normalizedEmail) {
    return DENIED_ACCESS;
  }

  const drive = createDriveClient();
  let pageToken: string | undefined;
  let driveRole: DriveProjectRole | null = null;

  do {
    const res = await drive.permissions.list({
      fileId: normalizedSpreadsheetId,
      fields: "nextPageToken,permissions(emailAddress,role)",
      supportsAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    });
    const matchedPermission = (res.data.permissions || []).find(
      (permission) => permission.emailAddress?.toLowerCase() === normalizedEmail,
    );
    driveRole = isDriveProjectRole(matchedPermission?.role) ? matchedPermission.role : null;
    pageToken = typeof res.data.nextPageToken === "string" && res.data.nextPageToken ? res.data.nextPageToken : undefined;
  } while (!driveRole && pageToken);

  return {
    canAccess: Boolean(driveRole),
    canWrite: Boolean(driveRole && WRITABLE_ROLES.has(driveRole)),
    isDriveOwner: driveRole === "owner",
    driveRole,
  };
}

export async function requireProjectAccess(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  await requireRegisteredProjectSpreadsheet(spreadsheetId);
  const access = await getProjectAccess(spreadsheetId, email);
  if (!access.canAccess) {
    throw new ProjectAccessError("Project access is forbidden.", 403, "PROJECT_ACCESS_FORBIDDEN");
  }
  return access;
}

export async function requireProjectCollaborator(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const access = await requireProjectAccess(spreadsheetId, email);
  if (!access.canWrite) {
    throw new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN");
  }
  return access;
}

export async function requireDriveOwner(spreadsheetId: string, email: string): Promise<ProjectAccess> {
  const access = await requireProjectAccess(spreadsheetId, email);
  if (!access.isDriveOwner) {
    throw new ProjectAccessError("Drive owner access is required.", 403, "DRIVE_OWNER_REQUIRED");
  }
  return access;
}

export async function listRegisteredProjectSpreadsheetIds() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("projects")
    .select("spreadsheet_id")
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingProjectsTableError(error)) {
      const legacySpreadsheetId = getLegacySpreadsheetId();
      return legacySpreadsheetId ? [legacySpreadsheetId] : [];
    }
    throw error;
  }

  return (data || [])
    .map((row: { spreadsheet_id?: unknown }) =>
      typeof row.spreadsheet_id === "string" ? row.spreadsheet_id.trim() : "",
    )
    .filter(Boolean);
}

export async function isRegisteredProjectSpreadsheetId(spreadsheetId: string) {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  if (!normalizedSpreadsheetId) {
    return false;
  }

  const spreadsheetIds = await listRegisteredProjectSpreadsheetIds();
  return spreadsheetIds.some((registeredSpreadsheetId) => registeredSpreadsheetId === normalizedSpreadsheetId);
}

export async function requireRegisteredProjectSpreadsheet(spreadsheetId: string) {
  const registered = await isRegisteredProjectSpreadsheetId(spreadsheetId);
  if (!registered) {
    throw new ProjectAccessError("Project is not registered.", 404, "PROJECT_NOT_REGISTERED");
  }
}

export async function verifyAnyProjectAccess(email: string): Promise<boolean> {
  const spreadsheetIds = await listRegisteredProjectSpreadsheetIds();

  for (const spreadsheetId of spreadsheetIds) {
    try {
      const access = await getProjectAccess(spreadsheetId, email);
      if (access.canAccess) {
        return true;
      }
    } catch (error) {
      console.warn(
        `[Auth] Project permission check failed for ${spreadsheetId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }

  return false;
}
