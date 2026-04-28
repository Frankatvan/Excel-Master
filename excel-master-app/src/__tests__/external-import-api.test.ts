import type { NextApiRequest, NextApiResponse } from "next";

import { getServerSession } from "next-auth/next";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

import confirmHandler from "../pages/api/external_import/confirm";
import previewHandler from "../pages/api/external_import/preview";
import statusHandler from "../pages/api/external_import/status";
import uploadHandler from "../pages/api/external_import/upload";

import { savePreviewPayload } from "@/lib/external-import/preview-store";
import { getExternalImportStatus } from "@/lib/external-import/import-manifest-service";
import {
  createImportManifest,
  createImportManifestItem,
  createJob,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
} from "@/lib/job-service";
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

jest.mock("@/lib/job-service", () => ({
  createImportManifest: jest.fn(),
  createImportManifestItem: jest.fn(),
  createJob: jest.fn(),
  markJobFailed: jest.fn(),
  markJobRunning: jest.fn(),
  markJobSucceeded: jest.fn(),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

jest.mock("@/lib/google-service-account", () => ({
  getGoogleServiceAccountCredentials: jest.fn(() => ({ client_email: "robot@example.com", private_key: "key" })),
}));

jest.mock("googleapis", () => ({
  google: {
    auth: { GoogleAuth: jest.fn(() => ({ mocked: true })) },
    sheets: jest.fn(() => ({
      spreadsheets: {
        get: jest.fn().mockResolvedValue({
          data: {
            sheets: [
              {
                properties: { sheetId: 101, title: "Payable" },
                developerMetadata: [
                  {
                    metadataKey: "aiwb.import_zone",
                    metadataValue: JSON.stringify({
                      zone_key: "external_import.payable_raw",
                      source_role: "payable",
                      sheet_role: "Payable",
                      managed_by: "AiWB",
                      schema_version: 1,
                      capacity_policy: "expand_within_managed_sheet",
                      header_signature_policy: "required_semantic_headers",
                      start_row_index: 0,
                      start_column_index: 0,
                      end_row_index: 20000,
                      end_column_index: 50,
                    }),
                  },
                ],
              },
            ],
          },
        }),
      },
    })),
  },
}));

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>;
const mockRequireProjectAccess = requireProjectAccess as jest.MockedFunction<typeof requireProjectAccess>;
const mockRequireProjectCollaborator = requireProjectCollaborator as jest.MockedFunction<
  typeof requireProjectCollaborator
>;
const mockGetExternalImportStatus = getExternalImportStatus as jest.MockedFunction<typeof getExternalImportStatus>;
const mockCreateImportManifest = createImportManifest as jest.MockedFunction<typeof createImportManifest>;
const mockCreateImportManifestItem = createImportManifestItem as jest.MockedFunction<typeof createImportManifestItem>;
const mockCreateJob = createJob as jest.MockedFunction<typeof createJob>;
const mockMarkJobFailed = markJobFailed as jest.MockedFunction<typeof markJobFailed>;
const mockMarkJobRunning = markJobRunning as jest.MockedFunction<typeof markJobRunning>;
const mockMarkJobSucceeded = markJobSucceeded as jest.MockedFunction<typeof markJobSucceeded>;
const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

function mockSupabaseStorage({
  signedUrl = "https://storage.example.com/signed-upload",
  downloadBuffer,
  bucketExists = true,
}: {
  signedUrl?: string;
  downloadBuffer?: Buffer;
  bucketExists?: boolean;
} = {}) {
  const getBucket = jest.fn().mockResolvedValue(
    bucketExists
      ? { data: { id: "external-import-uploads", public: false }, error: null }
      : { data: null, error: new Error("Bucket not found") },
  );
  const createBucket = jest.fn().mockResolvedValue({ data: { name: "external-import-uploads" }, error: null });
  const createSignedUploadUrl = jest.fn().mockResolvedValue({
    data: {
      signedUrl,
      path: "external-import/sheet-123/upload-1/payables.xlsx",
      token: "signed-upload-token",
    },
    error: null,
  });
  const downloadBlobPart = downloadBuffer
    ? (downloadBuffer.buffer.slice(
        downloadBuffer.byteOffset,
        downloadBuffer.byteOffset + downloadBuffer.byteLength,
      ) as ArrayBuffer)
    : null;
  const download = jest.fn().mockResolvedValue({
    data: downloadBlobPart ? new Blob([downloadBlobPart]) : null,
    error: downloadBuffer ? null : new Error("missing fixture"),
  });
  const upload = jest.fn().mockResolvedValue({ data: { path: "external-import/sheet-123/previews/preview.json" }, error: null });
  const remove = jest.fn().mockResolvedValue({ data: [], error: null });
  const storage = {
    getBucket,
    createBucket,
    from: jest.fn(() => ({
      createSignedUploadUrl,
      download,
      upload,
      remove,
    })),
  };
  mockCreateClient.mockReturnValue({ storage } as never);
  return { storage, getBucket, createBucket, createSignedUploadUrl, download, upload, remove };
}

function createMockRes() {
  const res = {} as Partial<NextApiResponse>;
  res.status = jest.fn().mockReturnValue(res as NextApiResponse);
  res.json = jest.fn().mockReturnValue(res as NextApiResponse);
  res.setHeader = jest.fn();
  return res as NextApiResponse;
}

function workbookBuffer(sheets: Array<{ name: string; rows: unknown[][] }>): Buffer {
  const workbook = XLSX.utils.book_new();

  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  });

  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

function readJson(res: NextApiResponse) {
  const jsonMock = res.json as jest.Mock;
  return jsonMock.mock.calls[jsonMock.mock.calls.length - 1][0];
}

describe("/api/external_import/preview", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockCreateClient.mockReset();
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

  it("parses collaborator JSON/base64 files into a preview_ready response", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    process.env.EXTERNAL_IMPORT_WORKER_URL = "https://worker.example.com/external-import";
    process.env.EXTERNAL_IMPORT_WORKER_SECRET = "worker-secret";
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", "$1,200.50", "CA"],
        ],
      },
    ]);

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "writer@example.com");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      status: "preview_ready",
      spreadsheet_id: "sheet-123",
      confirm_allowed: true,
      files: [
        {
          file_name: "payables.xlsx",
          tables: [
            {
              source_role: "payable",
              target_zone_key: "external_import.payable_raw",
              target_zone_id: "external_import.payable_raw",
              row_count: 1,
              blocking_issues: [],
            },
          ],
        },
      ],
    });
    expect(readJson(res).preview_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(readJson(res).worker_configured).toBe(true);
  });

  it("parses collaborator storage upload references without receiving file bytes in the preview request", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const { download } = mockSupabaseStorage({ downloadBuffer: buffer });

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        storage_files: [
          {
            file_name: "payables.xlsx",
            path: "external-import/sheet-123/upload-1/payables.xlsx",
          },
        ],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "writer@example.com");
    expect(download).toHaveBeenCalledWith("external-import/sheet-123/upload-1/payables.xlsx");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      status: "preview_ready",
      spreadsheet_id: "sheet-123",
      files: [
        {
          file_name: "payables.xlsx",
          tables: [
            {
              source_role: "payable",
              target_zone_key: "external_import.payable_raw",
              row_count: 1,
            },
          ],
        },
      ],
    });
  });

  it("rejects storage upload references outside the requested spreadsheet scope", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    mockSupabaseStorage({ downloadBuffer: Buffer.from("unused") });

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        storage_files: [
          {
            file_name: "payables.xlsx",
            path: "external-import/other-sheet/upload-1/payables.xlsx",
          },
        ],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(readJson(res)).toEqual({
      error: "External import upload path is outside the requested spreadsheet scope.",
    });
  });

  it("previews uploaded files while reporting that confirm is unavailable when worker config is missing", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    delete process.env.EXTERNAL_IMPORT_WORKER_URL;
    delete process.env.EXTERNAL_IMPORT_WORKER_SECRET;
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      confirm_allowed: true,
      worker_configured: false,
    });
  });

  it("does not return spreadsheet address literals in the preview payload", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        buffers: [{ name: "payables.xlsx", buffer }],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    const payloadText = JSON.stringify(readJson(res));
    expect(payloadText).toContain("external_import.payable_raw");
    expect(payloadText).not.toMatch(/![A-Z]+[0-9]+|[A-Z]+[0-9]+:[A-Z]+[0-9]+/);
    expect(payloadText).not.toContain("target_address");
  });

  it("marks previews with blocking issues as not confirmable", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [["GuId", "Vendor", "Invoice No", "Amount", "Cost State"]],
      },
    ]);

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ name: "empty-payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(readJson(res)).toMatchObject({
      confirm_allowed: false,
      files: [
        {
          tables: [
            {
              blocking_issues: ["Detected sheet has no data rows."],
            },
          ],
        },
      ],
    });
  });

  it("does not allow confirmation when uploads contain no recognized import tables", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    const buffer = workbookBuffer([
      {
        name: "Unrelated",
        rows: [
          ["Name", "Comment"],
          ["Not an import table", "Ignore me"],
        ],
      },
    ]);

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "notes.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await previewHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      confirm_allowed: false,
      source_tables: [],
    });
  });
});

