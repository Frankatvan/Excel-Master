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

jest.mock("@/lib/project-access", () => ({
  getProjectAccess: jest.fn(),
}));

const originalEnv = process.env;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

async function loadHandler() {
  const mod = await import("../pages/api/projects/list");
  return mod.default;
}

async function mockSession(email: string | null) {
  const { getServerSession } = await import("next-auth/next");
  const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
  mockGetServerSession.mockResolvedValue(
    email
      ? ({
          user: {
            email,
          },
        } as never)
      : null,
  );
}

async function mockProjectAccess(accessBySpreadsheetId: Record<string, boolean | Error>) {
  const { getProjectAccess } = await import("@/lib/project-access");
  const mockGetProjectAccess = getProjectAccess as jest.MockedFunction<typeof getProjectAccess>;
  mockGetProjectAccess.mockImplementation(async (spreadsheetId: string) => {
    const access = accessBySpreadsheetId[spreadsheetId];
    if (access instanceof Error) {
      throw access;
    }

    return {
      canAccess: access === true,
      permission: null,
      role: access === true ? "writer" : null,
    } as never;
  });

  return mockGetProjectAccess;
}

async function mockSupabase({
  projects,
  projectsError,
}: {
  projects: Array<Record<string, unknown>>;
  projectsError?: { code?: string; message?: string } | null;
}) {
  const { createClient } = await import("@supabase/supabase-js");
  const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

  const mockProjectsOrder = jest.fn().mockResolvedValue({
    data: projects,
    error: projectsError ?? null,
  });
  const mockProjectsSelect = jest.fn().mockReturnValue({
    order: mockProjectsOrder,
  });

  const mockFrom = jest.fn().mockImplementation((table: string) => {
    if (table === "projects") {
      return { select: mockProjectsSelect };
    }

    throw new Error(`Unexpected table: ${table}`);
  });

  mockCreateClient.mockReturnValue({
    from: mockFrom,
  } as never);

  return {
    mockCreateClient,
    mockFrom,
    mockProjectsSelect,
    mockProjectsOrder,
  };
}

