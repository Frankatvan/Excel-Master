import type { NextApiRequest } from "next";

import { google } from "googleapis";

import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";

type BootstrapProjectSpreadsheetInput = {
  req: NextApiRequest;
  projectName: string;
  projectShortName: string;
  projectOwner: string;
  projectSerial: string;
  goldenTemplateId: string;
  userEmail: string;
};

type BootstrapProjectSpreadsheetResult = {
  spreadsheetId: string;
  spreadsheetUrl: string;
};

function resolveProjectBootstrapWorkerUrl(_req: NextApiRequest) {
  const configuredUrl = process.env.PROJECT_BOOTSTRAP_WORKER_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }
  throw new Error("Project bootstrap worker URL is not configured.");
}

function resolveProjectBootstrapWorkerSecret() {
  const configuredSecret = process.env.PROJECT_BOOTSTRAP_WORKER_SECRET?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  const fallbackSecret = process.env.AIWB_WORKER_SECRET?.trim();
  if (fallbackSecret) {
    return fallbackSecret;
  }

  throw new Error("Project bootstrap worker secret is not configured.");
}

async function parseWorkerBody(response: Response) {
  const raw = await response.text();
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { message: raw };
  }
}

function createDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

export async function renameProjectSpreadsheetFile(spreadsheetId: string, nextName: string) {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  const normalizedName = nextName.trim();
  if (!normalizedSpreadsheetId || !normalizedName) {
    return;
  }

  const drive = createDriveClient();
  await drive.files.update({
    fileId: normalizedSpreadsheetId,
    supportsAllDrives: true,
    requestBody: {
      name: normalizedName,
    },
  });
}

export async function cleanupProjectSpreadsheet(spreadsheetId: string) {
  const normalizedSpreadsheetId = spreadsheetId.trim();
  if (!normalizedSpreadsheetId) {
    return;
  }

  const drive = createDriveClient();
  await drive.files.delete({
    fileId: normalizedSpreadsheetId,
    supportsAllDrives: true,
  });
}

export async function bootstrapProjectSpreadsheet({
  req,
  projectName,
  projectShortName,
  projectOwner,
  projectSerial,
  goldenTemplateId,
  userEmail,
}: BootstrapProjectSpreadsheetInput): Promise<BootstrapProjectSpreadsheetResult> {
  const normalizedTemplateId = goldenTemplateId.trim();
  if (!normalizedTemplateId) {
    throw new Error("Golden template id is required.");
  }

  const workerSecret = resolveProjectBootstrapWorkerSecret();
  const workerResponse = await fetch(resolveProjectBootstrapWorkerUrl(req), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AiWB-Worker-Secret": workerSecret,
    },
    body: JSON.stringify({
      operation: "bootstrap_from_template",
      project_sequence: projectSerial,
      project_short_name: projectShortName,
      project_name: projectName,
      project_owner: projectOwner,
      golden_template_id: normalizedTemplateId,
      creator_email: userEmail,
    }),
  });
  const workerBody = await parseWorkerBody(workerResponse);
  const returnedSpreadsheetId =
    typeof workerBody.spreadsheet_id === "string" ? workerBody.spreadsheet_id.trim() : "";

  if (!workerResponse.ok) {
    if (returnedSpreadsheetId) {
      await cleanupProjectSpreadsheet(returnedSpreadsheetId);
    }
    const message =
      typeof workerBody.message === "string" && workerBody.message.trim()
        ? workerBody.message
        : `Project bootstrap worker failed (${workerResponse.status})`;
    throw new Error(message);
  }
  if (workerBody.status !== "success") {
    if (returnedSpreadsheetId) {
      await cleanupProjectSpreadsheet(returnedSpreadsheetId);
    }
    const message =
      typeof workerBody.message === "string" && workerBody.message.trim()
        ? workerBody.message
        : "Project bootstrap worker returned non-success status.";
    throw new Error(message);
  }

  const spreadsheetId = returnedSpreadsheetId;
  if (!spreadsheetId) {
    throw new Error("Project bootstrap worker succeeded but did not return spreadsheet_id.");
  }

  const spreadsheetUrl =
    typeof workerBody.spreadsheet_url === "string" && workerBody.spreadsheet_url.trim()
      ? workerBody.spreadsheet_url.trim()
      : `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return {
    spreadsheetId,
    spreadsheetUrl,
  };
}