describe("/api/external_import/upload", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockCreateClient.mockReset();
    mockRequireProjectCollaborator.mockResolvedValue({
      canAccess: true,
      canWrite: true,
      isDriveOwner: false,
      driveRole: "writer",
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  });

  it("creates collaborator-only signed storage upload reservations without receiving file bytes", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    const { createSignedUploadUrl } = mockSupabaseStorage();

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [
          {
            file_name: "_Draw request report_2026-04-27.xlsx",
            content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 23_000_000,
          },
        ],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await uploadHandler(req, res);

    expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "writer@example.com");
    expect(createSignedUploadUrl).toHaveBeenCalledWith(expect.stringMatching(/^external-import\/sheet-123\/[^/]+\/_Draw request report_2026-04-27.xlsx$/), {
      upsert: true,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(readJson(res)).toMatchObject({
      status: "upload_ready",
      spreadsheet_id: "sheet-123",
      bucket: "external-import-uploads",
      files: [
        {
          file_name: "_Draw request report_2026-04-27.xlsx",
          upload_url: "https://storage.example.com/signed-upload",
          token: "signed-upload-token",
          path: expect.stringMatching(/^external-import\/sheet-123\/[^/]+\/_Draw request report_2026-04-27.xlsx$/),
        },
      ],
    });
  });

  it("creates the private upload bucket when staging storage has not been initialized yet", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    const { getBucket, createBucket } = mockSupabaseStorage({ bucketExists: false });

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "draw.xlsx", size: 5_000_000 }],
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await uploadHandler(req, res);

    expect(getBucket).toHaveBeenCalledWith("external-import-uploads");
    expect(createBucket).toHaveBeenCalledWith("external-import-uploads", {
      public: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("/api/external_import/confirm", () => {
  beforeEach(() => {
    process.env.EXTERNAL_IMPORT_WORKER_URL = "https://worker.example.com/external-import";
    process.env.EXTERNAL_IMPORT_WORKER_SECRET = "worker-secret";
    delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    delete process.env.EXTERNAL_IMPORT_INLINE_DISPATCH_MAX_BYTES;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          job_status: "succeeded",
          manifest_status: "validated",
          manifest: [
            {
              source_table: "payable",
              source_file_name: "payables.xlsx",
              source_sheet_name: "Payable",
              file_hash: "file-hash-123",
              header_signature: "header-signature-123",
              row_count: 1,
              column_count: 5,
              amount_total: 100,
              target_zone_key: "external_import.payable_raw",
              resolved_zone_fingerprint: "zone-fingerprint-123",
              status: "imported",
              schema_drift: { extra_columns: [], missing_columns: [] },
            },
          ],
          write_result: { request_count: 2 },
          validation: { ok: true },
        }),
    }) as unknown as typeof fetch;
    jest.useRealTimers();
    jest.clearAllMocks();
    mockCreateImportManifest.mockResolvedValue({ id: "manifest-123", status: "validated" });
    mockCreateImportManifestItem.mockResolvedValue({ id: "manifest-item-123", status: "validated" });
    mockMarkJobRunning.mockResolvedValue({ id: "job-123", status: "running" });
    mockMarkJobSucceeded.mockResolvedValue({ id: "job-123", status: "succeeded" });
    mockMarkJobFailed.mockResolvedValue({ id: "job-123", status: "failed" });
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

  it("requires a valid preview hash or preview payload", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: "missing-hash" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(readJson(res)).toMatchObject({ code: "INVALID_PREVIEW_HASH" });
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("creates an external_import durable job from a confirmed preview", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);
    const preview = readJson(previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: preview.preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateJob).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      jobType: "external_import",
      operation: "external_import",
      createdBy: "writer@example.com",
      payload: expect.objectContaining({
        spreadsheet_id: "sheet-123",
        preview_hash: preview.preview_hash,
        resolved_zones: {
          "external_import.payable_raw": expect.objectContaining({
            zoneKey: "external_import.payable_raw",
            gridRange: expect.objectContaining({ sheetId: 101 }),
          }),
        },
        parsed_table_count: 1,
        source_tables: [
          expect.objectContaining({
            source_role: "payable",
            target_zone_id: "external_import.payable_raw",
            row_count: 1,
          }),
        ],
      }),
    });
    expect(mockCreateJob.mock.calls[0]?.[0].payload).not.toHaveProperty("parsed_tables");
    const workerRequest = JSON.parse(String((global.fetch as jest.Mock).mock.calls[0]?.[1]?.body));
    expect(workerRequest.parsed_tables).toEqual([
      expect.objectContaining({
        source_table: "payable",
        target_zone_key: "external_import.payable_raw",
        rows: [["g-1", "Apex", "INV-1", 100, "CA"]],
      }),
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://worker.example.com/external-import",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-AiWB-Worker-Secret": "worker-secret" }),
      }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "x-vercel-protection-bypass",
    );
    expect(mockMarkJobRunning).toHaveBeenCalledWith({
      jobId: "job-123",
      lockToken: expect.any(String),
    });
    expect(mockCreateImportManifest).toHaveBeenCalledWith({
      jobId: "job-123",
      spreadsheetId: "sheet-123",
      status: "validated",
      importedBy: "writer@example.com",
      resultMeta: {
        validation: { ok: true },
        write_result: { request_count: 2 },
      },
      error: null,
    });
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith({
      manifestId: "manifest-123",
      jobId: "job-123",
      spreadsheetId: "sheet-123",
      sourceTable: "payable",
      sourceFileName: "payables.xlsx",
      sourceSheetName: "Payable",
      fileHash: "file-hash-123",
      headerSignature: "header-signature-123",
      rowCount: 1,
      columnCount: 5,
      amountTotal: 100,
      targetZoneKey: "external_import.payable_raw",
      resolvedZoneFingerprint: "zone-fingerprint-123",
      status: "validated",
      validationMessage: null,
      schemaDrift: { extra_columns: [], missing_columns: [] },
      resultMeta: { worker_status: "imported" },
      error: null,
    });
    expect(mockMarkJobSucceeded).toHaveBeenCalledWith({
      jobId: "job-123",
      result: {
        manifest_id: "manifest-123",
        imported_table_count: 1,
      },
      resultMeta: {
        validation: { ok: true },
        write_result: { request_count: 2 },
      },
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      job_id: "job-123",
      status: "succeeded",
      manifest_id: "manifest-123",
      status_url: "/api/external_import/status?spreadsheet_id=sheet-123&job_id=job-123",
    });
  });

  it("stages large parsed table rows in storage before worker dispatch", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-large-123", status: "queued" });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.EXTERNAL_IMPORT_INLINE_DISPATCH_MAX_BYTES = "1024";
    const { upload } = mockSupabaseStorage();
    const sentinel = "SENTINEL-DRAW-REQUEST-ROW-VALUE";
    const largeRows = Array.from({ length: 120 }, (_, index) => [
      `guid-${index}`,
      sentinel,
      `invoice-${index}`,
      index,
      "CA",
    ]);
    savePreviewPayload({
      status: "preview_ready",
      spreadsheet_id: "sheet-123",
      preview_hash: "large-preview-hash",
      confirm_allowed: true,
      worker_configured: true,
      files: [
        {
          file_name: "draw-request.xlsx",
          file_hash: "file-hash-large",
          tables: [
            {
              source_role: "payable",
              source_sheet_name: "Payable",
              row_count: largeRows.length,
              column_count: 5,
              amount_total: 7140,
              target_zone_key: "external_import.payable_raw",
              target_zone_id: "external_import.payable_raw",
              warnings: [],
              blocking_issues: [],
              headers: ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
              rows: largeRows,
            },
          ],
        },
      ],
      source_tables: [],
    });

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: "large-preview-hash" },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^external-import\/sheet-123\/worker-payloads\/job-large-123\/parsed-tables\.json$/),
      expect.stringContaining(sentinel),
      expect.objectContaining({
        contentType: "application/json",
        upsert: true,
      }),
    );
    const workerBodyText = String((global.fetch as jest.Mock).mock.calls[0]?.[1]?.body);
    const workerBody = JSON.parse(workerBodyText);
    expect(workerBody.parsed_tables).toBeUndefined();
    expect(workerBody.source_tables[0]).not.toHaveProperty("rows");
    expect(workerBody.parsed_tables_ref).toEqual(
      expect.objectContaining({
        bucket: "external-import-uploads",
        path: "external-import/sheet-123/worker-payloads/job-large-123/parsed-tables.json",
        format: "external_import.parsed_tables.v1",
        size_bytes: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(workerBodyText).not.toContain(sentinel);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it("sends the Vercel automation bypass header when configured", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "vercel-bypass-secret";
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect((global.fetch as jest.Mock).mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "X-AiWB-Worker-Secret": "worker-secret",
        "x-vercel-protection-bypass": "vercel-bypass-secret",
      }),
    );
  });

  it("expires stored preview hashes after the short confirmation window", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-27T10:00:00.000Z"));
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);
    const preview = readJson(previewRes);

    jest.setSystemTime(new Date("2026-04-27T10:31:00.000Z"));
    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: preview.preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(readJson(res)).toMatchObject({ code: "INVALID_PREVIEW_HASH" });
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("does not accept client-supplied preview payloads without a stored server preview", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);

    const req = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        preview_payload: {
          status: "preview_ready",
          spreadsheet_id: "sheet-123",
          preview_hash: "self-signed",
          confirm_allowed: true,
          files: [],
          source_tables: [],
        },
      },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(readJson(res)).toMatchObject({ code: "INVALID_PREVIEW_HASH" });
    expect(mockCreateJob).not.toHaveBeenCalled();
  });

  it("requires the same EXTERNAL_IMPORT_WORKER_SECRET used by the Python worker", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    delete process.env.EXTERNAL_IMPORT_WORKER_SECRET;
    process.env.AIWB_WORKER_SECRET = "legacy-secret";
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(readJson(res)).toMatchObject({ error: "External import worker URL or secret is not configured." });
    delete process.env.AIWB_WORKER_SECRET;
  });

  it("persists the worker manifest and marks the job failed when validation fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          ok: false,
          job_status: "failed",
          manifest_status: "failed",
          manifest: [
            {
              source_table: "payable",
              source_file_name: "payables.xlsx",
              source_sheet_name: "Payable",
              file_hash: "file-hash-123",
              header_signature: "header-signature-123",
              row_count: 1,
              column_count: 5,
              amount_total: 100,
              target_zone_key: "external_import.payable_raw",
              resolved_zone_fingerprint: "zone-fingerprint-123",
              status: "imported",
              schema_drift: { extra_columns: [], missing_columns: [] },
            },
          ],
          write_result: { request_count: 2 },
          validation: { ok: false, errors: [{ code: "BALANCE_MISMATCH" }] },
        }),
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        spreadsheetId: "sheet-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
          validation: { ok: false, errors: [{ code: "BALANCE_MISMATCH" }] },
        }),
      }),
    );
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: "manifest-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
        }),
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expect.objectContaining({
        code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
        validation: { ok: false, errors: [{ code: "BALANCE_MISMATCH" }] },
      }),
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(readJson(res)).toMatchObject({
      job_id: "job-123",
      status: "failed",
      manifest_id: "manifest-123",
    });
  });

  it("normalizes malformed worker manifest item fields before persistence", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          job_status: "succeeded",
          manifest_status: "validated",
          manifest: [
            {
              row_count: "bad",
              column_count: "7",
              amount_total: null,
              status: "surprise",
              schema_drift: [],
            },
          ],
          validation: { ok: true },
        }),
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTable: "unknown",
        rowCount: 0,
        columnCount: 7,
        amountTotal: 0,
        targetZoneKey: "unknown",
        status: "validated",
        schemaDrift: {},
      }),
    );
    expect(mockMarkJobSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
      }),
    );
  });

  it("marks the durable job failed when the worker returns an invalid success contract", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        spreadsheetId: "sheet-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_CONTRACT_INVALID",
        }),
      }),
    );
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: "manifest-123",
        sourceTable: "payable",
        targetZoneKey: "external_import.payable_raw",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_CONTRACT_INVALID",
        }),
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expect.objectContaining({
        code: "EXTERNAL_IMPORT_WORKER_CONTRACT_INVALID",
        message: "External import worker returned an invalid result contract.",
        failed_manifest_id: "manifest-123",
        failed_manifest_item_count: 1,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("marks the durable job failed when the worker result fields disagree", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: false,
          job_status: "succeeded",
          manifest_status: "validated",
          manifest: [],
        }),
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        spreadsheetId: "sheet-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_CONTRACT_INVALID",
        }),
      }),
    );
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: "manifest-123",
        sourceTable: "payable",
        targetZoneKey: "external_import.payable_raw",
        status: "failed",
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expect.objectContaining({
        code: "EXTERNAL_IMPORT_WORKER_CONTRACT_INVALID",
        message: "External import worker returned an invalid result contract.",
        failed_manifest_id: "manifest-123",
        failed_manifest_item_count: 1,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("classifies worker capacity rejection separately from dispatch failure", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          ok: false,
          message: "Resolved import zone capacity is too small",
          details: { target_zone_key: "external_import.payable_raw" },
        }),
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        spreadsheetId: "sheet-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_CAPACITY_EXCEEDED",
          details: { target_zone_key: "external_import.payable_raw" },
        }),
      }),
    );
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: "manifest-123",
        sourceTable: "payable",
        targetZoneKey: "external_import.payable_raw",
        status: "failed",
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expect.objectContaining({
        code: "EXTERNAL_IMPORT_CAPACITY_EXCEEDED",
        message: "Resolved import zone capacity is too small",
        details: { target_zone_key: "external_import.payable_raw" },
        failed_manifest_id: "manifest-123",
        failed_manifest_item_count: 1,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("marks the durable job failed when worker dispatch fails", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    mockMarkJobFailed.mockResolvedValue({ id: "job-123", status: "failed" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "worker down",
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        spreadsheetId: "sheet-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
          message: "worker down",
        }),
      }),
    );
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: "manifest-123",
        sourceTable: "payable",
        targetZoneKey: "external_import.payable_raw",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
        }),
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expect.objectContaining({
        code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
        message: "worker down",
        failed_manifest_id: "manifest-123",
        failed_manifest_item_count: 1,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("preserves failed evidence when the worker invocation times out", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "FUNCTION_INVOCATION_TIMEOUT",
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
          message: "FUNCTION_INVOCATION_TIMEOUT",
        }),
      }),
    );
    expect(mockCreateImportManifestItem).toHaveBeenCalledWith(
      expect.objectContaining({
        manifestId: "manifest-123",
        sourceTable: "payable",
        targetZoneKey: "external_import.payable_raw",
        status: "failed",
        validationMessage: "FUNCTION_INVOCATION_TIMEOUT",
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith({
      jobId: "job-123",
      error: expect.objectContaining({
        code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
        message: "FUNCTION_INVOCATION_TIMEOUT",
        failed_manifest_id: "manifest-123",
        failed_manifest_item_count: 1,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("keeps Vercel Authentication HTML 401 clear in the failed job evidence", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { email: "writer@example.com" },
    } as never);
    mockCreateJob.mockResolvedValue({ id: "job-123", status: "queued" });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "<!doctype html><title>Authentication Required</title>",
    });
    const buffer = workbookBuffer([
      {
        name: "Payable",
        rows: [
          ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
          ["g-1", "Apex", "INV-1", 100, "CA"],
        ],
      },
    ]);
    const previewReq = {
      method: "POST",
      body: {
        spreadsheet_id: "sheet-123",
        files: [{ file_name: "payables.xlsx", content_base64: buffer.toString("base64") }],
      },
    } as unknown as NextApiRequest;
    const previewRes = createMockRes();
    await previewHandler(previewReq, previewRes);

    const req = {
      method: "POST",
      body: { spreadsheet_id: "sheet-123", preview_hash: readJson(previewRes).preview_hash },
    } as unknown as NextApiRequest;
    const res = createMockRes();

    await confirmHandler(req, res);

    expect(mockCreateImportManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
          message: expect.stringContaining("Authentication Required"),
        }),
      }),
    );
    expect(mockMarkJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_WORKER_DISPATCH_FAILED",
          message: expect.stringContaining("Authentication Required"),
        }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(500);
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
    process.env.EXTERNAL_IMPORT_WORKER_URL = "https://worker.example.com/external-import";
    process.env.EXTERNAL_IMPORT_WORKER_SECRET = "worker-secret";
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
    expect(res.json).toHaveBeenCalledWith({
      ...payload,
      worker_configured: true,
    });
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
