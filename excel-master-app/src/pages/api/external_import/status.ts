import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { getExternalImportStatus } from "@/lib/external-import/import-manifest-service";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readQueryString(req: NextApiRequest, key: string) {
  const value = req.query[key];
  const raw = Array.isArray(value) ? value[0] : value;
  return readString(raw);
}

function isExternalImportWorkerConfigured() {
  return Boolean(process.env.EXTERNAL_IMPORT_WORKER_URL?.trim() && process.env.EXTERNAL_IMPORT_WORKER_SECRET?.trim());
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

    const spreadsheetId = readQueryString(req, "spreadsheet_id");
    if (!spreadsheetId) {
      return res.status(400).json({ error: "缺少 spreadsheet_id" });
    }

    await requireProjectAccess(spreadsheetId, session.user.email);

    const status = await getExternalImportStatus({
      spreadsheetId,
      jobId: readQueryString(req, "job_id"),
    });

    return res.status(200).json({
      ...status,
      worker_configured: isExternalImportWorkerConfigured(),
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "外部导入状态读取失败";
    return res.status(500).json({ error: message });
  }
}
