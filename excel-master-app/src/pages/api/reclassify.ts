import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { syncAuditSummary } from "@/lib/audit-service";
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

function readHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function resolveWorkerUrl(req: NextApiRequest) {
  const configuredUrl = process.env.RECLASSIFY_WORKER_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const forwardedProto = readHeaderValue(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto || (req.socket.encrypted ? "https" : "http");
  const forwardedHost = readHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost || readHeaderValue(req.headers.host);
  const origin = host ? `${proto}://${host}` : `${proto}://localhost`;

  return new URL("/api/reclassify_job", origin).toString();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const spreadsheetId = readSpreadsheetId(req.body);
  if (!spreadsheetId) {
    return res.status(400).json({ error: "spreadsheet_id is required" });
  }

  try {
    const workerUrl = resolveWorkerUrl(req);
    const workerResponse = await fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ spreadsheet_id: spreadsheetId }),
    });

    if (!workerResponse.ok) {
      const errorBody = await workerResponse.json().catch(() => null);
      const message =
        (errorBody && typeof errorBody === "object" && typeof errorBody.message === "string" && errorBody.message) ||
        `Worker request failed with status ${workerResponse.status}`;
      return res.status(502).json({ error: message });
    }

    const workerBody = (await workerResponse.json().catch(() => ({}))) as {
      message?: unknown;
      triggered_at?: unknown;
      summary?: unknown;
    };
    const syncResult = await syncAuditSummary(spreadsheetId);

    return res.status(200).json({
      ok: true,
      mode: "worker",
      message:
        typeof workerBody.message === "string" && workerBody.message.trim()
          ? workerBody.message
          : "Reclassify job submitted successfully.",
      spreadsheet_id: spreadsheetId,
      triggered_at:
        typeof workerBody.triggered_at === "string" && workerBody.triggered_at.trim()
          ? workerBody.triggered_at
          : new Date().toISOString(),
      last_synced_at: syncResult.last_synced_at,
      summary: workerBody.summary ?? syncResult.snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker request failed";
    return res.status(502).json({ error: message });
  }
}
