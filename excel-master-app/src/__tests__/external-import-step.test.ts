import type { NextApiRequest, NextApiResponse } from "next";

import fs from "fs";
import path from "path";

import {
  getJob,
  markJobFailed,
  markJobRunning,
  updateImportManifestStatus,
  updateImportManifestItemStatus,
} from "@/lib/job-service";

jest.mock("@/lib/job-service", () => ({
  getJob: jest.fn(),
  markJobRunning: jest.fn(),
  heartbeatJob: jest.fn(),
  markJobFailed: jest.fn(),
  updateImportManifestStatus: jest.fn(),
  updateImportManifestItemStatus: jest.fn(),
}));

const mockGetJob = getJob as jest.MockedFunction<typeof getJob>;
const mockMarkJobRunning = markJobRunning as jest.MockedFunction<typeof markJobRunning>;
const mockMarkJobFailed = markJobFailed as jest.MockedFunction<typeof markJobFailed>;
const mockUpdateImportManifestStatus = updateImportManifestStatus as jest.MockedFunction<
  typeof updateImportManifestStatus
>;
const mockUpdateImportManifestItemStatus = updateImportManifestItemStatus as jest.MockedFunction<
  typeof updateImportManifestItemStatus
>;
const mockRunExternalImportJobStep = jest.fn();

function loadStepHandler() {
  const stepRunnerPath = path.resolve(__dirname, "../lib/external-import/step-runner.ts");
  if (fs.existsSync(stepRunnerPath)) {
    jest.doMock("@/lib/external-import/step-runner", () => ({
      runExternalImportJobStep: mockRunExternalImportJobStep,
    }));
  }

  return require("../pages/api/external_import/step").default as (
    req: NextApiRequest,
    res: NextApiResponse,
  ) => Promise<void>;
}

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

function readJson(res: NextApiResponse) {
  const jsonMock = res.json as jest.Mock;
  return jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];
}

function reqWithSecret(body: Record<string, unknown>, secret = "worker-secret") {
  return {
    method: "POST",
    headers: { "x-aiwb-worker-secret": secret },
    body,
  } as unknown as NextApiRequest;
}

function queuedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-123",
    spreadsheet_id: "sheet-123",
    job_type: "external_import",
    operation: "external_import",
    status: "queued",
    progress: 0,
    payload: {
      spreadsheet_id: "sheet-123",
      payload_format: "external_import.confirm.async.v1",
      execution_artifact: {
        bucket: "external-import-uploads",
        path: "external-import/sheet-123/async-execution/execution-123/parsed-tables.json",
        format: "external_import.async_execution.chunk_plan.v1",
      },
    },
    ...overrides,
  };
}

