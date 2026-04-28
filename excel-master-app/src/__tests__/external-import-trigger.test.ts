import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import triggerHandler from "../pages/api/external_import/trigger";
import { runExternalImportJobStep } from "@/lib/external-import/step-runner";
import { getJob } from "@/lib/job-service";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/project-access", () => {
  class ProjectAccessError extends Error {
    statusCode: number;
    code: string;

    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = "ProjectAccessError";
      this.statusCode = statusCode;
      this.code = code;
      Object.setPrototypeOf(this, ProjectAccessError.prototype);
    }
  }

  return {
    ProjectAccessError,
    requireProjectCollaborator: jest.fn(),
  };
});

jest.mock("@/lib/job-service", () => ({
  getJob: jest.fn(),
}));

jest.mock("@/lib/external-import/step-runner", () => ({
  runExternalImportJobStep: jest.fn(),
  ExternalImportStepError: class ExternalImportStepError extends Error {
    code: string;
    details?: Record<string, unknown>;

    constructor(code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockGetJob = getJob as jest.MockedFunction<typeof getJob>;
const mockRunExternalImportJobStep = runExternalImportJobStep as jest.MockedFunction<typeof runExternalImportJobStep>;

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

function req(body: Record<string, unknown>) {
  return {
    method: "POST",
    body,
  } as unknown as NextApiRequest;
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-123",
    spreadsheet_id: "sheet-123",
    job_type: "external_import",
    status: "running",
    progress: 25,
    payload: {
      spreadsheet_id: "sheet-123",
      execution_artifact: {
        bucket: "external-import-uploads",
        path: "external-import/sheet-123/async-execution/execution-123/parsed-tables.json",
        format: "external_import.async_execution.chunk_plan.v1",
      },
    },
    result_meta: { cursor: { chunk_index: 0, row_offset: 50 } },
    ...overrides,
  };
}

describe("/api/external_import/trigger", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { email: "writer@example.com" } } as never);
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      driveRole: "writer",
      isDriveOwner: false,
    });
    mockGetJob.mockResolvedValue(job() as never);
    mockRunExternalImportJobStep.mockResolvedValue({
      status: "running",
      progress: 55,
      cursor: { chunk_index: 0, row_offset: 100 },
      has_next_step: true,
      rows_written: 50,
      step: { kind: "write_chunk", index: 2, total: 5 },
      next_step: { kind: "write_chunk", index: 3, remaining: 3 },
    } as never);
  });

  it("lets collaborators trigger a bounded external import step chain", async () => {
    const res = createMockRes();

    await triggerHandler(req({ spreadsheet_id: "sheet-123", job_id: "job-123", max_steps_per_request: 3 }), res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "writer@example.com");
    expect(mockRunExternalImportJobStep).toHaveBeenCalledTimes(3);
    expect(mockRunExternalImportJobStep).toHaveBeenCalledWith(
      expect.objectContaining({
        job: expect.objectContaining({ id: "job-123" }),
        maxRowsPerStep: expect.any(Number),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      ok: true,
      job_id: "job-123",
      advanced: true,
      steps_advanced: 3,
      status: "running",
      progress: 55,
      has_next_step: true,
    });
  });

  it("rejects readers and commenters before triggering writes", async () => {
    mockGetServerSession.mockResolvedValue({ user: { email: "reader@example.com" } } as never);
    mockRequireProjectCollaborator.mockRejectedValue(
      new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN"),
    );
    const res = createMockRes();

    await triggerHandler(req({ spreadsheet_id: "sheet-123", job_id: "job-123" }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(readJson(res)).toEqual({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
    expect(mockGetJob).not.toHaveBeenCalled();
    expect(mockRunExternalImportJobStep).not.toHaveBeenCalled();
  });

  it("serializes concurrent in-process triggers for the same job", async () => {
    let releaseStep!: () => void;
    mockRunExternalImportJobStep.mockReturnValue(
      new Promise((resolve) => {
        releaseStep = () =>
          resolve({
            status: "running",
            progress: 60,
            cursor: { chunk_index: 0, row_offset: 150 },
            has_next_step: true,
            rows_written: 50,
            step: { kind: "write_chunk", index: 3, total: 5 },
            next_step: { kind: "write_chunk", index: 4, remaining: 2 },
          } as never);
      }) as never,
    );

    const firstRes = createMockRes();
    const secondRes = createMockRes();
    const first = triggerHandler(req({ spreadsheet_id: "sheet-123", job_id: "job-123", max_steps_per_request: 1 }), firstRes);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const second = triggerHandler(req({ spreadsheet_id: "sheet-123", job_id: "job-123" }), secondRes);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(secondRes.status).toHaveBeenCalledWith(202);
    expect(readJson(secondRes)).toMatchObject({
      ok: true,
      advanced: false,
      job_id: "job-123",
      concurrency: "in_progress",
      has_next_step: true,
    });
    releaseStep();
    await first;
    await second;

    expect(mockRunExternalImportJobStep).toHaveBeenCalledTimes(1);
  });
});
