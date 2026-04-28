import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { createExternalImportUploadReservations } from "@/lib/external-import/upload-storage";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSpreadsheetId(body: unknown) {
  return body && typeof body === "object"
    ? readString((body as { spreadsheet_id?: unknown; spreadsheetId?: unknown }).spreadsheet_id) ??
        readString((body as { spreadsheet_id?: unknown; spreadsheetId?: unknown }).spreadsheetId)
    : undefined;
}

function readUploadFiles(body: unknown) {
  const files = body && typeof body === "object" ? (body as { files?: unknown }).files : undefined;
  if (!Array.isArray(files)) {
    return [];
  }

  return files.flatMap((file) => {
    if (!file || typeof file !== "object") {
      return [];
    }
    const candidate = file as {
      file_name?: unknown;
      name?: unknown;
      content_type?: unknown;
      type?: unknown;
      size?: unknown;
    };
    const fileName = readString(candidate.file_name) ?? readString(candidate.name);
    if (!fileName) {
      return [];
    }
    return [
      {
        fileName,
        contentType: readString(candidate.content_type) ?? readString(candidate.type),
        size: typeof candidate.size === "number" ? candidate.size : undefined,
      },
    ];
  });
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

    const spreadsheetId = readSpreadsheetId(req.body);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "缺少 spreadsheet_id" });
    }

    await requireProjectCollaborator(spreadsheetId, session.user.email);

    const files = readUploadFiles(req.body);
    if (files.length === 0) {
      return res.status(400).json({ error: "缺少待上传文件", code: "NO_IMPORT_FILES" });
    }

    const reservations = await createExternalImportUploadReservations({
      spreadsheetId,
      files,
    });

    return res.status(200).json({
      status: "upload_ready",
      spreadsheet_id: spreadsheetId,
      bucket: reservations[0]?.bucket,
      files: reservations,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "外部导入上传初始化失败";
    return res.status(500).json({ error: message });
  }
}
