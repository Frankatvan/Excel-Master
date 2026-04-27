import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

export const config = {
  api: {
    bodyParser: false,
  },
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSpreadsheetId(req: NextApiRequest) {
  const bodyValue =
    req.body && typeof req.body === "object"
      ? (req.body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheetId ??
        (req.body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheet_id
      : undefined;
  const queryValue = Array.isArray(req.query?.spreadsheet_id) ? req.query.spreadsheet_id[0] : req.query?.spreadsheet_id;
  return readString(bodyValue) ?? readString(queryValue);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "未登录" });
    }

    const spreadsheetId = readSpreadsheetId(req);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "缺少 spreadsheet_id" });
    }

    await requireProjectCollaborator(spreadsheetId, session.user.email);

    return res.status(501).json({ error: "External import preview is not implemented yet." });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "外部导入预览失败";
    return res.status(500).json({ error: message });
  }
}
