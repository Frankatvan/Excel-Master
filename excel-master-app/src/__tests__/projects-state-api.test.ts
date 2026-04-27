import type { NextApiRequest, NextApiResponse } from "next";

import handler from "../pages/api/projects/state";

import { getServerSession } from "next-auth/next";
import { getProjectState } from "@/lib/project-state-sheet";
import { ProjectAccessError, requireProjectAccess } from "@/lib/project-access";
import { WORKBENCH_STAGES } from "@/lib/workbench-stage";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/project-state-sheet", () => ({
  getProjectState: jest.fn(),
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
  };
});

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockGetProjectState = getProjectState as jest.MockedFunction<typeof getProjectState>;
const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

describe("/api/projects/state", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("rejects non-GET requests with 405", async () => {
    const req = {
      method: "POST",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "请求方法不支持" });
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "未登录" });
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });

  it("rejects missing spreadsheet ids with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);

    const req = {
      method: "GET",
      query: {},
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("spreadsheet"),
      }),
    );
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });

  it("returns project state with Drive access metadata for the authenticated user", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: false,
      isDriveOwner: true,
      driveRole: "owner",
    });
    const state = {
      current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      external_data_dirty: false,
      manual_input_dirty: false,
      locked: false,
      owner_email: "legacy-owner@example.com",
      is_owner_or_admin: false,
    };
    mockGetProjectState.mockResolvedValue(state);

    const req = {
      method: "GET",
      query: { spreadsheet_id: " sheet-123 " },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "owner@example.com");
    expect(mockGetProjectState).toHaveBeenCalledWith("sheet-123", "owner@example.com");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      state: {
        ...state,
        can_write: false,
        drive_role: "owner",
        is_drive_owner: true,
        is_owner_or_admin: true,
      },
    });
  });

  it("denies forbidden project access before reading state", async () => {
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

    await handler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockGetProjectState).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});
