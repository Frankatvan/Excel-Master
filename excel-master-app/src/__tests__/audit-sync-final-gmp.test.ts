import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";
import { after } from "next/server";

import auditSyncHandler from "../pages/api/audit_sync";

import { startAuditSummarySync, syncAuditSummary } from "@/lib/audit-service";

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
  startAuditSummarySync: jest.fn(),
  syncAuditSummary: jest.fn(),
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockAfter = after as jest.MockedFunction<typeof after>;
const mockStartAuditSummarySync = startAuditSummarySync as jest.MockedFunction<typeof startAuditSummarySync>;
const mockSyncAuditSummary = syncAuditSummary as jest.MockedFunction<typeof syncAuditSummary>;
const originalFetch = global.fetch;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

function mockValidationFetch() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
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
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.RECLASSIFY_WORKER_URL;
  });

  it("runs validation worker before synchronous snapshot generation", async () => {
    mockSyncAuditSummary.mockResolvedValue({
      spreadsheetId: "sheet-123",
      last_synced_at: "2026-04-27T12:01:00.000Z",
      snapshot: {},
    } as never);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          validate_only: true,
        }),
      }),
    );
    expect((global.fetch as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncAuditSummary.mock.invocationCallOrder[0],
    );
  });

  it("runs validation worker before the async snapshot run", async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    mockStartAuditSummarySync.mockResolvedValue({
      spreadsheetId: "sheet-123",
      sync_run_id: "run-123",
      run,
    } as never);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", mode: "async" },
      headers: {},
      socket: {},
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);
    await (mockAfter.mock.calls[0][0] as () => Promise<void>)();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/api/internal/reclassify_job",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          validate_only: true,
        }),
      }),
    );
    expect((global.fetch as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0],
    );
  });
});
