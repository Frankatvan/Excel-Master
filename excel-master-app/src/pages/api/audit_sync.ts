import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";
import { after } from "next/server";

import { startAuditSummarySync, syncAuditSummary } from "@/lib/audit-service";
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

function readHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function shouldRunAsync(body: NextApiRequest["body"]) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const candidate = body as { mode?: unknown; async?: unknown };
  return candidate.mode === "async" || candidate.async === true;
}

function resolveWorkerUrl(req: NextApiRequest) {
  const configuredUrl = process.env.RECLASSIFY_WORKER_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const forwardedProto = readHeaderValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto || ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const forwardedHost = readHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost || readHeaderValue(req.headers.host);
  const origin = host ? `${proto}://${host}` : `${proto}://localhost`;

  return new URL("/api/internal/reclassify_job", origin).toString();
}

function fallbackValidation(message: string): AuditValidationPayload {
  return {
    status: "failed",
    checked_at: new Date().toISOString(),
    message,
  };
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

async function runValidation(req: NextApiRequest, spreadsheetId: string): Promise<AuditValidationPayload> {
  try {
    const workerResponse = await fetch(resolveWorkerUrl(req), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spreadsheet_id: spreadsheetId,
        validate_only: true,
      }),
    });

    const workerBody = (await workerResponse.json().catch(() => ({}))) as {
      message?: unknown;
      validation?: unknown;
    };

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

    if (shouldRunAsync(req.body)) {
      const started = await startAuditSummarySync(spreadsheetId);
      after(async () => {
        await runValidation(req, spreadsheetId).catch((error) => {
          console.error("[Audit] async audit_sync validation failed:", error);
        });
        await started.run().catch((error) => {
          console.error("[Audit] async audit_sync failed:", error);
        });
      });
      return res.status(202).json({
        status: "accepted",
        mode: "async",
        spreadsheet_id: spreadsheetId,
        sync_run_id: started.sync_run_id,
        message: "同步已开始，后台完成后会刷新快照",
      });
    }

    const validation = await runValidation(req, spreadsheetId);
    const payload = await syncAuditSummary(spreadsheetId);
    return res.status(200).json({
      status: "success",
      spreadsheet_id: payload.spreadsheetId,
      last_synced_at: payload.last_synced_at,
      validation,
    });
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message : "同步失败";
    console.error("[Audit] audit_sync failed:", error);
    return res.status(500).json({ error: message });
  }
}
