import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { getAuditSummary } from "@/lib/audit-service";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "./auth/[...nextauth]";

function readSpreadsheetId(query: NextApiRequest["query"]) {
  const value = query?.spreadsheet_id;
  if (typeof value !== "string") {
    return undefined;
  }

  const spreadsheetId = value.trim();
  return spreadsheetId ? spreadsheetId : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const spreadsheetId = readSpreadsheetId(req.query);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "spreadsheet_id is required" });
    }

    await requireProjectAccess(spreadsheetId, session.user.email);

    const payload = await getAuditSummary(spreadsheetId);
    return res.status(200).json(payload);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
