import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { getProjectState } from "@/lib/project-state-sheet";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

function readQueryValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function readSpreadsheetId(query: NextApiRequest["query"]) {
  const value = readQueryValue(query.spreadsheet_id);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  const session = await getServerSession(req, res, authOptions);
  const actorEmail = session?.user?.email;
  if (!actorEmail) {
    return res.status(401).json({ error: "未登录" });
  }

  const spreadsheetId = readSpreadsheetId(req.query);
  if (!spreadsheetId) {
    return res.status(400).json({ error: "缺少 spreadsheet_id" });
  }

  try {
    const access = await requireProjectAccess(spreadsheetId, actorEmail);

    const state = await getProjectState(spreadsheetId, actorEmail);
    return res.status(200).json({
      state: {
        ...state,
        can_write: access.canWrite,
        drive_role: access.driveRole,
        is_drive_owner: access.isDriveOwner,
        is_owner_or_admin: access.isDriveOwner,
      },
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "读取项目状态失败" });
  }
}
