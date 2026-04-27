import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";

import auditSnapshotsHandler from "../pages/api/audit_snapshots";
import auditSnapshotDiffHandler from "../pages/api/audit_snapshots/diff";
import auditSnapshotPromoteHandler from "../pages/api/audit_snapshots/promote";

import {
  getAuditSnapshotDiff,
  listAuditSnapshots,
  promoteAuditSnapshotToCurrent,
} from "@/lib/audit-service";
import { ProjectAccessError, requireProjectAccess, requireProjectCollaborator } from "@/lib/project-access";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/audit-service", () => ({
  listAuditSnapshots: jest.fn(),
  getAuditSnapshotDiff: jest.fn(),
  promoteAuditSnapshotToCurrent: jest.fn(),
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
const mockListAuditSnapshots = listAuditSnapshots as jest.MockedFunction<typeof listAuditSnapshots>;
const mockGetAuditSnapshotDiff = getAuditSnapshotDiff as jest.MockedFunction<typeof getAuditSnapshotDiff>;
const mockPromoteAuditSnapshotToCurrent =
  promoteAuditSnapshotToCurrent as jest.MockedFunction<typeof promoteAuditSnapshotToCurrent>;
const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

describe("/api/audit_snapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("returns history snapshots for an authenticated request", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockListAuditSnapshots.mockResolvedValue({
      project_id: "project-1",
      spreadsheet_id: "sheet-123",
      items: [
        {
          snapshot_id: "snapshot-1",
          sync_run_id: "run-1",
          created_at: "2026-04-26T01:00:00.000Z",
          is_current: true,
          sync_run_status: "succeeded",
          source_last_edit_at: "2026-04-26T00:59:00.000Z",
          decision_count: 150,
          formula_template_count: 0,
        },
      ],
    });

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", limit: "10" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSnapshotsHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockListAuditSnapshots).toHaveBeenCalledWith("sheet-123", 10);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      project_id: "project-1",
      spreadsheet_id: "sheet-123",
      items: [
        {
          snapshot_id: "snapshot-1",
          sync_run_id: "run-1",
          created_at: "2026-04-26T01:00:00.000Z",
          is_current: true,
          sync_run_status: "succeeded",
          source_last_edit_at: "2026-04-26T00:59:00.000Z",
          decision_count: 150,
          formula_template_count: 0,
        },
      ],
    });
  });

  it("denies forbidden project access before listing snapshots", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "blocked@example.com" },
    } as never);
    mockRequireProjectAccess.mockRejectedValue(
      new ProjectAccessError("Project access is forbidden.", 403, "PROJECT_ACCESS_FORBIDDEN"),
    );

    const req = {
      method: "GET",
      query: { spreadsheet_id: "sheet-123", limit: "10" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSnapshotsHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockListAuditSnapshots).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});

describe("/api/audit_snapshots/diff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectAccess.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("returns snapshot diff summary for valid query", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockGetAuditSnapshotDiff.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      current_snapshot_id: "snapshot-current",
      target_snapshot_id: "snapshot-target",
      decision_change_count: 12,
      table_change_counts: {
        payable: 7,
        final_detail: 5,
      },
      formula_template_change_count: 3,
    });

    const req = {
      method: "GET",
      query: {
        spreadsheet_id: "sheet-123",
        target_snapshot_id: "snapshot-target",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSnapshotDiffHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockGetAuditSnapshotDiff).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      targetSnapshotId: "snapshot-target",
      currentSnapshotId: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      spreadsheet_id: "sheet-123",
      current_snapshot_id: "snapshot-current",
      target_snapshot_id: "snapshot-target",
      decision_change_count: 12,
      table_change_counts: {
        payable: 7,
        final_detail: 5,
      },
      formula_template_change_count: 3,
    });
  });

  it("denies forbidden project access before reading a snapshot diff", async () => {
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
        target_snapshot_id: "snapshot-target",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSnapshotDiffHandler(req, res);

    expect(mockRequireProjectAccess).toHaveBeenCalledWith("sheet-123", "blocked@example.com");
    expect(mockGetAuditSnapshotDiff).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project access is forbidden.",
      code: "PROJECT_ACCESS_FORBIDDEN",
    });
  });
});

describe("/api/audit_snapshots/promote", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("promotes target snapshot after safety checks", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "tester@example.com" },
    } as never);
    mockPromoteAuditSnapshotToCurrent.mockResolvedValue({
      spreadsheet_id: "sheet-123",
      snapshot_id: "snapshot-target",
      previous_snapshot_id: "snapshot-current",
      promoted_at: "2026-04-26T02:00:00.000Z",
    });

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        snapshot_id: "snapshot-target",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSnapshotPromoteHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
    expect(mockPromoteAuditSnapshotToCurrent).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      snapshotId: "snapshot-target",
      actorEmail: "tester@example.com",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      spreadsheet_id: "sheet-123",
      snapshot_id: "snapshot-target",
      previous_snapshot_id: "snapshot-current",
      promoted_at: "2026-04-26T02:00:00.000Z",
    });
  });

  it("denies readers before promoting a snapshot", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "reader@example.com" },
    } as never);
    mockRequireProjectCollaborator.mockRejectedValue(
      new ProjectAccessError("Project write access is forbidden.", 403, "PROJECT_WRITE_FORBIDDEN"),
    );

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        snapshot_id: "snapshot-target",
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await auditSnapshotPromoteHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "reader@example.com");
    expect(mockPromoteAuditSnapshotToCurrent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Project write access is forbidden.",
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });
});
