import type { NextApiRequest, NextApiResponse } from "next";

import handler from "../pages/api/reclassify";

import { getServerSession } from "next-auth/next";
import { syncAuditSummary } from "@/lib/audit-service";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/audit-service", () => ({
  syncAuditSummary: jest.fn(),
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockSyncAuditSummary = syncAuditSummary as jest.MockedFunction<typeof syncAuditSummary>;

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
    delete process.env.RECLASSIFY_WORKER_URL;
  });

  it("bridges to the worker and refreshes the audit cache on success", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockSyncAuditSummary.mockResolvedValue({
      spreadsheetId: "sheet-123",
      last_synced_at: "2026-04-22T01:02:03.000Z",
      snapshot: { status: "synced" },
    } as never);
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
    process.env.RECLASSIFY_WORKER_URL = "https://worker.example.com/api/reclassify_job";

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockGetServerSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://worker.example.com/api/reclassify_job",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ spreadsheet_id: "sheet-123" }),
      }),
    );
    expect(mockSyncAuditSummary).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        mode: "worker",
        message: "worker complete",
        spreadsheet_id: "sheet-123",
        triggered_at: "2026-04-22T00:00:00.000Z",
        last_synced_at: "2026-04-22T01:02:03.000Z",
        summary: { changed_rows: 3 },
      }),
    );
  });

  it("returns 502 when the worker reports failure", async () => {
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
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("worker"),
      }),
    );
    expect(mockSyncAuditSummary).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheetId: "sheet-123" },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

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
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
  });
});
