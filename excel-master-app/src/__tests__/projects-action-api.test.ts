import type { NextApiRequest, NextApiResponse } from "next";

import handler from "../pages/api/projects/action";

import { getServerSession } from "next-auth/next";
import { renameProjectSpreadsheetFile } from "@/lib/project-bootstrap";
import {
  buildProjectLedgerFileName,
  getProjectRegistryProject,
  resolveProjectMainSheetTitle,
} from "@/lib/project-registry";
import { appendAuditLog, getProjectState, writeProjectState, type ProjectState } from "@/lib/project-state-sheet";
import { ProjectAccessError, requireDriveOwner, requireProjectCollaborator } from "@/lib/project-access";
import { WORKBENCH_STAGES } from "@/lib/workbench-stage";

jest.mock("next-auth/next", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("../pages/api/auth/[...nextauth]", () => ({
  authOptions: {},
}));

jest.mock("@/lib/project-state-sheet", () => ({
  appendAuditLog: jest.fn(),
  getProjectState: jest.fn(),
  writeProjectState: jest.fn(),
}));

jest.mock("@/lib/project-bootstrap", () => ({
  renameProjectSpreadsheetFile: jest.fn(),
}));

jest.mock("@/lib/project-registry", () => ({
  buildProjectLedgerFileName: jest.fn(),
  getProjectRegistryProject: jest.fn(),
  resolveProjectMainSheetTitle: jest.fn(),
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
    requireDriveOwner: jest.fn(),
    requireProjectCollaborator: jest.fn(),
  };
});

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockGetProjectState = getProjectState as jest.MockedFunction<typeof getProjectState>;
const mockWriteProjectState = writeProjectState as jest.MockedFunction<typeof writeProjectState>;
const mockAppendAuditLog = appendAuditLog as jest.MockedFunction<typeof appendAuditLog>;
const mockRequireDriveOwner = requireDriveOwner as jest.MockedFunction<typeof requireDriveOwner>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockRenameProjectSpreadsheetFile = renameProjectSpreadsheetFile as jest.MockedFunction<
  typeof renameProjectSpreadsheetFile
>;
const mockBuildProjectLedgerFileName = buildProjectLedgerFileName as jest.MockedFunction<typeof buildProjectLedgerFileName>;
const mockGetProjectRegistryProject = getProjectRegistryProject as jest.MockedFunction<typeof getProjectRegistryProject>;
const mockResolveProjectMainSheetTitle = resolveProjectMainSheetTitle as jest.MockedFunction<
  typeof resolveProjectMainSheetTitle
>;
const originalFetch = global.fetch;
const originalProjectBootstrapWorkerUrl = process.env.PROJECT_BOOTSTRAP_WORKER_URL;
const originalProjectBootstrapWorkerSecret = process.env.PROJECT_BOOTSTRAP_WORKER_SECRET;
const originalAiwbWorkerSecret = process.env.AIWB_WORKER_SECRET;

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

function createState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
    external_data_dirty: false,
    manual_input_dirty: false,
    locked: false,
    owner_email: "owner@example.com",
    last_external_edit_at: "2026-04-20T00:00:00.000Z",
    last_external_edit_by: "external@example.com",
    last_manual_edit_at: "2026-04-21T00:00:00.000Z",
    last_manual_edit_by: "manual@example.com",
    last_sync_at: "2026-04-21T01:00:00.000Z",
    last_validate_input_at: "2026-04-21T02:00:00.000Z",
    is_owner_or_admin: true,
    ...overrides,
  };
}

function toPersistedExpectation(state: ProjectState) {
  const { is_owner_or_admin: _ignored, ...persisted } = state;
  return persisted;
}

