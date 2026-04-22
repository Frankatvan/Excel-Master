import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { syncAuditSummary } from "@/lib/audit-service";
import { authOptions } from "./auth/[...nextauth]";

function readSpreadsheetId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const value = (body as { spreadsheet_id?: unknown }).spreadsheet_id;
  if (typeof value !== "string") {
    return undefined;
  }

  const spreadsheetId = value.trim();
  return spreadsheetId ? spreadsheetId : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const spreadsheetId = readSpreadsheetId(req.body);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "spreadsheet_id is required" });
    }

    const payload = await syncAuditSummary(spreadsheetId);
    return res.status(200).json({
      status: "success",
      spreadsheet_id: payload.spreadsheetId,
      last_synced_at: payload.last_synced_at,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
