import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import { runExternalImportJobStep, ExternalImportStepError } from "@/lib/external-import/step-runner";
import { externalImportUpstreamErrorDetails } from "@/lib/external-import/upstream-error";
import {
  getJob,
  markJobFailed,
  updateImportManifestItemStatus,
  updateImportManifestStatus,
} from "@/lib/job-service";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import { authOptions } from "../auth/[...nextauth]";

const activeTriggers = new Set<string>();

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBodyString(body: NextApiRequest["body"], key: string) {
  return body && typeof body === "object" ? readString((body as Record<string, unknown>)[key]) : undefined;
}

function readPositiveInteger(value: unknown, fallback: number) {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stepError(error: unknown, jobId?: string) {
  if (typeof ExternalImportStepError === "function" && error instanceof ExternalImportStepError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(jobId ? { job_id: jobId } : {}),
    };
  }
  const details = externalImportUpstreamErrorDetails(error);
  return {
    code: "EXTERNAL_IMPORT_TRIGGER_FAILED",
    message: error instanceof Error && error.message.trim() ? error.message : "External import trigger failed.",
    ...(Object.keys(details).length ? { details } : {}),
    ...(jobId ? { job_id: jobId } : {}),
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "请求方法不支持" });
  }

  try {
    const session = await getServerSession(req, res, authOptions);
    if (!session?.user?.email) {
      return res.status(401).json({ error: "未登录" });
    }

    const spreadsheetId = readBodyString(req.body, "spreadsheet_id");
    const jobId = readBodyString(req.body, "job_id");
    if (!spreadsheetId) {
      return res.status(400).json({ ok: false, code: "SPREADSHEET_ID_REQUIRED", message: "spreadsheet_id is required." });
    }
    if (!jobId) {
      return res.status(400).json({ ok: false, code: "JOB_ID_REQUIRED", message: "job_id is required." });
    }

    await requireProjectCollaborator(spreadsheetId, session.user.email);

    if (activeTriggers.has(jobId)) {
      return res.status(202).json({
        ok: true,
        job_id: jobId,
        status: "running",
        advanced: false,
        concurrency: "in_progress",
        has_next_step: true,
      });
    }

    const job = await getJob(jobId);
    if (!job || job.job_type !== "external_import" || job.spreadsheet_id !== spreadsheetId) {
      return res.status(404).json({
        ok: false,
        code: "EXTERNAL_IMPORT_JOB_NOT_FOUND",
        message: "External import job was not found.",
        job_id: jobId,
      });
    }
    if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
      return res.status(200).json({
        ok: true,
        job_id: job.id,
        status: job.status,
        advanced: false,
        step: null,
        next_step: null,
        has_next_step: false,
      });
    }

    activeTriggers.add(jobId);
    try {
      const maxRowsPerStep = readPositiveInteger(req.body?.max_rows_per_step, 500);
      const maxStepsPerRequest = Math.min(readPositiveInteger(req.body?.max_steps_per_request, 5), 20);
      const startedAt = Date.now();
      const results = [];
      let currentJob = job;
      let stopReason: string | null = null;

      for (let stepIndex = 0; stepIndex < maxStepsPerRequest; stepIndex += 1) {
        const result = await runExternalImportJobStep({ job: currentJob, maxRowsPerStep });
        results.push(result);
        if (!result.has_next_step || result.status === "succeeded" || result.status === "failed") {
          break;
        }
        if (Date.now() - startedAt > 25_000) {
          stopReason = "time_budget";
          break;
        }
        currentJob = {
          ...currentJob,
          status: result.status,
          progress: result.progress,
          result_meta: {
            ...(currentJob.result_meta ?? {}),
            current_step: result.next_step?.kind === "validation" ? "validation" : "write_chunk",
            cursor: result.cursor,
          },
        };
      }

      const result = results[results.length - 1];
      return res.status(200).json({
        ok: true,
        job_id: job.id,
        advanced: results.length > 0,
        steps_advanced: results.length,
        ...(stopReason ? { chain_stopped_reason: stopReason } : {}),
        ...result,
      });
    } finally {
      activeTriggers.delete(jobId);
    }
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    const jobId = readBodyString(req.body, "job_id");
    const failure = stepError(error, jobId);
    if (jobId) {
      await markJobFailed({ jobId, error: failure });
      await updateImportManifestStatus({ jobId, status: "failed", error: failure });
      await updateImportManifestItemStatus({ jobId, status: "failed", error: failure });
    }
    return res.status(500).json({
      ok: false,
      error: failure.message,
      message: failure.message,
      code: failure.code,
      ...(jobId ? { job_id: jobId } : {}),
      ...("details" in failure ? { details: failure.details } : {}),
    });
  }
}
