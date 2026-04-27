import type { NextApiRequest } from "next";

import { google } from "googleapis";

import {
  bootstrapProjectSpreadsheet,
  cleanupProjectSpreadsheet,
  renameProjectSpreadsheetFile,
} from "@/lib/project-bootstrap";

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({ mocked: true })),
    },
    drive: jest.fn(),
  },
}));

jest.mock("@/lib/google-service-account", () => ({
  getGoogleServiceAccountCredentials: jest.fn(() => ({
    client_email: "service-account@example.com",
    private_key: "test-private-key",
  })),
}));

const mockDrive = google.drive as jest.Mock;
const originalFetch = global.fetch;
const originalProjectBootstrapWorkerUrl = process.env.PROJECT_BOOTSTRAP_WORKER_URL;
const originalProjectBootstrapWorkerSecret = process.env.PROJECT_BOOTSTRAP_WORKER_SECRET;
const originalAiwbWorkerSecret = process.env.AIWB_WORKER_SECRET;

function buildReq() {
  return {
    headers: {
      host: "app.example.com",
      "x-forwarded-proto": "https",
    },
    socket: {},
  } as unknown as NextApiRequest;
}

describe("project-bootstrap helper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    process.env.PROJECT_BOOTSTRAP_WORKER_URL = "https://worker.example.com/project_bootstrap";
    process.env.PROJECT_BOOTSTRAP_WORKER_SECRET = "test-worker-secret";
    delete process.env.AIWB_WORKER_SECRET;
  });

  afterEach(() => {
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

  it("calls bootstrap_from_template with sequence and short name", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: "success",
          spreadsheet_id: "sheet-123",
          spreadsheet_url: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
        }),
      ),
    });

    const result = await bootstrapProjectSpreadsheet({
      req: buildReq(),
      projectName: "Sandy Cove",
      projectShortName: "Sandy Cove",
      projectOwner: "Frank",
      projectSerial: "110",
      goldenTemplateId: "golden-template-001",
      userEmail: "owner@example.com",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/project_bootstrap",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AiWB-Worker-Secret": "test-worker-secret",
        },
        body: JSON.stringify({
          operation: "bootstrap_from_template",
          project_sequence: "110",
          project_short_name: "Sandy Cove",
          project_name: "Sandy Cove",
          project_owner: "Frank",
          golden_template_id: "golden-template-001",
          creator_email: "owner@example.com",
        }),
      }),
    );
    expect(result).toEqual({
      spreadsheetId: "sheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
    });
  });

  it("fails when golden template id is missing", async () => {
    await expect(
      bootstrapProjectSpreadsheet({
        req: buildReq(),
        projectName: "Sandy Cove",
        projectShortName: "Sandy Cove",
        projectOwner: "Frank",
        projectSerial: "110",
        goldenTemplateId: "",
        userEmail: "owner@example.com",
      }),
    ).rejects.toThrow("Golden template id is required.");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("fails without worker URL", async () => {
    delete process.env.PROJECT_BOOTSTRAP_WORKER_URL;

    await expect(
      bootstrapProjectSpreadsheet({
        req: buildReq(),
        projectName: "Sandy Cove",
        projectShortName: "Sandy Cove",
        projectOwner: "Frank",
        projectSerial: "110",
        goldenTemplateId: "golden-template-001",
        userEmail: "owner@example.com",
      }),
    ).rejects.toThrow("Project bootstrap worker URL is not configured.");
  });

  it("fails without worker secret", async () => {
    delete process.env.PROJECT_BOOTSTRAP_WORKER_SECRET;
    delete process.env.AIWB_WORKER_SECRET;

    await expect(
      bootstrapProjectSpreadsheet({
        req: buildReq(),
        projectName: "Sandy Cove",
        projectShortName: "Sandy Cove",
        projectOwner: "Frank",
        projectSerial: "110",
        goldenTemplateId: "golden-template-001",
        userEmail: "owner@example.com",
      }),
    ).rejects.toThrow("Project bootstrap worker secret is not configured.");
  });

  it("cleans up returned spreadsheet id when worker fails after cloning", async () => {
    const deleteFile = jest.fn().mockResolvedValue({ data: {} });
    mockDrive.mockReturnValue({
      files: {
        delete: deleteFile,
      },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: "error",
          message: "worker failed",
          spreadsheet_id: "sheet-rollback",
        }),
      ),
    });

    await expect(
      bootstrapProjectSpreadsheet({
        req: buildReq(),
        projectName: "Sandy Cove",
        projectShortName: "Sandy Cove",
        projectOwner: "Frank",
        projectSerial: "110",
        goldenTemplateId: "golden-template-001",
        userEmail: "owner@example.com",
      }),
    ).rejects.toThrow("worker failed");

    expect(deleteFile).toHaveBeenCalledWith({
      fileId: "sheet-rollback",
      supportsAllDrives: true,
    });
  });

  it("renames spreadsheet via Drive API", async () => {
    const update = jest.fn().mockResolvedValue({ data: {} });
    mockDrive.mockReturnValue({
      files: {
        update,
      },
    });

    await renameProjectSpreadsheetFile("sheet-1", "Project Ledger_110_Sandy Cove_2026.04.26.xlsx");

    expect(update).toHaveBeenCalledWith({
      fileId: "sheet-1",
      supportsAllDrives: true,
      requestBody: {
        name: "Project Ledger_110_Sandy Cove_2026.04.26.xlsx",
      },
    });
  });

  it("cleans up spreadsheet with shared-drive support", async () => {
    const deleteFile = jest.fn().mockResolvedValue({ data: {} });
    mockDrive.mockReturnValue({
      files: {
        delete: deleteFile,
      },
    });

    await cleanupProjectSpreadsheet("sheet-123");

    expect(deleteFile).toHaveBeenCalledWith({
      fileId: "sheet-123",
      supportsAllDrives: true,
    });
  });
});