describe("/api/external_import/step", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    process.env.EXTERNAL_IMPORT_WORKER_SECRET = "worker-secret";
    mockGetJob.mockResolvedValue(queuedJob() as never);
    mockMarkJobRunning.mockResolvedValue({ id: "job-123", status: "running" } as never);
  });

  afterEach(() => {
    delete process.env.EXTERNAL_IMPORT_WORKER_SECRET;
  });

  it("rejects unauthorized step requests with a JSON error", async () => {
    const req = {
      method: "POST",
      headers: {},
      body: { job_id: "job-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Unauthorized",
    });
    expect(mockGetJob).not.toHaveBeenCalled();
    expect(mockRunExternalImportJobStep).not.toHaveBeenCalled();
  });

  it("returns JSON when worker secret configuration is missing", async () => {
    delete process.env.EXTERNAL_IMPORT_WORKER_SECRET;
    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123" }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      code: "WORKER_SECRET_MISSING",
      message: "External import worker secret is not configured.",
    });
    expect(mockGetJob).not.toHaveBeenCalled();
  });

  it("accepts the worker secret as a bearer token", async () => {
    mockRunExternalImportJobStep.mockResolvedValue({
      status: "running",
      progress: 25,
      cursor: { chunk_index: 0, row_offset: 50 },
      has_next_step: true,
      rows_written: 50,
    } as never);
    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(
      {
        method: "POST",
        headers: { authorization: "Bearer worker-secret" },
        body: { job_id: "job-123" },
      } as unknown as NextApiRequest,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockGetJob).toHaveBeenCalledWith("job-123");
    expect(mockRunExternalImportJobStep).toHaveBeenCalled();
  });

  it("rejects a wrong bearer token before loading the job", async () => {
    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(
      {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret" },
        body: { job_id: "job-123" },
      } as unknown as NextApiRequest,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockGetJob).not.toHaveBeenCalled();
    expect(mockRunExternalImportJobStep).not.toHaveBeenCalled();
  });

  it("marks a queued job running and records initial progress before executing a chunk", async () => {
    mockRunExternalImportJobStep.mockResolvedValue({
      status: "running",
      progress: 25,
      cursor: { chunk_index: 0, row_offset: 50 },
      has_next_step: true,
      rows_written: 50,
      manifest_item_id: "manifest-item-123",
    } as never);

    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123" }), res);

    expect(mockGetJob).toHaveBeenCalledWith("job-123");
    expect(mockMarkJobRunning).toHaveBeenCalledWith({
      jobId: "job-123",
      lockToken: expect.stringMatching(/^external-import-step:/),
      progress: 0,
    });
    expect(mockRunExternalImportJobStep).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "job-123", status: "queued" }),
        maxRowsPerStep: expect.any(Number),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      ok: true,
      job_id: "job-123",
      status: "running",
      progress: 25,
      cursor: { chunk_index: 0, row_offset: 50 },
      has_next_step: true,
      rows_written: 50,
    });
  });

  it("returns the advanced chunk cursor and whether another step exists", async () => {
    mockRunExternalImportJobStep.mockResolvedValue({
      status: "running",
      progress: 60,
      cursor: { chunk_index: 1, row_offset: 0 },
      has_next_step: true,
      rows_written: 75,
      manifest_item_id: "manifest-item-123",
    } as never);

    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123", max_rows_per_step: 75 }), res);

    expect(mockRunExternalImportJobStep).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRowsPerStep: 75,
      }),
    );
    expect(readJson(res)).toEqual(
      expect.objectContaining({
        cursor: { chunk_index: 1, row_offset: 0 },
        has_next_step: true,
      }),
    );
  });

  it("can progress through write chunks and then report validation as the next step", async () => {
    mockRunExternalImportJobStep.mockResolvedValue({
      status: "running",
      progress: 90,
      cursor: null,
      has_next_step: true,
      rows_written: 25,
      manifest_item_id: "manifest-item-123",
      step: {
        kind: "write_chunk",
        index: 3,
        total: 3,
        manifest_item_id: "manifest-item-123",
      },
      next_step: {
        kind: "validation",
        index: 4,
        remaining: 1,
      },
    } as never);

    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123", max_rows_per_step: 25 }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      ok: true,
      advanced: true,
      status: "running",
      progress: 90,
      cursor: null,
      has_next_step: true,
      step: {
        kind: "write_chunk",
        index: 3,
        total: 3,
        manifest_item_id: "manifest-item-123",
      },
      next_step: {
        kind: "validation",
        index: 4,
        remaining: 1,
      },
    });
  });

  it("optionally chains a bounded number of steps in one request", async () => {
    mockRunExternalImportJobStep
      .mockResolvedValueOnce({
        status: "running",
        progress: 50,
        cursor: { chunk_index: 0, row_offset: 50 },
        has_next_step: true,
        rows_written: 50,
        step: { kind: "write_chunk", index: 1, total: 2 },
        next_step: { kind: "write_chunk", index: 2, remaining: 1 },
      } as never)
      .mockResolvedValueOnce({
        status: "succeeded",
        progress: 100,
        cursor: null,
        has_next_step: false,
        rows_written: 0,
        step: { kind: "validation", index: 3, total: 3 },
        next_step: null,
      } as never);

    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123", chain: true, max_steps_per_request: 2 }), res);

    expect(mockRunExternalImportJobStep).toHaveBeenCalledTimes(2);
    expect(readJson(res)).toMatchObject({
      ok: true,
      status: "succeeded",
      steps_advanced: 2,
      has_next_step: false,
      step: { kind: "validation" },
    });
  });

  it.each([
    ["succeeded", 100],
    ["failed", 55],
  ])("returns terminal %s jobs without advancing the runner", async (status, progress) => {
    mockGetJob.mockResolvedValue(
      queuedJob({
        status,
        progress,
        result_meta: {
          current_step: status === "succeeded" ? "complete" : "validation",
          validation: status === "succeeded" ? { ok: true } : { ok: false },
        },
      }) as never,
    );

    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123" }), res);

    expect(mockMarkJobRunning).not.toHaveBeenCalled();
    expect(mockRunExternalImportJobStep).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toEqual({
      ok: true,
      job_id: "job-123",
      status,
      advanced: false,
      step: null,
      next_step: null,
      has_next_step: false,
    });
  });

  it("marks the job, manifest, and current manifest item failed when chunk execution fails", async () => {
    mockRunExternalImportJobStep.mockRejectedValue(new Error("Sheets write failed"));

    const res = createMockRes();
    const stepHandler = loadStepHandler();

    await stepHandler(reqWithSecret({ job_id: "job-123" }), res);

    const expectedError = expect.objectContaining({
      message: "Sheets write failed",
      code: "EXTERNAL_IMPORT_STEP_FAILED",
    });
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expectedError,
    });
    expect(mockUpdateImportManifestStatus).toHaveBeenCalledWith({
      jobId: "job-123",
      status: "failed",
      error: expectedError,
    });
    expect(mockUpdateImportManifestItemStatus).toHaveBeenCalledWith({
      jobId: "job-123",
      status: "failed",
      error: expectedError,
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(readJson(res)).toEqual({
      ok: false,
      error: "Sheets write failed",
      message: "Sheets write failed",
      code: "EXTERNAL_IMPORT_STEP_FAILED",
      job_id: "job-123",
    });
  });
});