describe("/api/projects/action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-04-23T09:10:11.000Z"));
    global.fetch = jest.fn();
    mockWriteProjectState.mockResolvedValue(undefined);
    mockAppendAuditLog.mockResolvedValue(undefined);
    mockRenameProjectSpreadsheetFile.mockResolvedValue(undefined);
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
    mockRequireDriveOwner.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: true,
      driveRole: "owner",
    });
    mockBuildProjectLedgerFileName.mockReturnValue("Project Ledger_109_Project Atlas_4.23.2026");
    mockGetProjectRegistryProject.mockResolvedValue({
      name: "Project Atlas",
      sheet_109_title: "109",
    });
    mockResolveProjectMainSheetTitle.mockReturnValue("109");
    process.env.PROJECT_BOOTSTRAP_WORKER_URL = "https://worker.example.com/project_bootstrap";
    process.env.PROJECT_BOOTSTRAP_WORKER_SECRET = "test-worker-secret";
    delete process.env.AIWB_WORKER_SECRET;
  });

  afterEach(() => {
    jest.useRealTimers();

    if (typeof originalProjectBootstrapWorkerUrl === "string") {
      process.env.PROJECT_BOOTSTRAP_WORKER_URL = originalProjectBootstrapWorkerUrl;
    } else {
      delete process.env.PROJECT_BOOTSTRAP_WORKER_URL;
    }

    if (typeof originalProjectBootstrapWorkerSecret === "string") {
      process.env.PROJECT_BOOTSTRAP_WORKER_SECRET = originalProjectBootstrapWorkerSecret;
    } else {
      delete process.env.PROJECT_BOOTSTRAP_WORKER_SECRET;
    }

    if (typeof originalAiwbWorkerSecret === "string") {
      process.env.AIWB_WORKER_SECRET = originalAiwbWorkerSecret;
    } else {
      delete process.env.AIWB_WORKER_SECRET;
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("rejects non-POST requests with 405", async () => {
    const req = {
      method: "GET",
      body: { spreadsheet_id: "sheet-123", action: "approve_109" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: "请求方法不支持" });
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "approve_109" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "未登录" });
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });

  it("rejects requests missing spreadsheet ids with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: { action: "approve_109" },
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

  it("rejects requests missing actions with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("action"),
      }),
    );
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });

  it("records approve_109 and locks clean data", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    const state = createState({
      current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      is_owner_or_admin: false,
    });
    mockGetProjectState.mockResolvedValue(state);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "approve_109" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    const expectedState = {
      ...toPersistedExpectation(state),
      current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
      locked: true,
      locked_at: "2026-04-23T09:10:11.000Z",
      locked_by: "actor@example.com",
      last_109_initial_approval_at: "2026-04-23T09:10:11.000Z",
    };
    const persistedState = mockWriteProjectState.mock.calls[0][1];
    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "actor@example.com");
    expect(mockRequireDriveOwner).not.toHaveBeenCalled();
    expect(mockGetProjectState).toHaveBeenCalledWith("sheet-123", "actor@example.com");
    expect(persistedState).toEqual(expect.objectContaining(expectedState));
    expect(persistedState).not.toHaveProperty("is_owner_or_admin");
    expect(mockAppendAuditLog).toHaveBeenCalledWith("sheet-123", {
      actor_email: "actor@example.com",
      action: "approve_109",
      previous_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      next_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
      status: "success",
      message: "Audit confirmation recorded and data locked.",
    });
    expect(mockGetProjectRegistryProject).toHaveBeenCalledWith("sheet-123");
    expect(mockBuildProjectLedgerFileName).toHaveBeenCalledWith({
      projectSerial: "109",
      projectName: "Project Atlas",
      createdAt: expect.any(Date),
    });
    expect(mockRenameProjectSpreadsheetFile).toHaveBeenCalledWith(
      "sheet-123",
      "Project Ledger_109_Project Atlas_4.23.2026",
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ state: persistedState });
  });

  it("rejects approve_109 when source data is dirty", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "approve_109" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(String),
      }),
    );
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("rejects approve_109 when manual input is dirty", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        manual_input_dirty: true,
      }),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "approve_109" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(String),
      }),
    );
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("rejects unlock_data when Drive owner access is denied before loading state", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockRequireDriveOwner.mockRejectedValue(
      new ProjectAccessError("Drive owner access is required.", 403, "DRIVE_OWNER_REQUIRED"),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "unlock_data" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(mockRequireDriveOwner).toHaveBeenCalledWith("sheet-123", "actor@example.com");
    expect(mockRequireProjectCollaborator).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Drive owner access is required.",
      code: "DRIVE_OWNER_REQUIRED",
    });
    expect(mockGetProjectState).not.toHaveBeenCalled();
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("unlocks data for owners", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "owner@example.com" },
    } as never);
    const state = createState({
      locked: true,
      current_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
      external_data_dirty: true,
      manual_input_dirty: true,
      locked_at: "2026-04-22T09:10:11.000Z",
      locked_by: "reviewer@example.com",
      is_owner_or_admin: true,
    });
    mockGetProjectState.mockResolvedValue(state);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "unlock_data" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    const expectedState = {
      ...toPersistedExpectation(state),
      current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      locked: false,
      unlocked_at: "2026-04-23T09:10:11.000Z",
      unlocked_by: "owner@example.com",
    };
    const persistedState = mockWriteProjectState.mock.calls[0][1];
    expect(mockRequireDriveOwner).toHaveBeenCalledWith("sheet-123", "owner@example.com");
    expect(persistedState).toEqual(expect.objectContaining(expectedState));
    expect(persistedState).not.toHaveProperty("is_owner_or_admin");
    expect(mockAppendAuditLog).toHaveBeenCalledWith("sheet-123", {
      actor_email: "owner@example.com",
      action: "unlock_data",
      previous_stage: WORKBENCH_STAGES.LOCKED_109_APPROVED,
      next_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      status: "success",
      message: "Data unlocked by project owner.",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ state: persistedState });
  });

  it("calls the worker for validate_input and advances to external_data_ready", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    const state = createState({
      current_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      external_data_dirty: true,
      locked: true,
      is_owner_or_admin: false,
    });
    mockGetProjectState.mockResolvedValue(state);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: "success",
          summary: {
            unit_master_rows_written: 12,
            unit_budget_layout_request_count: 4,
          },
        }),
      ),
    });

    const req = {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    const persistedState = mockWriteProjectState.mock.calls[0][1];
    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "actor@example.com");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/project_bootstrap",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AiWB-Worker-Secret": "test-worker-secret",
        },
        body: JSON.stringify({
          operation: "validate_input",
          spreadsheet_id: "sheet-123",
        }),
      }),
    );
    expect(persistedState).toEqual(
      expect.objectContaining({
        ...toPersistedExpectation(state),
        current_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
        external_data_dirty: false,
        locked: false,
        last_validate_input_at: "2026-04-23T09:10:11.000Z",
      }),
    );
    expect(persistedState).not.toHaveProperty("is_owner_or_admin");
    expect(mockAppendAuditLog).toHaveBeenCalledWith("sheet-123", {
      actor_email: "actor@example.com",
      action: "validate_input",
      previous_stage: WORKBENCH_STAGES.MANUAL_INPUT_READY,
      next_stage: WORKBENCH_STAGES.EXTERNAL_DATA_READY,
      status: "success",
      message: "Input data validated and generated.",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      state: persistedState,
      summary: {
        unit_master_rows_written: 12,
        unit_budget_layout_request_count: 4,
      },
    });
  });

  it("returns 502 for validate_input worker failures without writing state or logs", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue(JSON.stringify({ message: "worker failed" })),
    });

    const req = {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "验证录入数据失败" });
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 502 for validate_input when worker URL is missing without calling fetch/state/log", async () => {
    delete process.env.PROJECT_BOOTSTRAP_WORKER_URL;

    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "验证录入数据失败" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 500 for validate_input when the worker secret is missing without calling fetch", async () => {
    delete process.env.PROJECT_BOOTSTRAP_WORKER_SECRET;
    delete process.env.AIWB_WORKER_SECRET;

    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Worker secret is not configured." });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 502 for validate_input worker status error payloads without writing state or logs", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ status: "error", message: "failed" })),
    });

    const req = {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "验证录入数据失败" });
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 502 for validate_input malformed JSON responses without writing state or logs", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue("<html>bad gateway</html>"),
    });

    const req = {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "验证录入数据失败" });
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 502 for validate_input fetch rejection without writing state or logs", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));

    const req = {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "验证录入数据失败" });
    expect(mockWriteProjectState).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
  });

  it("preserves manual_input_dirty when validate_input succeeds", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    const state = createState({
      external_data_dirty: true,
      manual_input_dirty: true,
    });
    mockGetProjectState.mockResolvedValue(state);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ status: "success", summary: {} })),
    });

    const req = {
      method: "POST",
      headers: {
        host: "app.example.com",
        "x-forwarded-proto": "https",
      },
      socket: {},
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    const persistedState = mockWriteProjectState.mock.calls[0][1];
    expect(persistedState.manual_input_dirty).toBe(true);
    expect(persistedState.external_data_dirty).toBe(false);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns 502 and does not write state when validate_input audit logging fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);
    mockGetProjectState.mockResolvedValue(
      createState({
        external_data_dirty: true,
      }),
    );
    mockAppendAuditLog.mockRejectedValueOnce(new Error("audit failed"));
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(JSON.stringify({ status: "success", summary: {} })),
    });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "validate_input" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "验证录入数据失败" });
    expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
    expect(mockWriteProjectState).not.toHaveBeenCalled();
  });

  it("rejects unsupported actions with 400", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "actor@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", action: "archive_project" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(String),
      }),
    );
    expect(mockGetProjectState).not.toHaveBeenCalled();
  });
});
