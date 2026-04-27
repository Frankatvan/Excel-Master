import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";

import {
  getProjectAccess,
  ProjectAccessError,
  requireDriveOwner,
  requireProjectAccess,
  requireProjectCollaborator,
  verifyAnyProjectAccess,
} from "@/lib/project-access";

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({ mocked: true })),
    },
    drive: jest.fn(),
  },
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

const mockDrive = google.drive as jest.Mock;
const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const originalEnv = process.env;

function mockProjects(projects: Array<Record<string, unknown>>) {
  const order = jest.fn().mockResolvedValue({ data: projects, error: null });
  const select = jest.fn().mockReturnValue({ order });
  const from = jest.fn((table: string) => {
    if (table !== "projects") {
      throw new Error(`Unexpected table: ${table}`);
    }
    return { select };
  });
  mockCreateClient.mockReturnValue({ from } as never);
  return { from, select, order };
}

function mockDrivePermissions(permissions: Array<{ emailAddress?: string; role?: string }>) {
  const list = jest.fn().mockResolvedValue({ data: { permissions } });
  mockDrive.mockReturnValue({ permissions: { list } });
  return list;
}

describe("project access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      GOOGLE_CLIENT_EMAIL: "service-account@example.com",
      GOOGLE_PRIVATE_KEY: "line1\\nline2",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("grants owner access and owner override", async () => {
    const list = mockDrivePermissions([{ emailAddress: "owner@example.com", role: "owner" }]);

    await expect(getProjectAccess("sheet-1", "OWNER@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: true,
      isDriveOwner: true,
      driveRole: "owner",
    });
    expect(list).toHaveBeenCalledWith({
      fileId: "sheet-1",
      fields: "nextPageToken,permissions(emailAddress,role)",
      supportsAllDrives: true,
    });
  });

  it("grants writer collaborator access without owner override", async () => {
    mockDrivePermissions([{ emailAddress: "writer@example.com", role: "writer" }]);

    await expect(getProjectAccess("sheet-1", "writer@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
  });

  it("grants reader viewing access without write access", async () => {
    mockDrivePermissions([{ emailAddress: "reader@example.com", role: "reader" }]);

    await expect(getProjectAccess("sheet-1", "reader@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: false,
      isDriveOwner: false,
      driveRole: "reader",
    });
  });

  it("denies users missing from the project sheet permissions", async () => {
    mockDrivePermissions([{ emailAddress: "other@example.com", role: "writer" }]);

    await expect(getProjectAccess("sheet-1", "missing@example.com")).resolves.toEqual({
      canAccess: false,
      canWrite: false,
      isDriveOwner: false,
      driveRole: null,
    });
  });

  it("checks paginated Drive permissions until the matching user is found", async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          permissions: [{ emailAddress: "other@example.com", role: "writer" }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          permissions: [{ emailAddress: "paged@example.com", role: "reader" }],
        },
      });
    mockDrive.mockReturnValue({ permissions: { list } });

    await expect(getProjectAccess("sheet-1", "paged@example.com")).resolves.toEqual({
      canAccess: true,
      canWrite: false,
      isDriveOwner: false,
      driveRole: "reader",
    });
    expect(list).toHaveBeenNthCalledWith(1, {
      fileId: "sheet-1",
      fields: "nextPageToken,permissions(emailAddress,role)",
      supportsAllDrives: true,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      fileId: "sheet-1",
      fields: "nextPageToken,permissions(emailAddress,role)",
      supportsAllDrives: true,
      pageToken: "page-2",
    });
  });

  it("requires access for read operations", async () => {
    mockProjects([{ spreadsheet_id: "sheet-1" }]);
    mockDrivePermissions([{ emailAddress: "allowed@example.com", role: "reader" }]);

    await expect(requireProjectAccess("sheet-1", "allowed@example.com")).resolves.toMatchObject({
      canAccess: true,
      canWrite: false,
    });
  });

  it("rejects Drive-authorized users on unregistered spreadsheets", async () => {
    mockProjects([{ spreadsheet_id: "registered-sheet" }]);
    const list = mockDrivePermissions([{ emailAddress: "allowed@example.com", role: "owner" }]);

    await expect(requireProjectAccess("unregistered-sheet", "allowed@example.com")).rejects.toMatchObject({
      statusCode: 404,
      code: "PROJECT_NOT_REGISTERED",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects collaborator-only operations for readers", async () => {
    mockProjects([{ spreadsheet_id: "sheet-1" }]);
    mockDrivePermissions([{ emailAddress: "reader@example.com", role: "reader" }]);

    await expect(requireProjectCollaborator("sheet-1", "reader@example.com")).rejects.toBeInstanceOf(
      ProjectAccessError,
    );
    await expect(requireProjectCollaborator("sheet-1", "reader@example.com")).rejects.toMatchObject({
      statusCode: 403,
      code: "PROJECT_WRITE_FORBIDDEN",
    });
  });

  it("requires Drive owner for owner-only operations", async () => {
    mockProjects([{ spreadsheet_id: "sheet-1" }]);
    mockDrivePermissions([{ emailAddress: "writer@example.com", role: "writer" }]);

    await expect(requireDriveOwner("sheet-1", "writer@example.com")).rejects.toBeInstanceOf(ProjectAccessError);
    await expect(requireDriveOwner("sheet-1", "writer@example.com")).rejects.toMatchObject({
      statusCode: 403,
      code: "DRIVE_OWNER_REQUIRED",
    });
  });

  it("allows login when the user belongs to any registered project sheet", async () => {
    mockProjects([{ spreadsheet_id: "sheet-denied" }, { spreadsheet_id: "sheet-allowed" }]);
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        data: { permissions: [{ emailAddress: "other@example.com", role: "writer" }] },
      })
      .mockResolvedValueOnce({
        data: { permissions: [{ emailAddress: "shared@example.com", role: "reader" }] },
      });
    mockDrive.mockReturnValue({ permissions: { list } });

    await expect(verifyAnyProjectAccess("shared@example.com")).resolves.toBe(true);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("denies login when the user belongs to no registered project sheet", async () => {
    mockProjects([{ spreadsheet_id: "sheet-denied" }]);
    mockDrivePermissions([{ emailAddress: "other@example.com", role: "writer" }]);

    await expect(verifyAnyProjectAccess("missing@example.com")).resolves.toBe(false);
  });
});
