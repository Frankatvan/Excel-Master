import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { AuditSnapshotServiceError, getAuditSnapshotDiff } from "@/lib/audit-service";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

function readQueryValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readRequiredQueryString(query: NextApiRequest["query"], key: "spreadsheet_id" | "target_snapshot_id") {
  const value = readQueryValue(query?.[key]);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalQueryString(query: NextApiRequest["query"], key: "current_snapshot_id") {
  const value = readQueryValue(query?.[key]);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

  const spreadsheetId = readRequiredQueryString(req.query, "spreadsheet_id");
  const targetSnapshotId = readRequiredQueryString(req.query, "target_snapshot_id");
  if (!spreadsheetId || !targetSnapshotId) {
    return res.status(400).json({ error: "缺少 spreadsheet_id 或 target_snapshot_id" });
  }

  try {
    await requireProjectAccess(spreadsheetId, session.user.email);

    const payload = await getAuditSnapshotDiff({
      spreadsheetId,
      targetSnapshotId,
      currentSnapshotId: readOptionalQueryString(req.query, "current_snapshot_id"),
    });
    return res.status(200).json(payload);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    if (error instanceof AuditSnapshotServiceError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "快照差异预览失败";
    return res.status(500).json({ error: message });
  }
}
