import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { classifyAuditSyncRun, getLatestAuditSyncRunStatus } from "@/lib/audit-service";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "./auth/[...nextauth]";

function readSpreadsheetId(query: NextApiRequest["query"]) {
  const value = query?.spreadsheet_id;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function readSyncRunId(query: NextApiRequest["query"]) {
  const value = query?.sync_run_id;
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "未登录" });
    }

    const spreadsheetId = readSpreadsheetId(req.query);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "缺少 spreadsheet_id" });
    }

    await requireProjectAccess(spreadsheetId, session.user.email);

    const payload = await getLatestAuditSyncRunStatus(spreadsheetId, readSyncRunId(req.query));
    const latestRun = payload.latest_run;
    if (!latestRun) {
      return res.status(200).json(payload);
    }

    const effectiveStatus = classifyAuditSyncRun({
      status: latestRun.status,
      started_at: (latestRun as { started_at?: string }).started_at || latestRun.created_at,
      created_at: latestRun.created_at,
      finished_at: latestRun.finished_at,
    });
    const effectiveRun = {
      ...latestRun,
      started_at: (latestRun as { started_at?: string }).started_at || latestRun.created_at,
      status: effectiveStatus,
    };

    return res.status(200).json({
      ...payload,
      latest_run: effectiveRun,
      status: effectiveStatus,
      run: effectiveRun,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "同步状态读取失败";
    return res.status(500).json({ error: message });
  }
}
