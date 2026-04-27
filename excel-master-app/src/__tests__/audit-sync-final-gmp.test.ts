import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import auditSyncHandler from "../pages/api/audit_sync";

import { startAuditSummarySync, syncAuditSummary } from "@/lib/audit-service";
import { requireProjectCollaborator } from "@/lib/project-access";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/audit-service", () => ({
  startAuditSummarySync: jest.fn(),
  syncAuditSummary: jest.fn(),
}));

jest.mock("@/lib/project-access", () => {
  class ProjectAccessError extends Error {
    statusCode: number;
    code: string;

    constructor(message: string, code: string, statusCode: number) {
      super(message);
      this.name = "ProjectAccessError";
      this.code = code;
      this.statusCode = statusCode;
    }
  }

  return {
    ProjectAccessError,
    requireProjectCollaborator: jest.fn(),
  };
});

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockStartAuditSummarySync = startAuditSummarySync as jest.MockedFunction<typeof startAuditSummarySync>;
const mockSyncAuditSummary = syncAuditSummary as jest.MockedFunction<typeof syncAuditSummary>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const originalFetch = global.fetch;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

function mockValidationFetch() {
  global.fetch = jest
    .fn()
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
        validation: {
          status: "ok",
          checked_at: "2026-04-27T12:00:00.000Z",
          message: "重分类校验通过",
        },
      }),
    });
}

describe("/api/audit_sync Final GMP schema guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidationFetch();
    process.env.RECLASSIFY_WORKER_URL = "https://worker.example.com/api/internal/reclassify_job";
    process.env.RECLASSIFY_WORKER_SECRET = "test-reclassify-secret";
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockRequireProjectCollaborator.mockResolvedValue({
      driveRole: "writer",
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
    });
    mockStartAuditSummarySync.mockResolvedValue({
      spreadsheetId: "sheet-123",
      sync_run_id: "run-123",
      run: jest.fn().mockResolvedValue(undefined),
    } as never);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.RECLASSIFY_WORKER_URL;
    delete process.env.RECLASSIFY_WORKER_SECRET;
  });

  it("runs explicit schema migration before read-only validation and async snapshot generation", async () => {
    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
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
        headers: expect.objectContaining({
          "X-AiWB-Worker-Secret": "test-reclassify-secret",
        }),
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          operation: "validate",
        }),
      }),
    );
    expect((global.fetch as jest.Mock).mock.invocationCallOrder[1]).toBeLessThan(
      mockStartAuditSummarySync.mock.invocationCallOrder[0],
    );
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("treats async requests as accepted background syncs without next/server after", async () => {
    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", mode: "async" },
      headers: {},
      socket: {},
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-AiWB-Worker-Secret": "test-reclassify-secret",
        }),
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
      }),
    );
  });
});
