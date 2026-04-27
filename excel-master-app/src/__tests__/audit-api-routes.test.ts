import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";
import { after } from "next/server";

import auditSummaryHandler from "../pages/api/audit_summary";
import auditReclassDetailHandler from "../pages/api/audit_reclass_detail";
import auditSyncHandler from "../pages/api/audit_sync";
import auditSyncStatusHandler from "../pages/api/audit_sync_status";

import {
  fetchLiveAuditSnapshot,
  getAuditSummary,
  getLatestAuditSyncRunStatus,
  startAuditSummarySync,
  syncAuditSummary,
  classifyAuditSyncRun,
} from "@/lib/audit-service";
import { ProjectAccessError, requireProjectAccess, requireProjectCollaborator } from "@/lib/project-access";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("next/server", () => ({
  after: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/audit-service", () => ({
  fetchLiveAuditSnapshot: jest.fn(),
  getAuditSummary: jest.fn(),
  getLatestAuditSyncRunStatus: jest.fn(),
  startAuditSummarySync: jest.fn(),
  syncAuditSummary: jest.fn(),
  classifyAuditSyncRun: jest.fn(),
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
    requireProjectAccess: jest.fn(),
    requireProjectCollaborator: jest.fn(),
  };
});

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockFetchLiveAuditSnapshot = fetchLiveAuditSnapshot as jest.MockedFunction<typeof fetchLiveAuditSnapshot>;
const mockGetAuditSummary = getAuditSummary as jest.MockedFunction<typeof getAuditSummary>;
const mockGetLatestAuditSyncRunStatus = getLatestAuditSyncRunStatus as jest.MockedFunction<
  typeof getLatestAuditSyncRunStatus
>;
const mockStartAuditSummarySync = startAuditSummarySync as jest.MockedFunction<typeof startAuditSummarySync>;
const mockSyncAuditSummary = syncAuditSummary as jest.MockedFunction<typeof syncAuditSummary>;
const mockClassifyAuditSyncRun = classifyAuditSyncRun as jest.MockedFunction<typeof classifyAuditSyncRun>;
const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockAfter = after as jest.MockedFunction<typeof after>;
const originalFetch = global.fetch;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

describe("/api/audit_summary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockClassifyAuditSyncRun.mockImplementation((run) =>
      run.status === "running" && run.started_at === "2026-04-26T12:00:00.000Z" ? "stale" : (run.status as never),
    );
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("returns the audit summary for an authenticated GET request", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetAuditSummary.mockResolvedValue({
      summary: { score: 99 },
      from_cache: false,
    } as never);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", sync_run_id: "run-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockGetAuditSummary).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      summary: { score: 99 },
      from_cache: false,
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", sync_run_id: "run-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("rejects missing spreadsheet ids with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);

    const req = {
      method: "GET",
      query: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "spreadsheet_id is required" });
  });

  it("rejects non-GET requests with 405", async () => {
    const req = {
      method: "POST",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
  });

  it("returns 500 when the downstream summary lookup fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetAuditSummary.mockRejectedValue(new Error("summary boom"));

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "summary boom" });
  });

  it("denies forbidden project access before reading the summary", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "blocked@example.com" },
    } as never);
    mockRequireProjectAccess.mockRejectedValue(
      new ProjectAccessError("Project access is forbidden.", 403, "PROJECT_ACCESS_FORBIDDEN"),
    );

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockGetAuditSummary).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});

describe("/api/audit_sync_status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("returns the latest audit sync run status for an authenticated GET request", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetLatestAuditSyncRunStatus.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      project_id: "project-123",
      latest_run: {
        sync_run_id: "run-123",
        status: "running",
        started_at: "2026-04-26T12:00:00.000Z",
        created_at: "2026-04-26T12:00:00.000Z",
      },
    } as never);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", sync_run_id: "run-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncStatusHandler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockGetLatestAuditSyncRunStatus).toHaveBeenCalledWith("sheet-123", "run-123");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      spreadsheet_id: "sheet-123",
      project_id: "project-123",
      latest_run: {
        sync_run_id: "run-123",
        status: "stale",
        started_at: "2026-04-26T12:00:00.000Z",
        created_at: "2026-04-26T12:00:00.000Z",
      },
      status: "stale",
      run: {
        sync_run_id: "run-123",
        status: "stale",
        started_at: "2026-04-26T12:00:00.000Z",
        created_at: "2026-04-26T12:00:00.000Z",
      },
    });
  });

  it("denies forbidden project access before reading the latest sync status", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "blocked@example.com" },
    } as never);
    mockRequireProjectAccess.mockRejectedValue(
      new ProjectAccessError("Project access is forbidden.", 403, "PROJECT_ACCESS_FORBIDDEN"),
    );

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncStatusHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockGetLatestAuditSyncRunStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});

