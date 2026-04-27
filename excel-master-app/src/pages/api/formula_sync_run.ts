import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { getLiveSheetStatus } from "@/lib/live-sheet-status";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { getProject109Title } from "@/lib/project-109-sheet";
import { resolveTrustedWorkerUrl } from "@/lib/trusted-worker-url";
import { authOptions } from "./auth/[...nextauth]";

function readSpreadsheetId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const spreadsheetId =
    (body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheetId ??
    (body as { spreadsheetId?: unknown; spreadsheet_id?: unknown }).spreadsheet_id;

  return typeof spreadsheetId === "string" && spreadsheetId.trim() ? spreadsheetId.trim() : undefined;
}

function resolveFormulaSyncWorkerSecret() {
  return process.env.FORMULA_SYNC_WORKER_SECRET?.trim() || process.env.AIWB_WORKER_SECRET?.trim() || undefined;
}

async function parseWorkerBody(response: Response) {
  const raw = await response.text();
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { message: raw };
  }
}

function normalizeWorkerError(status: number, body: Record<string, unknown> | null) {
  const rawMessage = typeof body?.message === "string" ? body.message : "";
  const rawError = typeof body?.error === "string" ? body.error : "";
  const rawCode = typeof body?.code === "string" ? body.code : "";
  const combined = rawCode || rawError || rawMessage;
  const projectRunLockMatch = combined.match(/PROJECT_RUN_LOCKED:([A-Za-z0-9_-]+)/);

  if (projectRunLockMatch) {
    const activeOperation = projectRunLockMatch[1] || "other_write_run";
    return {
      status: 409,
      body: {
        error: "PROJECT_RUN_LOCKED",
        message: `已有任务运行中：${activeOperation}`,
        details: {
          active_operation: activeOperation,
        },
      },
    };
  }

  if (status === 409 && rawMessage.startsWith("SNAPSHOT_STALE_ERROR")) {
    return {
      status: 409,
      body: {
        error: "SNAPSHOT_STALE_ERROR",
        message: rawMessage,
      },
    };
  }

  if (status === 401) {
    return {
      status: 502,
      body: {
        error: "WORKER_UNAUTHORIZED",
        message: "Worker authorization failed.",
      },
    };
  }

  if (rawMessage === "Worker secret is not configured.") {
    return {
      status: 500,
      body: {
        error: "WORKER_SECRET_MISSING",
        message: rawMessage,
      },
    };
  }

  return {
    status: 502,
    body: {
      error: "WORKER_FAILED",
      message: rawMessage || "Worker request failed.",
    },
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "请求方法不支持" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "未登录" });
  }

  const spreadsheetId = readSpreadsheetId(req.body);
  if (!spreadsheetId) {
    return res.status(400).json({ error: "缺少 spreadsheet_id" });
  }

  try {
    await requireProjectCollaborator(spreadsheetId, session.user.email);
    const workerSecret = resolveFormulaSyncWorkerSecret();
    if (!workerSecret) {
      return res.status(500).json({ error: "Worker secret is not configured." });
    }

    const sheet109Title = await getProject109Title(spreadsheetId);
    const workerUrl = resolveTrustedWorkerUrl(process.env.FORMULA_SYNC_WORKER_URL, "/api/formula_sync");
    if (!workerUrl) {
      return res.status(500).json({ error: "Worker URL is not configured." });
    }
    const workerResponse = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AiWB-Worker-Secret": workerSecret,
      },
      body: JSON.stringify({
        spreadsheet_id: spreadsheetId,
        project_id: spreadsheetId,
        sheet_109_title: sheet109Title,
      }),
    });
    const workerBody = await parseWorkerBody(workerResponse);

    if (!workerResponse.ok) {
      const normalizedError = normalizeWorkerError(workerResponse.status, workerBody);
      return res.status(normalizedError.status).json(normalizedError.body);
    }

    const liveStatus = await getLiveSheetStatus(spreadsheetId);
    const message =
      typeof workerBody.message === "string" && workerBody.message.trim()
        ? workerBody.message
        : "主表与保护规则已同步";

    return res.status(200).json({
      status: "success",
      message,
      spreadsheet_id: spreadsheetId,
      verify: workerBody.verify ?? null,
      live_status: liveStatus,
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "主表同步失败";
    return res.status(502).json({ error: message });
  }
}
