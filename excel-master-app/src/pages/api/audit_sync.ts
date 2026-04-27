import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { startAuditSummarySync } from "@/lib/audit-service";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { resolveTrustedWorkerUrl } from "@/lib/trusted-worker-url";
import { authOptions } from "./auth/[...nextauth]";

type AuditValidationPayload = {
  status: "ok" | "mismatch" | "failed";
  checked_at: string;
  message: string;
  totals?: {
    total_rows: number;
    matched_rows: number;
    mismatch_count: number;
  };
  sheets?: {
    payable?: { mismatch_count: number };
    final_detail?: { mismatch_count: number };
  };
  sample_mismatches?: Array<Record<string, unknown>>;
};

type WorkerResponseBody = Record<string, unknown> & {
  message?: unknown;
  validation?: unknown;
};

class AuditSyncWorkerError extends Error {
  statusCode: number;
  errorCode: string;
  details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, errorCode: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AuditSyncWorkerError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

function readSpreadsheetId(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const value = (body as { spreadsheet_id?: unknown }).spreadsheet_id;
  if (typeof value !== "string") {
    return undefined;
  }

  const spreadsheetId = value.trim();
  return spreadsheetId ? spreadsheetId : undefined;
}

function resolveReclassifyWorkerSecret() {
  return process.env.RECLASSIFY_WORKER_SECRET?.trim() || process.env.AIWB_WORKER_SECRET?.trim() || undefined;
}

function fallbackValidation(message: string): AuditValidationPayload {
  return {
    status: "failed",
    checked_at: new Date().toISOString(),
    message,
  };
}

function readWorkerMessage(body: WorkerResponseBody, fallback: string) {
  return typeof body.message === "string" && body.message.trim() ? body.message.trim() : fallback;
}

function normalizeProjectRunLock(message: string) {
  const match = message.match(/PROJECT_RUN_LOCKED:([A-Za-z0-9_-]+)/);
  if (!match) {
    return undefined;
  }

  const activeOperation = match[1] || "other_write_run";
  return new AuditSyncWorkerError("已有任务运行中：" + activeOperation, 409, "PROJECT_RUN_LOCKED", {
    active_operation: activeOperation,
  });
}

function normalizeWorkerFailure(status: number, body: WorkerResponseBody, fallback: string) {
  const message = readWorkerMessage(body, fallback);
  const locked = normalizeProjectRunLock(message);
  if (locked) {
    return locked;
  }

  return new AuditSyncWorkerError(message, status >= 400 && status < 500 ? status : 502, "WORKER_FAILED");
}

function normalizeValidationPayload(payload: unknown): AuditValidationPayload {
  if (!payload || typeof payload !== "object") {
    return fallbackValidation("校验返回无效");
  }

  const candidate = payload as {
    status?: unknown;
    checked_at?: unknown;
    message?: unknown;
    totals?: unknown;
    sheets?: unknown;
    sample_mismatches?: unknown;
  };

  const status =
    candidate.status === "ok" || candidate.status === "mismatch" || candidate.status === "failed"
      ? candidate.status
      : "failed";
  const checked_at =
    typeof candidate.checked_at === "string" && candidate.checked_at.trim()
      ? candidate.checked_at
      : new Date().toISOString();
  const message =
    typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message
      : status === "ok"
        ? "重分类校验通过"
        : "重分类校验失败";

  return {
    status,
    checked_at,
    message,
    totals:
      candidate.totals && typeof candidate.totals === "object"
        ? (candidate.totals as AuditValidationPayload["totals"])
        : undefined,
    sheets:
      candidate.sheets && typeof candidate.sheets === "object"
        ? (candidate.sheets as AuditValidationPayload["sheets"])
        : undefined,
    sample_mismatches: Array.isArray(candidate.sample_mismatches) ? candidate.sample_mismatches : undefined,
  };
}

async function runValidation(
  workerUrl: string,
  spreadsheetId: string,
  workerSecret: string,
): Promise<AuditValidationPayload> {
  try {
    const workerResponse = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AiWB-Worker-Secret": workerSecret,
      },
      body: JSON.stringify({
        spreadsheet_id: spreadsheetId,
        operation: "validate",
      }),
    });

    const workerBody = (await workerResponse.json().catch(() => ({}))) as WorkerResponseBody;

    if (!workerResponse.ok) {
      const message =
        typeof workerBody.message === "string" && workerBody.message.trim()
          ? workerBody.message
          : `重分类校验服务异常 (${workerResponse.status})`;
      return fallbackValidation(message);
    }

    return normalizeValidationPayload(workerBody.validation);
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message : "重分类校验失败";
    return fallbackValidation(message);
  }
}

async function runSchemaMigration(workerUrl: string, spreadsheetId: string, workerSecret: string) {
  const workerResponse = await fetch(workerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AiWB-Worker-Secret": workerSecret,
    },
    body: JSON.stringify({
      spreadsheet_id: spreadsheetId,
      operation: "ensure_final_gmp_schema",
    }),
  });

  const workerBody = (await workerResponse.json().catch(() => ({}))) as WorkerResponseBody;
  if (!workerResponse.ok) {
    throw normalizeWorkerFailure(
      workerResponse.status,
      workerBody,
      `Final GMP schema migration failed (${workerResponse.status})`,
    );
  }

  return workerBody;
}

function runAuditSyncInBackground(run: () => Promise<unknown>, syncRunId: string | null) {
  void run().catch((error) => {
    console.error("[Audit] background audit_sync failed", {
      sync_run_id: syncRunId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

function isAuditSnapshotServiceError(error: unknown): error is { statusCode: number; code: string; message: string } {
  return (
    error instanceof Error &&
    error.name === "AuditSnapshotServiceError" &&
    typeof (error as { statusCode?: unknown }).statusCode === "number" &&
    typeof (error as { code?: unknown }).code === "string"
  );
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
    const workerSecret = resolveReclassifyWorkerSecret();
    if (!workerSecret) {
      return res.status(500).json({ error: "Worker secret is not configured." });
    }
    const workerUrl = resolveTrustedWorkerUrl(process.env.RECLASSIFY_WORKER_URL, "/api/internal/reclassify_job");
    if (!workerUrl) {
      return res.status(500).json({ error: "Worker URL is not configured." });
    }

    const schemaMigration = await runSchemaMigration(workerUrl, spreadsheetId, workerSecret);
    const validation = await runValidation(workerUrl, spreadsheetId, workerSecret);
    const started = await startAuditSummarySync(spreadsheetId);
    runAuditSyncInBackground(started.run, started.sync_run_id);

    return res.status(202).json({
      status: "accepted",
      mode: "async",
      spreadsheet_id: started.spreadsheetId,
      sync_run_id: started.sync_run_id,
      schema_migration: schemaMigration,
      validation,
      message: "同步已开始，后台完成后会刷新快照",
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    if (error instanceof AuditSyncWorkerError) {
      return res.status(error.statusCode).json({
        error: error.errorCode,
        message: error.message,
        details: error.details ?? null,
      });
    }
    if (isAuditSnapshotServiceError(error)) {
      return res.status(error.statusCode).json({
        error: error.code,
        message: error.message,
      });
    }
    const message = error instanceof Error && error.message.trim() ? error.message : "同步失败";
    console.error("[Audit] audit_sync failed:", error);
    return res.status(500).json({ error: message });
  }
}
