import type { NextApiRequest, NextApiResponse } from "next";

import { randomUUID } from "crypto";

import { runExternalImportJobStep, ExternalImportStepError } from "@/lib/external-import/step-runner";
import {
  getJob,
  markJobFailed,
  markJobRunning,
  updateImportManifestItemStatus,
  updateImportManifestStatus,
} from "@/lib/job-service";

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

function readBoolean(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function readHeader(req: NextApiRequest, header: string) {
  const value = req.headers[header.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(req: NextApiRequest) {
  const expected = process.env.EXTERNAL_IMPORT_WORKER_SECRET?.trim();
  if (!expected) {
    return { ok: false as const, status: 500, code: "WORKER_SECRET_MISSING", message: "External import worker secret is not configured." };
  }
  const provided = readHeader(req, "x-aiwb-worker-secret") || readHeader(req, "authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) {
    return { ok: false as const, status: 401, code: "UNAUTHORIZED", message: "Unauthorized" };
  }
  return { ok: true as const };
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
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return {
      code: (error as { code: string }).code,
      message: error.message,
      ...("details" in error && typeof (error as { details?: unknown }).details === "object"
        ? { details: (error as { details?: Record<string, unknown> }).details }
        : {}),
      ...(jobId ? { job_id: jobId } : {}),
    };
  }
  return {
    code: "EXTERNAL_IMPORT_STEP_FAILED",
    message: error instanceof Error && error.message.trim() ? error.message : "External import step failed.",
    ...(jobId ? { job_id: jobId } : {}),
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED", message: "请求方法不支持" });
  }

  const auth = isAuthorized(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, code: auth.code, message: auth.message });
  }

  const jobId = readBodyString(req.body, "job_id");
  if (!jobId) {
    return res.status(400).json({ ok: false, code: "JOB_ID_REQUIRED", message: "job_id is required." });
  }

  const job = await getJob(jobId);
  if (!job || job.job_type !== "external_import") {
    return res.status(404).json({ ok: false, code: "EXTERNAL_IMPORT_JOB_NOT_FOUND", message: "External import job was not found.", job_id: jobId });
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

  try {
    if (job.status === "queued") {
      await markJobRunning({
        jobId: job.id,
        lockToken: `external-import-step:${randomUUID()}`,
        progress: typeof job.progress === "number" ? job.progress : 0,
      });
    }

    const maxRowsPerStep = readPositiveInteger(req.body?.max_rows_per_step, 500);
    const chain = readBoolean(req.body?.chain);
    const maxStepsPerRequest = Math.min(readPositiveInteger(req.body?.max_steps_per_request, 1), 20);
    const startedAt = Date.now();
    const results = [];
    let currentJob = job;
    let stopReason: string | null = null;

    for (let stepIndex = 0; stepIndex < maxStepsPerRequest; stepIndex += 1) {
      const result = await runExternalImportJobStep({
        job: currentJob,
        maxRowsPerStep,
      });
      results.push(result);

      if (!chain || !result.has_next_step || result.status === "succeeded" || result.status === "failed") {
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
      advanced: true,
      steps_advanced: results.length,
      ...(stopReason ? { chain_stopped_reason: stopReason } : {}),
      ...result,
    });
  } catch (error) {
    const failure = stepError(error, job.id);
    await markJobFailed({
      jobId: job.id,
      error: failure,
    });
    await updateImportManifestStatus({
      jobId: job.id,
      status: "failed",
      error: failure,
    });
    await updateImportManifestItemStatus({
      jobId: job.id,
      status: "failed",
      error: failure,
    });

    return res.status(500).json({
      ok: false,
      error: failure.message,
      message: failure.message,
      code: failure.code,
      job_id: job.id,
      ...("details" in failure ? { details: failure.details } : {}),
    });
  }
}
