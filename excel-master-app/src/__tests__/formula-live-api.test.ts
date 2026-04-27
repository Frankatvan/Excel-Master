import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

import formulaSyncRunHandler from "../pages/api/formula_sync_run";
import liveSheetStatusHandler from "../pages/api/live_sheet_status";

import { getLiveSheetStatus } from "@/lib/live-sheet-status";
import { ProjectAccessError, requireProjectAccess, requireProjectCollaborator } from "@/lib/project-access";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({ mocked: true })),
    },
    sheets: jest.fn(),
  },
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/google-service-account", () => ({
  getGoogleServiceAccountCredentials: jest.fn(() => ({
    client_email: "service-account@example.com",
    private_key: "line1\nline2",
  })),
}));

jest.mock("@/lib/live-sheet-status", () => ({
  getLiveSheetStatus: jest.fn(),
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
const mockGetLiveSheetStatus = getLiveSheetStatus as jest.MockedFunction<typeof getLiveSheetStatus>;
const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockSheets = google.sheets as jest.Mock;
const originalFetch = global.fetch;
const originalEnv = process.env;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

describe("/api/formula_sync_run", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
    global.fetch = jest.fn();
    process.env.FORMULA_SYNC_WORKER_URL = "https://worker.example.com/api/formula_sync";
    process.env = {
      ...originalEnv,
      FORMULA_SYNC_WORKER_URL: "https://worker.example.com/api/formula_sync",
      FORMULA_SYNC_WORKER_SECRET: "test-formula-secret",
      NEXT_PUBLIC_SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-key",
      GOOGLE_CLIENT_EMAIL: "service-account@example.com",
      GOOGLE_PRIVATE_KEY: "line1\\nline2",
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.FORMULA_SYNC_WORKER_URL;
    delete process.env.FORMULA_SYNC_WORKER_SECRET;
    delete process.env.NEXTAUTH_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("proxies formula sync and returns live verification details", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    mockCreateClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
    } as never);
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetLiveSheetStatus.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      verified_at: "2026-04-23T01:23:45.000Z",
      checks: {
        units_count_formula: "=FORMULA",
        units_count_uses_unit_master: true,
        scoping_o56: "5/11/2027",
        scoping_o93: "8/14/2027",
        managed_sheets: ["109", "Scoping", "Unit Master"],
        formula_lock_ranges_109: [],
        unit_master_manual_ranges: ["'Unit Master'!H3:H1000", "'Unit Master'!K3:K1000"],
        header_input_ranges_109: ["'109'!C2:E2", "'109'!G2:I2"],
      },
      protections: [],
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: "success",
          message: "主表与保护规则已同步",
          verify: { matched: 121, total: 121, mismatches: [] },
        }),
      ),
    });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await formulaSyncRunHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/api/formula_sync",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-AiWB-Worker-Secret": "test-formula-secret",
        }),
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          project_id: "sheet-123",
          sheet_109_title: "237",
        }),
      }),
    );
    expect(mockGetLiveSheetStatus).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      message: "主表与保护规则已同步",
      spreadsheet_id: "sheet-123",
      verify: { matched: 121, total: 121, mismatches: [] },
      live_status: expect.objectContaining({
        spreadsheet_id: "sheet-123",
      }),
    });
  });

  it("passes an empty sheet title when the projects table is missing", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST205", message: "missing table" },
    });
    mockCreateClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
    } as never);
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetLiveSheetStatus.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      verified_at: "2026-04-23T01:23:45.000Z",
      checks: {
        managed_sheets: ["109"],
        formula_lock_ranges_109: [],
      },
      protections: [],
    } as never);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ status: "success" })),
    });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await formulaSyncRunHandler(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/api/formula_sync",
      expect.objectContaining({
        body: JSON.stringify({
          spreadsheet_id: "sheet-123",
          project_id: "sheet-123",
          sheet_109_title: "",
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await formulaSyncRunHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "未登录" });
  });

  it("denies readers before running formula sync", async () => {
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

    await formulaSyncRunHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "reader@example.com");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGetLiveSheetStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });

  it("returns 500 before running formula sync when the worker secret is missing", async () => {
    process.env = {
      ...process.env,
      FORMULA_SYNC_WORKER_URL: "https://worker.example.com/api/formula_sync",
      FORMULA_SYNC_WORKER_SECRET: "",
      AIWB_WORKER_SECRET: "",
    };
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await formulaSyncRunHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockGetLiveSheetStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Worker secret is not configured." });
  });

  it("uses the trusted deployment origin instead of request headers when worker URL is unset", async () => {
    process.env = {
      ...process.env,
      FORMULA_SYNC_WORKER_URL: "",
      FORMULA_SYNC_WORKER_SECRET: "test-formula-secret",
      NEXTAUTH_URL: "https://trusted.example.com",
    };
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    mockCreateClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
    } as never);
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetLiveSheetStatus.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      verified_at: "2026-04-23T01:23:45.000Z",
      checks: { managed_sheets: ["109"] },
      protections: [],
    } as never);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ status: "success" })),
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

    await formulaSyncRunHandler(req, res);

    expect(global.fetch).toHaveBeenCalledWith(
      "https://trusted.example.com/api/formula_sync",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-AiWB-Worker-Secret": "test-formula-secret",
        }),
      }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(expect.stringContaining("attacker.example"), expect.anything());
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("preserves project run lock conflicts from the formula sync worker", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    mockCreateClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
    } as never);
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: "error",
          message: "PROJECT_RUN_LOCKED:audit_sync",
        }),
      ),
    });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await formulaSyncRunHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockGetLiveSheetStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "PROJECT_RUN_LOCKED",
      message: "已有任务运行中：audit_sync",
      details: {
        active_operation: "audit_sync",
      },
    });
  });

  it("preserves project run lock conflicts even when the formula worker wraps them in 500", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    mockCreateClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
    } as never);
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: "error",
          message: "Formula sync failed: PROJECT_RUN_LOCKED:audit_sync",
        }),
      ),
    });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
      headers: {},
      socket: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await formulaSyncRunHandler(req, res);

    expect(mockGetLiveSheetStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "PROJECT_RUN_LOCKED",
      message: "已有任务运行中：audit_sync",
      details: {
        active_operation: "audit_sync",
      },
    });
  });
});

