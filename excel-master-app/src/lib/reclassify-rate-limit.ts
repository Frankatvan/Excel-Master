import { google } from "googleapis";

import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";

const RECLASSIFY_NEXT_AT_KEY = "aiwb_reclassify_next_at";

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

export async function readReclassifyCooldown(spreadsheetId: string): Promise<string | null> {
  const drive = getDriveClient();
  const response = await drive.files.get({
    fileId: spreadsheetId,
    fields: "appProperties",
    supportsAllDrives: true,
  });

  const nextAt = response.data.appProperties?.[RECLASSIFY_NEXT_AT_KEY];
  return typeof nextAt === "string" && nextAt.trim() ? nextAt.trim() : null;
}

export async function writeReclassifyCooldown(
  spreadsheetId: string,
  triggeredAt: string,
  cooldownMs = 60 * 60 * 1000,
): Promise<string> {
  const drive = getDriveClient();
  const nextAt = new Date(new Date(triggeredAt).getTime() + cooldownMs).toISOString();

  await drive.files.update({
    fileId: spreadsheetId,
    requestBody: {
      appProperties: {
        [RECLASSIFY_NEXT_AT_KEY]: nextAt,
      },
    },
    fields: "id,appProperties",
    supportsAllDrives: true,
  });

  return nextAt;
}
