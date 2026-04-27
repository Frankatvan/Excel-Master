import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { getLiveSheetStatus } from "@/lib/live-sheet-status";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "./auth/[...nextauth]";

function readSpreadsheetId(query: NextApiRequest["query"]) {
  const raw = query.spreadsheet_id;
  const spreadsheetId = Array.isArray(raw) ? raw[0] : raw;
  return typeof spreadsheetId === "string" && spreadsheetId.trim() ? spreadsheetId.trim() : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "未登录" });
  }

  const spreadsheetId = readSpreadsheetId(req.query);
  if (!spreadsheetId) {
    return res.status(400).json({ error: "缺少 spreadsheet_id" });
  }

  try {
    await requireProjectAccess(spreadsheetId, session.user.email);

    const liveStatus = await getLiveSheetStatus(spreadsheetId);
    return res.status(200).json({
      status: "success",
      live_status: liveStatus,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "正式表回读失败";
    return res.status(500).json({ error: message });
  }
}