describe("/api/projects/list", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns 401 when the request is unauthenticated", async () => {
    await mockSession(null);

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("returns empty mode when the authenticated user has zero accessible projects", async () => {
    await mockSession("owner@example.com");
    await mockSupabase({
      projects: [],
    });
    const getProjectAccess = await mockProjectAccess({});

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "empty", projects: [] });
    expect(getProjectAccess).not.toHaveBeenCalled();
  });

  it("returns only projects where Drive permission canAccess is true", async () => {
    await mockSession("owner@example.com");
    const visibleProject = {
      id: "project-1",
      name: "Project Atlas",
      spreadsheet_id: "sheet-1",
      sheet_109_title: "109",
      project_sequence: "109",
      owner_email: "someone-else@example.com",
      created_at: "2026-04-23T08:00:00.000Z",
    };
    const hiddenProject = {
      id: "project-2",
      name: "Project Beacon",
      spreadsheet_id: "sheet-2",
      sheet_109_title: "110",
      project_sequence: "110",
      owner_email: "owner@example.com",
      created_at: "2026-04-23T08:30:00.000Z",
    };
    const blankSpreadsheetProject = {
      id: "project-3",
      name: "Project No Sheet",
      spreadsheet_id: "",
      sheet_109_title: "111",
      project_sequence: "111",
      owner_email: "owner@example.com",
      created_at: "2026-04-23T09:00:00.000Z",
    };
    const supabase = await mockSupabase({
      projects: [hiddenProject, blankSpreadsheetProject, visibleProject],
    });
    const getProjectAccess = await mockProjectAccess({
      "sheet-1": true,
      "sheet-2": false,
    });

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(supabase.mockProjectsSelect).toHaveBeenCalledWith(
      "id,name,spreadsheet_id,sheet_109_title,project_sequence,owner_email,created_at",
    );
    expect(supabase.mockProjectsOrder).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(getProjectAccess).toHaveBeenCalledWith("sheet-2", "owner@example.com");
    expect(getProjectAccess).toHaveBeenCalledWith("sheet-1", "owner@example.com");
    expect(getProjectAccess).not.toHaveBeenCalledWith("", expect.anything());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "direct", projects: [visibleProject] });
  });

  it("returns empty mode when no listed projects have Drive permission", async () => {
    await mockSession("owner@example.com");
    const project = {
      id: "project-1",
      name: "Project Atlas",
      spreadsheet_id: "sheet-1",
      sheet_109_title: "109",
      project_sequence: "109",
      owner_email: "owner@example.com",
      created_at: "2026-04-23T08:00:00.000Z",
    };
    await mockSupabase({
      projects: [project],
    });
    await mockProjectAccess({ "sheet-1": false });

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "empty", projects: [] });
  });

  it("skips a project when Drive permission lookup fails", async () => {
    await mockSession("owner@example.com");
    const project = {
      id: "project-1",
      name: "Project Atlas",
      spreadsheet_id: "sheet-1",
      sheet_109_title: "109",
      project_sequence: "109",
      owner_email: "owner@example.com",
      created_at: "2026-04-23T08:00:00.000Z",
    };
    await mockSupabase({
      projects: [project],
    });
    await mockProjectAccess({ "sheet-1": new Error("Drive unavailable") });
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "empty", projects: [] });
    expect(warnSpy).toHaveBeenCalledWith(
      "Project access lookup failed:",
      expect.objectContaining({ spreadsheetId: "sheet-1" }),
    );
    warnSpy.mockRestore();
  });

  it("returns summary mode when the authenticated user has multiple accessible projects", async () => {
    await mockSession("owner@example.com");
    const projects = [
      {
        id: "project-1",
        name: "Project Atlas",
        spreadsheet_id: "sheet-1",
        sheet_109_title: "109",
        project_sequence: "109",
        owner_email: "owner@example.com",
        created_at: "2026-04-23T08:00:00.000Z",
      },
      {
        id: "project-2",
        name: "Project Beacon",
        spreadsheet_id: "sheet-2",
        sheet_109_title: "110",
        project_sequence: "110",
        owner_email: "owner@example.com",
        created_at: "2026-04-23T08:30:00.000Z",
      },
    ];
    await mockSupabase({
      projects,
    });
    await mockProjectAccess({
      "sheet-1": true,
      "sheet-2": true,
    });

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "summary", projects });
  });

  it("falls back to querying without project_sequence when the column is missing", async () => {
    await mockSession("owner@example.com");
    const { createClient } = await import("@supabase/supabase-js");
    const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

    const project = {
      id: "project-1",
      name: "Project Atlas",
      spreadsheet_id: "sheet-1",
      sheet_109_title: "109",
      project_sequence: null,
      owner_email: "owner@example.com",
      created_at: "2026-04-23T08:00:00.000Z",
    };

    const mockOrder = jest
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: "42703", message: "column projects.project_sequence does not exist" },
      })
      .mockResolvedValueOnce({
        data: [project],
        error: null,
      });
    const mockSelect = jest.fn().mockReturnValue({ order: mockOrder });
    const mockFrom = jest.fn().mockReturnValue({ select: mockSelect });
    mockCreateClient.mockReturnValue({ from: mockFrom } as never);
    await mockProjectAccess({ "sheet-1": true });

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockSelect).toHaveBeenNthCalledWith(
      1,
      "id,name,spreadsheet_id,sheet_109_title,project_sequence,owner_email,created_at",
    );
    expect(mockSelect).toHaveBeenNthCalledWith(2, "id,name,spreadsheet_id,sheet_109_title,owner_email,created_at");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "direct", projects: [project] });
  });

  it("permission-filters the legacy Sandy Cove fallback when the projects table is missing", async () => {
    await mockSession("frankz@wanbridgegroup.com");
    await mockSupabase({
      projects: [],
      projectsError: { code: "PGRST205", message: "missing table" },
    });
    process.env.GOOGLE_SHEET_ID = "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw";
    const getProjectAccess = await mockProjectAccess({
      "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw": true,
    });

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(getProjectAccess).toHaveBeenCalledWith(
      "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw",
      "frankz@wanbridgegroup.com",
    );
    expect(res.json).toHaveBeenCalledWith({
      mode: "direct",
      projects: [
        {
          id: "legacy-1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw",
          name: "WBWT Sandy Cove",
          spreadsheet_id: "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw",
          sheet_109_title: "",
          project_sequence: undefined,
          owner_email: "frankz@wanbridgegroup.com",
        },
      ],
    });
  });

  it("returns empty when legacy fallback Drive permission is denied", async () => {
    await mockSession("frankz@wanbridgegroup.com");
    await mockSupabase({
      projects: [],
      projectsError: { code: "PGRST205", message: "missing table" },
    });
    process.env.GOOGLE_SHEET_ID = "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw";
    await mockProjectAccess({
      "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw": false,
    });

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ mode: "empty", projects: [] });
  });

  it("returns 405 when method is not GET", async () => {
    const handler = await loadHandler();
    const req = { method: "POST" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "Method not allowed" });
  });

  it("returns 500 when projects lookup fails with a database error", async () => {
    await mockSession("owner@example.com");
    const supabase = await mockSupabase({
      projects: [],
      projectsError: { message: "query failed" },
    });
    await mockProjectAccess({});

    const handler = await loadHandler();
    const req = { method: "GET" } as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(supabase.mockProjectsOrder).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to load projects" });
  });
});
