import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import {
  buildPreviewPayload,
  hashFileBuffer,
  savePreviewPayload,
} from "@/lib/external-import/preview-store";
import { parseWorkbookBuffer } from "@/lib/external-import/workbook-parser";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

export const config = {
  api: {
    bodyParser: false,
  },
};

interface UploadedWorkbookBuffer {
  name: string;
  buffer: Buffer;
}

const MAX_PREVIEW_BODY_BYTES = 20 * 1024 * 1024;

class PreviewBodyTooLargeError extends Error {
  constructor() {
    super("External import preview payload is too large.");
    this.name = "PreviewBodyTooLargeError";
  }
}

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

async function readRequestBody(req: NextApiRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body) as Record<string, unknown>;
  }

  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PREVIEW_BODY_BYTES) {
    throw new PreviewBodyTooLargeError();
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_PREVIEW_BODY_BYTES) {
      throw new PreviewBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  return rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
}

function bufferFromUnknown(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Buffer.from(value);
  }
  return undefined;
}

function readUploadedWorkbooks(body: Record<string, unknown>): UploadedWorkbookBuffer[] {
  const files = Array.isArray(body.files) ? body.files : [];
  const buffers = Array.isArray(body.buffers) ? body.buffers : [];
  const inputs = [...files, ...buffers];

  return inputs.flatMap<UploadedWorkbookBuffer>((item, index) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as {
      name?: unknown;
      file_name?: unknown;
      content_base64?: unknown;
      buffer?: unknown;
    };
    const name = readString(candidate.file_name) ?? readString(candidate.name) ?? `workbook-${index + 1}.xlsx`;
    const buffer =
      typeof candidate.content_base64 === "string"
        ? Buffer.from(candidate.content_base64, "base64")
        : bufferFromUnknown(candidate.buffer);

    return buffer ? [{ name, buffer }] : [];
  });
}

function isExternalImportWorkerConfigured() {
  return Boolean(process.env.EXTERNAL_IMPORT_WORKER_URL?.trim() && process.env.EXTERNAL_IMPORT_WORKER_SECRET?.trim());
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

    // TODO: Wire the multipart adapter here when the upload UI is ready. The MVP accepts JSON/base64
    // and direct Buffer-shaped test inputs while bodyParser remains disabled.
    const body = await readRequestBody(req);
    req.body = body;
    const spreadsheetId = readSpreadsheetId(req);
    if (!spreadsheetId) {
      return res.status(400).json({ error: "缺少 spreadsheet_id" });
    }

    await requireProjectCollaborator(spreadsheetId, session.user.email);

    const uploads = readUploadedWorkbooks(body);
    if (uploads.length === 0) {
      return res.status(400).json({ error: "缺少可解析的上传文件", code: "NO_IMPORT_FILES" });
    }

    const parsedWorkbooks = uploads.map((upload) => parseWorkbookBuffer(upload.buffer, upload.name));
    const previewPayload = buildPreviewPayload({
      spreadsheetId,
      parsedWorkbooks,
      fileHashes: uploads.map((upload) => hashFileBuffer(upload.buffer)),
      workerConfigured: isExternalImportWorkerConfigured(),
    });
    savePreviewPayload(previewPayload);

    return res.status(200).json(previewPayload);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    if (error instanceof PreviewBodyTooLargeError) {
      return res.status(413).json({ error: error.message, code: "IMPORT_PREVIEW_PAYLOAD_TOO_LARGE" });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "外部导入预览失败";
    return res.status(500).json({ error: message });
  }
}
