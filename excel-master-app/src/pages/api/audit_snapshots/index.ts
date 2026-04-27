import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { AuditSnapshotServiceError, listAuditSnapshots } from "@/lib/audit-service";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

function readQueryValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readSpreadsheetId(query: NextApiRequest["query"]) {
  const value = readQueryValue(query?.spreadsheet_id);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLimit(query: NextApiRequest["query"]) {
  const value = readQueryValue(query?.limit);
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
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

    const payload = await listAuditSnapshots(spreadsheetId, readLimit(req.query));
    return res.status(200).json(payload);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    if (error instanceof AuditSnapshotServiceError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "快照历史加载失败";
    return res.status(500).json({ error: message });
  }
}
