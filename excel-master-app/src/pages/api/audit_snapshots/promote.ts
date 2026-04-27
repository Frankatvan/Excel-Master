import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { AuditSnapshotServiceError, promoteAuditSnapshotToCurrent } from "@/lib/audit-service";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSpreadsheetId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  return readString((body as { spreadsheet_id?: unknown }).spreadsheet_id);
}

function readSnapshotId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  return readString((body as { snapshot_id?: unknown }).snapshot_id);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  const session = await getServerSession(req, res, authOptions);
  const actorEmail = session?.user?.email;
  if (!actorEmail) {
    return res.status(401).json({ error: "未登录" });
  }

  const spreadsheetId = readSpreadsheetId(req.body);
  const snapshotId = readSnapshotId(req.body);
  if (!spreadsheetId || !snapshotId) {
    return res.status(400).json({ error: "缺少 spreadsheet_id 或 snapshot_id" });
  }

  try {
    await requireProjectCollaborator(spreadsheetId, actorEmail);

    const payload = await promoteAuditSnapshotToCurrent({
      spreadsheetId,
      snapshotId,
      actorEmail,
    });
    return res.status(200).json(payload);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    if (error instanceof AuditSnapshotServiceError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "快照切换失败";
    return res.status(500).json({ error: message });
  }
}
