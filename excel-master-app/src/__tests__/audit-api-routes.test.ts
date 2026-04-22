import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import auditSummaryHandler from "../pages/api/audit_summary";
import auditSyncHandler from "../pages/api/audit_sync";

import { getAuditSummary, syncAuditSummary } from "@/lib/audit-service";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/audit-service", () => ({
  getAuditSummary: jest.fn(),
  syncAuditSummary: jest.fn(),
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockGetAuditSummary = getAuditSummary as jest.MockedFunction<typeof getAuditSummary>;
const mockSyncAuditSummary = syncAuditSummary as jest.MockedFunction<typeof syncAuditSummary>;

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
      query: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
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
      query: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
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
    } as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "spreadsheet_id is required" });
  });

  it("rejects non-GET requests with 405", async () => {
    const req = {
      method: "POST",
      query: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
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
    } as NextApiRequest;
    const res = createMockRes();

    await auditSummaryHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "summary boom" });
  });
});

describe("/api/audit_sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a success payload for an authenticated POST request", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockSyncAuditSummary.mockResolvedValue({
      spreadsheetId: "sheet-123",
      last_synced_at: "2026-04-22T00:00:00.000Z",
      snapshot: { score: 88 },
    } as never);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(mockSyncAuditSummary).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      spreadsheet_id: "sheet-123",
      last_synced_at: "2026-04-22T00:00:00.000Z",
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("rejects missing spreadsheet ids with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: {},
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "spreadsheet_id is required" });
  });

  it("rejects non-POST requests with 405", async () => {
    const req = {
      method: "GET",
      body: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
  });

  it("returns 500 when the downstream sync fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockSyncAuditSummary.mockRejectedValue(new Error("sync boom"));

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as NextApiRequest;
    const res = createMockRes();

    await auditSyncHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "sync boom" });
  });
});
