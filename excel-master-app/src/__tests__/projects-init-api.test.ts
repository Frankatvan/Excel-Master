import type { NextApiRequest, NextApiResponse } from "next";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

jest.mock(
  "@/lib/project-bootstrap",
  () => ({
    bootstrapProjectSpreadsheet: jest.fn(),
    cleanupProjectSpreadsheet: jest.fn(),
  }),
  { virtual: true },
);

const originalEnv = process.env;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

async function loadHandler() {
  const mod = await import("../pages/api/projects/init");
  return mod.default;
}

function mockProjectsTable({
  existingSerialProjects = [],
  insertResult = { data: { id: "project-123" }, error: null },
}: {
  existingSerialProjects?: Array<Record<string, unknown>>;
  insertResult?: {
    data: Record<string, unknown> | null;
    error: { code?: string; message?: string } | null;
  };
} = {}) {
  const mockSerialLimit = jest.fn().mockResolvedValue({
    data: existingSerialProjects,
    error: null,
  });
  const mockSerialOr = jest.fn().mockReturnValue({
    limit: mockSerialLimit,
  });
  const mockProjectsSelect = jest.fn().mockImplementation((columns?: string) => {
    if (columns === "id") {
      return {
        or: mockSerialOr,
      };
    }

    return {
      single: jest.fn().mockResolvedValue(insertResult),
    };
  });
  const mockProjectsInsert = jest.fn().mockReturnValue({
    select: mockProjectsSelect,
  });
  const mockFrom = jest.fn().mockImplementation((table: string) => {
    if (table === "projects") {
      return {
        select: mockProjectsSelect,
        insert: mockProjectsInsert,
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  return {
    mockFrom,
    mockProjectsInsert,
    mockProjectsSelect,
    mockSerialOr,
    mockSerialLimit,
  };
}

describe("/api/projects/init", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      GOLDEN_TEMPLATE_ID: "golden-template-sheet",
      GOOGLE_SHEET_ID: "env-default-sheet",
      GOOGLE_SHEET_TEMPLATE_ID: "legacy-template-sheet",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const { getServerSession } = await import("next-auth/next");
    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    mockGetServerSession.mockResolvedValue(null);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectName: "Project Atlas",
        projectOwner: "Owner Name",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("returns 400 when projectShortName is missing", async () => {
    const { getServerSession } = await import("next-auth/next");
    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectName: "Project Atlas",
        projectOwner: "Owner Name",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Project short name is required" });
  });

  it("returns 400 when projectOwner is missing", async () => {
    const { getServerSession } = await import("next-auth/next");
    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Project owner is required" });
  });

  it("returns 400 when projectSerial is not exactly three digits", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);
    mockCreateClient.mockReturnValue({
      from: jest.fn(),
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "12",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockBootstrapProjectSpreadsheet).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Project serial must be exactly 3 digits" });
  });

  it("returns 409 when projectSerial already exists in the registry", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);

    const projectsTable = mockProjectsTable({
      existingSerialProjects: [{ id: "existing-project" }],
    });
    mockCreateClient.mockReturnValue({
      from: projectsTable.mockFrom,
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(projectsTable.mockProjectsSelect).toHaveBeenCalledWith("id");
    expect(projectsTable.mockSerialOr).toHaveBeenCalledWith("project_sequence.eq.109,sheet_109_title.eq.109");
    expect(mockBootstrapProjectSpreadsheet).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "Project serial 109 already exists" });
  });

  it("falls back when project_sequence column is missing during serial check and insert", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);
    mockBootstrapProjectSpreadsheet.mockResolvedValue({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });

    const mockSerialLimit = jest
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "42703", message: "column projects.project_sequence does not exist" },
      })
      .mockResolvedValueOnce({
        data: [],
        error: null,
      });
    const mockSerialOr = jest.fn().mockReturnValue({ limit: mockSerialLimit });
    const insertSingle = jest
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "42703", message: "column projects.project_sequence does not exist" },
      })
      .mockResolvedValueOnce({
        data: { id: "project-123" },
        error: null,
      });
    const mockProjectsSelect = jest.fn().mockImplementation((columns?: string) => {
      if (columns === "id") {
        return { or: mockSerialOr };
      }
      return {
        single: insertSingle,
      };
    });
    const mockProjectsInsert = jest.fn().mockReturnValue({ select: mockProjectsSelect });
    const mockFrom = jest.fn().mockImplementation((table: string) => {
      if (table === "projects") {
        return {
          select: mockProjectsSelect,
          insert: mockProjectsInsert,
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    mockCreateClient.mockReturnValue({ from: mockFrom } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockSerialOr).toHaveBeenNthCalledWith(1, "project_sequence.eq.109,sheet_109_title.eq.109");
    expect(mockSerialOr).toHaveBeenNthCalledWith(2, "sheet_109_title.eq.109");
    expect(mockProjectsInsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        project_sequence: "109",
      }),
    );
    expect(mockProjectsInsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sheet_109_title: "109",
      }),
    );
    expect(mockProjectsInsert.mock.calls[1][0]).not.toHaveProperty("project_sequence");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        projectId: "project-123",
        spreadsheetId: "sheet-123",
      }),
    );
  });

  it("creates the spreadsheet through the helper and returns the spreadsheet URL", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);
    mockBootstrapProjectSpreadsheet.mockResolvedValue({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });

    const projectsTable = mockProjectsTable();
    mockCreateClient.mockReturnValue({
      from: projectsTable.mockFrom,
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockBootstrapProjectSpreadsheet).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "Project Atlas",
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
        goldenTemplateId: "golden-template-sheet",
        userEmail: "owner@example.com",
      }),
    );
    expect(projectsTable.mockSerialOr).toHaveBeenCalledWith("project_sequence.eq.109,sheet_109_title.eq.109");
    expect(projectsTable.mockProjectsInsert).toHaveBeenCalledWith({
      user_id_sub: "user-sub-123",
      spreadsheet_id: "sheet-123",
      name: "Project Atlas",
      project_sequence: "109",
      sheet_109_title: "109",
      owner_email: "owner@example.com",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      projectId: "project-123",
      project: { id: "project-123" },
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });
  });

  it("uses GOLDEN_TEMPLATE_ID and ignores request templateSpreadsheetId", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);
    mockBootstrapProjectSpreadsheet.mockResolvedValue({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });

    const projectsTable = mockProjectsTable();
    mockCreateClient.mockReturnValue({
      from: projectsTable.mockFrom,
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
        templateSpreadsheetId: "template-ignored-by-policy",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockBootstrapProjectSpreadsheet).toHaveBeenCalledWith(
      expect.objectContaining({
        goldenTemplateId: "golden-template-sheet",
        projectSerial: "109",
      }),
    );
  });

  it("falls back to GOOGLE_SHEET_TEMPLATE_ID when GOLDEN_TEMPLATE_ID is missing", async () => {
    delete process.env.GOLDEN_TEMPLATE_ID;

    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);
    mockBootstrapProjectSpreadsheet.mockResolvedValue({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });
    const projectsTable = mockProjectsTable();
    mockCreateClient.mockReturnValue({
      from: projectsTable.mockFrom,
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockBootstrapProjectSpreadsheet).toHaveBeenCalledWith(
      expect.objectContaining({
        goldenTemplateId: "legacy-template-sheet",
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("uses NEXT_PUBLIC_SUPABASE_URL as the backend Supabase URL fallback", async () => {
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://public-supabase.example.com";

    const { createClient } = await import("@supabase/supabase-js");
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    mockCreateClient.mockReturnValue({ from: jest.fn() } as never);

    await loadHandler();

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://public-supabase.example.com",
      "service-role-key",
    );
  });

  it("cleans up the copied spreadsheet when the database insert fails", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet, cleanupProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;
    const mockCleanupProjectSpreadsheet =
      cleanupProjectSpreadsheet as jest.MockedFunction<typeof cleanupProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com", sub: "user-sub-123" },
    } as never);
    mockBootstrapProjectSpreadsheet.mockResolvedValue({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });

    const projectsTable = mockProjectsTable({
      insertResult: {
        data: null,
        error: { message: "insert failed" },
      },
    });
    mockCreateClient.mockReturnValue({
      from: projectsTable.mockFrom,
    } as never);

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockCleanupProjectSpreadsheet).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to record project in database" });
  });

  it("returns 500 when the authenticated session does not include a stable user sub", async () => {
    const { getServerSession } = await import("next-auth/next");
    const { createClient } = await import("@supabase/supabase-js");
    const { bootstrapProjectSpreadsheet, cleanupProjectSpreadsheet } = await import("@/lib/project-bootstrap");

    const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
    const mockBootstrapProjectSpreadsheet =
      bootstrapProjectSpreadsheet as jest.MockedFunction<typeof bootstrapProjectSpreadsheet>;
    const mockCleanupProjectSpreadsheet =
      cleanupProjectSpreadsheet as jest.MockedFunction<typeof cleanupProjectSpreadsheet>;

    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    const projectsTable = mockProjectsTable();
    mockCreateClient.mockReturnValue({
      from: projectsTable.mockFrom,
    } as never);
    mockBootstrapProjectSpreadsheet.mockResolvedValue({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });

    const handler = await loadHandler();
    const req = {
      method: "POST",
      body: {
        projectShortName: "Project Atlas",
        projectOwner: "Owner Name",
        projectSerial: "109",
      },
    } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockCleanupProjectSpreadsheet).toHaveBeenCalledWith("sheet-123");
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to resolve user identity" });
  });
});
