import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import confirmHandler from "../pages/api/external_import/confirm";
import previewHandler from "../pages/api/external_import/preview";
import statusHandler from "../pages/api/external_import/status";

import { getExternalImportStatus } from "@/lib/external-import/import-manifest-service";
import { ProjectAccessError, requireProjectAccess, requireProjectCollaborator } from "@/lib/project-access";

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
    requireProjectAccess: jest.fn(),
    requireProjectCollaborator: jest.fn(),
  };
});

jest.mock(
  "@/lib/external-import/import-manifest-service",
  () => ({
    getExternalImportStatus: jest.fn(),
  }),
  { virtual: true },
);

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockGetExternalImportStatus = getExternalImportStatus as jest.MockedFunction<typeof getExternalImportStatus>;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

describe("/api/external_import/preview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("rejects unauthenticated preview requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "未登录" });
    expect(mockRequireProjectCollaborator).not.toHaveBeenCalled();
  });

  it("requires collaborator access before parsing uploaded files", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);
    mockRequireProjectCollaborator.mockRejectedValue(
      new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN"),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "reader@example.com");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });
});

describe("/api/external_import/confirm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("requires collaborator access before creating an import job", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "commenter@example.com" },
    } as never);
    mockRequireProjectCollaborator.mockRejectedValue(
      new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN"),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: "hash-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "commenter@example.com");
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });
});

describe("/api/external_import/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: false,
      isDriveOwner: false,
      driveRole: "reader",
    });
    mockGetExternalImportStatus.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      job_id: null,
      status: "not_started",
      job: null,
      manifest: null,
      manifest_items: [],
    });
  });

  it("uses project access, not collaborator access, for status polling", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", job_id: "job-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await statusHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "reader@example.com");
    expect(mockRequireProjectCollaborator).not.toHaveBeenCalled();
  });

  it("calls the import manifest service with spreadsheet id and job id", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", job_id: "job-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await statusHandler(req, res);

    expect(mockGetExternalImportStatus).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      jobId: "job-123",
    });
  });

  it("calls the import manifest service without job id when omitted", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await statusHandler(req, res);

    expect(mockGetExternalImportStatus).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      jobId: undefined,
    });
  });

  it("returns the latest job and manifest payload from the service", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);
    const payload = {
      spreadsheet_id: "sheet-123",
      job_id: "job-123",
      status: "succeeded",
      job: {
        id: "job-123",
        status: "succeeded",
        progress: 100,
      },
      manifest: {
        id: "manifest-123",
        job_id: "job-123",
        spreadsheet_id: "sheet-123",
        status: "parsed",
      },
      manifest_items: [
        {
          id: "item-123",
          manifest_id: "manifest-123",
          job_id: "job-123",
          spreadsheet_id: "sheet-123",
          source_table: "income_statement",
          status: "parsed",
          imported_at: "2026-04-27T10:00:00.000Z",
        },
      ],
    };
    mockGetExternalImportStatus.mockResolvedValue(payload);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", job_id: "job-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await statusHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  it("returns the ProjectAccessError status and code when project access is forbidden", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);
    mockRequireProjectAccess.mockRejectedValue(
      new ProjectAccessError("Project read access is forbidden.", 403, "PROJECT_ACCESS_FORBIDDEN"),
    );

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await statusHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project read access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
    expect(mockGetExternalImportStatus).not.toHaveBeenCalled();
  });
});