describe("/api/audit_reclass_detail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("denies forbidden project access before reading the live audit snapshot", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "blocked@example.com" },
    } as never);
    mockRequireProjectAccess.mockRejectedValue(
      new ProjectAccessError("Project access is forbidden.", 403, "PROJECT_ACCESS_FORBIDDEN"),
    );

    const req = {
      method: "GET",
      query: {
        spreadsheet_id: "sheet-123",
        source_table: "Payable",
        old_cost_state: "未分配",
        new_cost_state: "CAPEX",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditReclassDetailHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockFetchLiveAuditSnapshot).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});

describe("/api/audit_sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
    mockStartAuditSummarySync.mockResolvedValue({
      spreadsheetId: "sheet-123",
      sync_run_id: "run-123",
      run: jest.fn().mockResolvedValue(undefined),
    } as never);
    global.fetch = jest.fn();
    process.env.RECLASSIFY_WORKER_URL = "https://worker.example.com/api/internal/reclassify_job";
    process.env.RECLASSIFY_WORKER_SECRET = "test-reclassify-secret";
    delete process.env.AIWB_WORKER_SECRET;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.RECLASSIFY_WORKER_URL;
    delete process.env.RECLASSIFY_WORKER_SECRET;
    delete process.env.AIWB_WORKER_SECRET;
    delete process.env.NEXTAUTH_URL;
  });

  it("runs explicit schema migration and validation before accepting audit sync", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          ok: true,
          operation: "ensure_final_gmp_schema",
          final_gmp: { inserted: false },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          ok: true,
          operation: "validate",
          validation: {
            status: "ok",
            checked_at: "2026-04-22T00:00:08.000Z",
            message: "重分类校验通过",
            totals: {
              total_rows: 35199,
              matched_rows: 35199,
              mismatch_count: 0,
            },
            sheets: {
              payable: { mismatch_count: 0 },
              final_detail: { mismatch_count: 0 },
            },
            sample_mismatches: [],
          },
        }),
      });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-AiWB-Worker-Secret": "test-reclassify-secret",
        }),
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          operation: "ensure_final_gmp_schema",
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          operation: "validate",
        }),
      }),
    );
    expect(mockStartAuditSummarySync).toHaveBeenCalledWith("sheet-123");
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "accepted",
        mode: "async",
        spreadsheet_id: "sheet-123",
        sync_run_id: "run-123",
        schema_migration: expect.objectContaining({ ok: true }),
        validation: expect.objectContaining({ status: "ok" }),
      }),
    );
  });

  it("still accepts audit sync when validation worker fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          ok: true,
          operation: "ensure_final_gmp_schema",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({
          message: "validation boom",
        }),
      });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(mockStartAuditSummarySync).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "accepted",
        spreadsheet_id: "sheet-123",
        validation: {
          status: "failed",
          checked_at: expect.any(String),
          message: "validation boom",
        },
      }),
    );
  });

  it("uses the trusted deployment origin instead of request headers when validation worker URL is unset", async () => {
    delete process.env.RECLASSIFY_WORKER_URL;
    process.env.NEXTAUTH_URL = "https://trusted.example.com";
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ ok: true, operation: "ensure_final_gmp_schema" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          validation: {
            status: "ok",
            checked_at: "2026-04-22T00:00:08.000Z",
            message: "重分类校验通过",
          },
        }),
      });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://trusted.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-AiWB-Worker-Secret": "test-reclassify-secret",
        }),
      }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("attacker.example"), expect.anything());
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("accepts async mode without next/server after or foreground sync", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ ok: true, operation: "ensure_final_gmp_schema" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          validation: {
            status: "ok",
            checked_at: "2026-04-22T00:00:08.000Z",
            message: "重分类校验通过",
          },
        }),
      });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", mode: "async" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockStartAuditSummarySync).toHaveBeenCalledWith("sheet-123");
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "accepted",
        mode: "async",
        spreadsheet_id: "sheet-123",
      }),
    );
  });

  it("denies readers before validation or sync", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);
    mockRequireProjectCollaborator.mockRejectedValue(
      new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN"),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "reader@example.com");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockStartAuditSummarySync).not.toHaveBeenCalled();
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

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

    await auditSyncHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "缺少 spreadsheet_id" });
  });

  it("rejects non-POST requests with 405", async () => {
    const req = {
      method: "GET",
      body: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "请求方法不支持" });
  });

  it("returns 500 when the async sync starter fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockStartAuditSummarySync.mockRejectedValue(new Error("sync boom"));
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ ok: true, operation: "ensure_final_gmp_schema" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          validation: {
            status: "ok",
            checked_at: "2026-04-22T00:00:08.000Z",
            message: "重分类校验通过",
          },
        }),
      });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "sync boom" });
  });
});
