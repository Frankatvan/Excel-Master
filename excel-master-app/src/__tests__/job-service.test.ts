import {
  classifyJobStatus,
  createJob,
  createImportManifest,
  createImportManifestItem,
  heartbeatJob,
  markJobCancelled,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  updateImportManifestItemStatus,
} from "@/lib/job-service";

function createSupabaseFake(
  response: { data?: unknown; error?: unknown } = { data: { id: "job-123" }, error: null },
  options: { allowedTables?: string[] } = {},
) {
  const single = jest.fn().mockResolvedValue(response);
  const select = jest.fn().mockReturnValue({ single });
  const eq = jest.fn().mockReturnValue({ select, single });
  const insert = jest.fn().mockReturnValue({ select });
  const update = jest.fn().mockReturnValue({ eq });
  const from = jest.fn((table: string) => {
    const allowedTables = options.allowedTables ?? ["jobs"];
    if (!allowedTables.includes(table)) {
      throw new Error(`Unexpected table: ${table}`);
    }
    return { insert, update };
  });

  return {
    client: { from },
    calls: { from, insert, update, eq, select, single },
  };
}

describe("job-service", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-27T10:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("creates an external_import job in queued state", async () => {
    const fake = createSupabaseFake({
      data: { id: "job-123", job_type: "external_import", status: "queued" },
      error: null,
    });

    await expect(
      createJob(
        {
          projectId: "project-123",
          spreadsheetId: "sheet-123",
          jobType: "external_import",
          operation: "external_import",
          createdBy: "actor@example.com",
          payload: { source_count: 2 },
        },
        fake.client,
      ),
    ).resolves.toEqual({ id: "job-123", job_type: "external_import", status: "queued" });

    expect(fake.calls.insert).toHaveBeenCalledWith({
      project_id: "project-123",
      spreadsheet_id: "sheet-123",
      job_type: "external_import",
      type: "external_import",
      operation: "external_import",
      status: "queued",
      progress: 0,
      created_by: "actor@example.com",
      payload: { source_count: 2 },
      result: null,
      result_meta: {},
      error: null,
    });
  });

  it("marks a job running with a heartbeat and lock token", async () => {
    const fake = createSupabaseFake({ data: { id: "job-123", status: "running" }, error: null });

    await markJobRunning({ jobId: "job-123", lockToken: "lock-123" }, fake.client);

    expect(fake.calls.update).toHaveBeenCalledWith({
      status: "running",
      lock_token: "lock-123",
      started_at: "2026-04-27T10:00:00.000Z",
      heartbeat_at: "2026-04-27T10:00:00.000Z",
    });
    expect(fake.calls.eq).toHaveBeenCalledWith("id", "job-123");
  });

  it("updates heartbeat and progress", async () => {
    const fake = createSupabaseFake({ data: { id: "job-123", progress: 45 }, error: null });

    await heartbeatJob({ jobId: "job-123", progress: 45 }, fake.client);

    expect(fake.calls.update).toHaveBeenCalledWith({
      heartbeat_at: "2026-04-27T10:00:00.000Z",
      progress: 45,
    });
  });

  it("marks success and failure with structured payloads", async () => {
    const successFake = createSupabaseFake({ data: { id: "job-123", status: "succeeded" }, error: null });
    await markJobSucceeded({ jobId: "job-123", result: { imported: 2 }, resultMeta: { validated: true } }, successFake.client);
    expect(successFake.calls.update).toHaveBeenCalledWith({
      status: "succeeded",
      progress: 100,
      finished_at: "2026-04-27T10:00:00.000Z",
      result: { imported: 2 },
      result_meta: { validated: true },
      error: null,
    });

    const failureFake = createSupabaseFake({ data: { id: "job-456", status: "failed" }, error: null });
    await markJobFailed({ jobId: "job-456", error: { code: "IMPORT_FAILED", message: "boom" } }, failureFake.client);
    expect(failureFake.calls.update).toHaveBeenCalledWith({
      status: "failed",
      finished_at: "2026-04-27T10:00:00.000Z",
      error: { code: "IMPORT_FAILED", message: "boom" },
    });
  });

  it("marks cancellation and classifies stale running jobs", async () => {
    const fake = createSupabaseFake({ data: { id: "job-123", status: "cancelled" }, error: null });
    await markJobCancelled({ jobId: "job-123", reason: "user_cancelled" }, fake.client);
    expect(fake.calls.update).toHaveBeenCalledWith({
      status: "cancelled",
      finished_at: "2026-04-27T10:00:00.000Z",
      error: { reason: "user_cancelled" },
    });

    expect(
      classifyJobStatus(
        {
          status: "running",
          heartbeat_at: "2026-04-27T09:49:59.000Z",
          started_at: "2026-04-27T09:45:00.000Z",
          finished_at: null,
        },
        { staleAfterMs: 10 * 60 * 1000 },
      ),
    ).toBe("stale");
  });

  it("creates an external import manifest linked to a durable job", async () => {
    const fake = createSupabaseFake(
      { data: { id: "manifest-123", job_id: "job-123", status: "parsed" }, error: null },
      { allowedTables: ["external_import_manifests"] },
    );

    await createImportManifest(
      {
        jobId: "job-123",
        projectId: "project-123",
        spreadsheetId: "sheet-123",
        status: "parsed",
        importedBy: "actor@example.com",
        resultMeta: { source_count: 2 },
      },
      fake.client,
    );

    expect(fake.calls.from).toHaveBeenCalledWith("external_import_manifests");
    expect(fake.calls.insert).toHaveBeenCalledWith({
      job_id: "job-123",
      project_id: "project-123",
      spreadsheet_id: "sheet-123",
      status: "parsed",
      imported_by: "actor@example.com",
      imported_at: "2026-04-27T10:00:00.000Z",
      result_meta: { source_count: 2 },
      error: null,
    });
  });

  it("creates and updates external import manifest items", async () => {
    const itemFake = createSupabaseFake(
      { data: { id: "item-123", status: "parsed" }, error: null },
      { allowedTables: ["external_import_manifest_items"] },
    );

    await createImportManifestItem(
      {
        manifestId: "manifest-123",
        jobId: "job-123",
        projectId: "project-123",
        spreadsheetId: "sheet-123",
        sourceTable: "payable",
        sourceFileName: "payable.xlsx",
        sourceSheetName: "Payable",
        fileHash: "file-hash",
        headerSignature: "header-signature",
        rowCount: 10,
        columnCount: 5,
        amountTotal: 1200.5,
        targetZoneKey: "external_import.payable_raw",
        resolvedZoneFingerprint: "zone-fingerprint",
        status: "parsed",
        schemaDrift: { warnings: [] },
      },
      itemFake.client,
    );

    expect(itemFake.calls.insert).toHaveBeenCalledWith({
      manifest_id: "manifest-123",
      job_id: "job-123",
      project_id: "project-123",
      spreadsheet_id: "sheet-123",
      source_table: "payable",
      source_file_name: "payable.xlsx",
      source_sheet_name: "Payable",
      file_hash: "file-hash",
      header_signature: "header-signature",
      row_count: 10,
      column_count: 5,
      amount_total: 1200.5,
      target_zone_key: "external_import.payable_raw",
      resolved_zone_fingerprint: "zone-fingerprint",
      status: "parsed",
      validation_message: null,
      schema_drift: { warnings: [] },
      result_meta: {},
      error: null,
    });

    const updateFake = createSupabaseFake(
      { data: { id: "item-123", status: "validated" }, error: null },
      { allowedTables: ["external_import_manifest_items"] },
    );
    await updateImportManifestItemStatus(
      {
        itemId: "item-123",
        status: "validated",
        validationMessage: "ok",
        resultMeta: { validated: true },
      },
      updateFake.client,
    );

    expect(updateFake.calls.update).toHaveBeenCalledWith({
      status: "validated",
      validation_message: "ok",
      result_meta: { validated: true },
      error: null,
      imported_at: "2026-04-27T10:00:00.000Z",
    });
    expect(updateFake.calls.eq).toHaveBeenCalledWith("id", "item-123");
  });
});
