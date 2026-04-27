import type { NextApiRequest, NextApiResponse } from "next";

import handler from "../pages/api/reclassify";

import { getServerSession } from "next-auth/next";
import { syncAuditSummary } from "@/lib/audit-service";
import { appendAuditLog, getProjectState, writeProjectState, type ProjectState } from "@/lib/project-state-sheet";
import { ProjectAccessError, requireProjectCollaborator } from "@/lib/project-access";
import {
  readReclassifyCooldown,
  writeReclassifyCooldown,
} from "@/lib/reclassify-rate-limit";
import { WORKBENCH_STAGES } from "@/lib/workbench-stage";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/audit-service", () => ({
  syncAuditSummary: jest.fn(),
}));

jest.mock("@/lib/project-state-sheet", () => ({
  appendAuditLog: jest.fn(),
  getProjectState: jest.fn(),
  writeProjectState: jest.fn(),
}));

jest.mock("@/lib/reclassify-rate-limit", () => ({
  readReclassifyCooldown: jest.fn(),
  writeReclassifyCooldown: jest.fn(),
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

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockSyncAuditSummary = syncAuditSummary as jest.MockedFunction<typeof syncAuditSummary>;
const mockGetProjectState = getProjectState as jest.MockedFunction<typeof getProjectState>;
const mockWriteProjectState = writeProjectState as jest.MockedFunction<typeof writeProjectState>;
const mockAppendAuditLog = appendAuditLog as jest.MockedFunction<typeof appendAuditLog>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockReadReclassifyCooldown = readReclassifyCooldown as jest.MockedFunction<typeof readReclassifyCooldown>;
const mockWriteReclassifyCooldown = writeReclassifyCooldown as jest.MockedFunction<typeof writeReclassifyCooldown>;
const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

describe("/api/reclassify", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy.mockClear();
    jest.useFakeTimers().setSystemTime(new Date("2026-04-23T09:10:11.000Z"));
    delete process.env.RECLASSIFY_WORKER_URL;
    process.env.NEXTAUTH_URL = "https://trusted.example.com";
    process.env.RECLASSIFY_WORKER_SECRET = "test-reclassify-secret";
    delete process.env.AIWB_WORKER_SECRET;
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
    mockReadReclassifyCooldown.mockResolvedValue(null);
    mockWriteReclassifyCooldown.mockResolvedValue("2026-04-22T01:00:00.000Z");
    mockWriteProjectState.mockResolvedValue(undefined);
    mockAppendAuditLog.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.RECLASSIFY_WORKER_SECRET;
    delete process.env.AIWB_WORKER_SECRET;
    delete process.env.NEXTAUTH_URL;
  });

  it("bridges to the worker and records project state on success", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const state: ProjectState = {
      current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      external_data_dirty: false,
      manual_input_dirty: true,
      locked: true,
      owner_email: "owner@example.com",
      last_external_edit_at: "2026-04-20T00:00:00.000Z",
      last_external_edit_by: "external@example.com",
      last_manual_edit_at: "2026-04-21T00:00:00.000Z",
      last_manual_edit_by: "manual@example.com",
      locked_at: "2026-04-22T00:00:00.000Z",
      locked_by: "reviewer@example.com",
      is_owner_or_admin: false,
    };
    mockGetProjectState.mockResolvedValue(state);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: "worker complete",
        triggered_at: "2026-04-22T00:00:00.000Z",
        summary: { changed_rows: 3 },
      }),
    });
    global.fetch = fetchMock as never;
    process.env.RECLASSIFY_WORKER_URL = "https://worker.example.com/api/internal/reclassify_job";

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockReadReclassifyCooldown).toHaveBeenCalledWith("sheet-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-AiWB-Worker-Secret": "test-reclassify-secret",
        }),
        body: JSON.stringify({ spreadsheet_id: "sheet-123" }),
      }),
    );
    expect(mockGetProjectState).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    const expectedState = {
      current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      external_data_dirty: false,
      manual_input_dirty: false,
      locked: false,
      owner_email: "owner@example.com",
      last_external_edit_at: "2026-04-20T00:00:00.000Z",
      last_external_edit_by: "external@example.com",
      last_manual_edit_at: "2026-04-21T00:00:00.000Z",
      last_manual_edit_by: "manual@example.com",
      last_reclassify_at: "2026-04-23T09:10:11.000Z",
      locked_at: "2026-04-22T00:00:00.000Z",
      locked_by: "reviewer@example.com",
    };
    const persistedState = mockWriteProjectState.mock.calls[0][1];
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(persistedState).toEqual(expect.objectContaining(expectedState));
    expect(persistedState).not.toHaveProperty("is_owner_or_admin");
    expect(mockWriteProjectState).toHaveBeenCalledTimes(1);
    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteReclassifyCooldown).toHaveBeenCalledWith("sheet-123", "2026-04-22T00:00:00.000Z");
    expect(mockWriteProjectState.mock.invocationCallOrder[0]).toBeLessThan(
      mockAppendAuditLog.mock.invocationCallOrder[0],
    );
    expect(mockAppendAuditLog.mock.invocationCallOrder[0]).toBeLessThan(
      mockWriteReclassifyCooldown.mock.invocationCallOrder[0],
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith("sheet-123", {
      actor_email: "tester@example.com",
      action: "reclassify",
      previous_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      next_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      status: "success",
      message: "Reclassification completed.",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        mode: "worker",
        message: "worker complete",
        spreadsheet_id: "sheet-123",
        triggered_at: "2026-04-22T00:00:00.000Z",
        summary: { changed_rows: 3 },
        state: persistedState,
      }),
    );
  });

  it("does not write cooldown when state write fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const state: ProjectState = {
      current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      external_data_dirty: false,
      manual_input_dirty: true,
      locked: true,
      owner_email: "owner@example.com",
      last_external_edit_at: "2026-04-20T00:00:00.000Z",
      last_external_edit_by: "external@example.com",
      last_manual_edit_at: "2026-04-21T00:00:00.000Z",
      last_manual_edit_by: "manual@example.com",
      locked_at: "2026-04-22T00:00:00.000Z",
      locked_by: "reviewer@example.com",
      is_owner_or_admin: false,
    };
    mockGetProjectState.mockResolvedValue(state);
    mockWriteProjectState.mockRejectedValueOnce(new Error("state write failed"));
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        triggered_at: "2026-04-22T00:00:00.000Z",
      }),
    });
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockWriteReclassifyCooldown).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "成本重分类失败" });
  });

  it("uses the trusted deployment origin instead of request headers when worker URL is unset", async () => {
    delete process.env.RECLASSIFY_WORKER_URL;
    process.env.NEXTAUTH_URL = "https://trusted.example.com";
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const state: ProjectState = {
      current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      external_data_dirty: false,
      manual_input_dirty: true,
      locked: true,
      owner_email: "owner@example.com",
      last_external_edit_at: "2026-04-20T00:00:00.000Z",
      last_external_edit_by: "external@example.com",
      last_manual_edit_at: "2026-04-21T00:00:00.000Z",
      last_manual_edit_by: "manual@example.com",
      locked_at: "2026-04-22T00:00:00.000Z",
      locked_by: "reviewer@example.com",
      is_owner_or_admin: false,
    };
    mockGetProjectState.mockResolvedValue(state);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        triggered_at: "2026-04-22T00:00:00.000Z",
      }),
    });
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://trusted.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-AiWB-Worker-Secret": "test-reclassify-secret",
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("attacker.example"), expect.anything());
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not write cooldown when audit log fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const state: ProjectState = {
      current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      external_data_dirty: false,
      manual_input_dirty: true,
      locked: true,
      owner_email: "owner@example.com",
      last_external_edit_at: "2026-04-20T00:00:00.000Z",
      last_external_edit_by: "external@example.com",
      last_manual_edit_at: "2026-04-21T00:00:00.000Z",
      last_manual_edit_by: "manual@example.com",
      locked_at: "2026-04-22T00:00:00.000Z",
      locked_by: "reviewer@example.com",
      is_owner_or_admin: false,
    };
    mockGetProjectState.mockResolvedValue(state);
    mockAppendAuditLog.mockRejectedValueOnce(new Error("audit log failed"));
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        triggered_at: "2026-04-22T00:00:00.000Z",
      }),
    });
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockWriteProjectState).toHaveBeenCalledTimes(1);
    expect(mockWriteReclassifyCooldown).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "成本重分类失败" });
  });

  it("returns 429 when the spreadsheet is still in cooldown", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockReadReclassifyCooldown.mockResolvedValue("2099-04-22T01:00:00.000Z");

    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("1 小时"),
        retry_at: "2099-04-22T01:00:00.000Z",
      }),
    );
  });

  it("denies readers before calling the worker", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);
    mockRequireProjectCollaborator.mockRejectedValue(
      new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN"),
    );
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "reader@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReadReclassifyCooldown).not.toHaveBeenCalled();
    expect(mockGetProjectState).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });

  it("returns 500 before calling the worker when the worker secret is missing", async () => {
    delete process.env.RECLASSIFY_WORKER_SECRET;
    delete process.env.AIWB_WORKER_SECRET;
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Worker secret is not configured." });
  });

  it("returns structured 502 details when the worker reports failure", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        message: "worker failed",
      }),
    });
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: "WORKER_FAILED",
      message: "worker failed",
    });
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "reclassify worker failed",
      expect.objectContaining({
        status: 500,
        body: { message: "worker failed" },
        message: "worker failed",
      }),
    );
  });

  it("preserves project run lock conflicts from the reclassification worker", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        status: "error",
        message: "PROJECT_RUN_LOCKED:audit_sync",
      }),
    });
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "PROJECT_RUN_LOCKED",
      message: "已有任务运行中：audit_sync",
      details: {
        active_operation: "audit_sync",
      },
    });
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });

  it("preserves project run lock conflicts even when the worker wraps them in 500", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        message: "Reclassification worker failed: PROJECT_RUN_LOCKED:audit_sync",
      }),
    });
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "PROJECT_RUN_LOCKED",
      message: "已有任务运行中：audit_sync",
      details: {
        active_operation: "audit_sync",
      },
    });
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "未登录" });
  });

  it("rejects missing spreadsheet ids with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("spreadsheet"),
      }),
    );
  });

  it("rejects non-POST requests with 405", async () => {
    const req = {
      method: "GET",
      body: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "请求方法不支持" });
  });
});