describe("/api/live_sheet_status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("returns live verification status for authenticated requests", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetLiveSheetStatus.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      verified_at: "2026-04-23T01:23:45.000Z",
      checks: {
        units_count_formula: "=FORMULA",
        units_count_uses_unit_master: true,
        scoping_o56: "5/11/2027",
        scoping_o93: "8/14/2027",
        managed_sheets: ["109", "Scoping", "Unit Master"],
        formula_lock_ranges_109: [],
        unit_master_manual_ranges: ["'Unit Master'!H3:H1000", "'Unit Master'!K3:K1000"],
        header_input_ranges_109: ["'109'!C2:E2", "'109'!G2:I2"],
      },
      protections: [],
    });

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await liveSheetStatusHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockGetLiveSheetStatus).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: "success",
      live_status: expect.objectContaining({
        spreadsheet_id: "sheet-123",
      }),
    });
  });

  it("rejects non-GET requests with 405", async () => {
    const req = {
      method: "POST",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await liveSheetStatusHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "请求方法不支持" });
  });

  it("denies forbidden project access before reading live sheet status", async () => {
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

    await liveSheetStatusHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockGetLiveSheetStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});

describe("live-sheet-status dynamic 109 title", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-key",
      GOOGLE_CLIENT_EMAIL: "service-account@example.com",
      GOOGLE_PRIVATE_KEY: "line1\\nline2",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("recognizes header input ranges from the registered dynamic sheet title", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    const batchGet = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          valueRanges: [{ values: [["=FORMULA"]] }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          valueRanges: [{ values: [["5/11/2027"]] }, { values: [["8/14/2027"]] }],
        },
      });
    const get = jest.fn().mockResolvedValue({
      data: {
        sheets: [
          {
            properties: { title: "237", sheetId: 237 },
            protectedRanges: [
              {
                description: "AiWB managed main sheet protection",
                unprotectedRanges: [
                  { sheetId: 237, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 5 },
                  { sheetId: 237, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 6, endColumnIndex: 9 },
                  { sheetId: 237, startRowIndex: 17, endRowIndex: 18, startColumnIndex: 5, endColumnIndex: 11 },
                ],
              },
            ],
          },
          {
            properties: { title: "Unit Master", sheetId: 301 },
            protectedRanges: [
              {
                description: "AiWB managed Unit Master protection",
                unprotectedRanges: [
                  { sheetId: 301, startRowIndex: 2, endRowIndex: 1000, startColumnIndex: 7, endColumnIndex: 8 },
                ],
              },
            ],
          },
          {
            properties: { title: "Scoping", sheetId: 302 },
            protectedRanges: [],
          },
        ],
      },
    });

    mockCreateClient.mockReturnValue({
      from: jest.fn(() => ({
        select: jest.fn(() => ({
          eq: jest.fn(() => ({ maybeSingle })),
        })),
      })),
    } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
        get,
      },
    });

    const actualModule = jest.requireActual("@/lib/live-sheet-status") as typeof import("@/lib/live-sheet-status");
    const result = await actualModule.getLiveSheetStatus("sheet-123");

    expect(batchGet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spreadsheetId: "sheet-123",
        ranges: ["'237'!C5"],
        valueRenderOption: "FORMULA",
      }),
    );
    expect(result.checks.header_input_ranges_109).toEqual(["'237'!C2:E2", "'237'!G2:I2"]);
    expect(result.checks.managed_sheets).toEqual(["237", "Unit Master"]);
  });
});
