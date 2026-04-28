import {
  buildExternalImportRowBandRequests,
  ExternalImportStepError,
  planExternalImportStep,
  runExternalImportJobStep,
} from "@/lib/external-import/step-runner";
import { getExternalImportStatus } from "@/lib/external-import/import-manifest-service";
import { downloadExternalImportJsonArtifact } from "@/lib/external-import/upload-storage";
import {
  updateExternalImportJobProgress,
  updateImportManifestItemStatus,
  updateImportManifestStatus,
} from "@/lib/job-service";

jest.mock("@/lib/external-import/import-manifest-service", () => ({
  getExternalImportStatus: jest.fn(),
}));

jest.mock("@/lib/external-import/upload-storage", () => ({
  downloadExternalImportJsonArtifact: jest.fn(),
}));

jest.mock("@/lib/job-service", () => ({
  updateExternalImportJobProgress: jest.fn(),
  updateImportManifestItemStatus: jest.fn(),
  updateImportManifestStatus: jest.fn(),
}));

const mockGetExternalImportStatus = getExternalImportStatus as jest.MockedFunction<typeof getExternalImportStatus>;
const mockDownloadExternalImportJsonArtifact = downloadExternalImportJsonArtifact as jest.MockedFunction<
  typeof downloadExternalImportJsonArtifact
>;
const mockUpdateExternalImportJobProgress = updateExternalImportJobProgress as jest.MockedFunction<
  typeof updateExternalImportJobProgress
>;
const mockUpdateImportManifestItemStatus = updateImportManifestItemStatus as jest.MockedFunction<
  typeof updateImportManifestItemStatus
>;
const mockUpdateImportManifestStatus = updateImportManifestStatus as jest.MockedFunction<typeof updateImportManifestStatus>;

const resolvedZone = {
  zoneKey: "external_import.payable_raw",
  sourceRole: "payable",
  sheetRole: "Imported Payables",
  capacityPolicy: "expand_within_managed_sheet",
  headerSignaturePolicy: "required_semantic_headers",
  gridRange: {
    sheetId: 987654,
    startRowIndex: 12,
    startColumnIndex: 3,
    endRowIndex: 2000,
    endColumnIndex: 9,
  },
  sheetGridProperties: {
    rowCount: 2500,
    columnCount: 20,
  },
  fingerprint: "external_import.payable_raw:987654:12:3:2000:9",
} as const;

const rows = Array.from({ length: 125 }, (_, index) => [
  `guid-${index}`,
  `Vendor ${index}`,
  `INV-${index}`,
  index,
  "CA",
  `memo-${index}`,
]);

const chunk = {
  source_table: "payable",
  source_role: "uploaded",
  detected: true,
  source_file_name: "payables.xlsx",
  source_sheet_name: "Payable",
  file_hash: "file-hash",
  headers: ["Guid", "Vendor", "Invoice", "Amount", "State", "Memo"],
  rows,
  row_count: rows.length,
  column_count: 6,
  amount_total: 7750,
  target_zone_key: "external_import.payable_raw",
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-123",
    spreadsheet_id: "sheet-123",
    job_type: "external_import",
    operation: "external_import",
    status: "running",
    progress: 0,
    payload: {
      spreadsheet_id: "sheet-123",
      execution_artifact: {
        bucket: "external-import-uploads",
        path: "external-import/sheet-123/execution.json",
        format: "external_import.async_execution.chunk_plan.v1",
      },
    },
    result_meta: {},
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    format: "external_import.async_execution.chunk_plan.v1",
    spreadsheet_id: "sheet-123",
    resolved_zones: { "external_import.payable_raw": resolvedZone },
    chunks: [chunk],
    ...overrides,
  };
}

function manifestStatus(overrides: Record<string, unknown> = {}) {
  return {
    job: { id: "job-123", status: "running" },
    manifest: { id: "manifest-123", job_id: "job-123", status: "parsed" },
    manifest_items: [
      {
        id: "manifest-item-123",
        manifest_id: "manifest-123",
        job_id: "job-123",
        source_table: "payable",
        target_zone_key: "external_import.payable_raw",
        status: "parsed",
        row_count: chunk.row_count,
        column_count: chunk.column_count,
        result_meta: {},
      },
    ],
    progress: { status: "running", percentage: 0 },
    ...overrides,
  };
}

function manifestItems(count: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `manifest-item-${index + 1}`,
    manifest_id: "manifest-123",
    job_id: "job-123",
    source_table: `table-${index + 1}`,
    target_zone_key: `external_import.table_${index + 1}`,
    status: "imported",
    row_count: 10,
    column_count: 5,
    result_meta: {},
    ...overrides,
  }));
}

function sheetsRecorder() {
  const calls: Array<{ spreadsheetId: string; requestBody: { requests: Record<string, unknown>[] } }> = [];
  return {
    calls,
    sheets: {
      spreadsheets: {
        batchUpdate: async (input: { spreadsheetId: string; requestBody: { requests: Record<string, unknown>[] } }) => {
          calls.push(input);
          return { data: { replies: [] }, status: 200 };
        },
      },
    },
  };
}

describe("external import step runner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(artifact() as never);
    mockGetExternalImportStatus.mockResolvedValue(manifestStatus() as never);
    mockUpdateExternalImportJobProgress.mockResolvedValue({ id: "job-123" } as never);
    mockUpdateImportManifestItemStatus.mockResolvedValue({ id: "manifest-item-123" } as never);
    mockUpdateImportManifestStatus.mockResolvedValue({ id: "manifest-123" } as never);
  });

  it("plans a row-band chunk with bounded Sheets requests", () => {
    const plan = planExternalImportStep({
      chunks: [chunk],
      resolvedZones: { "external_import.payable_raw": resolvedZone },
      cursor: { chunk_index: 0, row_offset: 0 },
      maxRowsPerStep: 50,
    });

    expect(plan.rows).toHaveLength(50);
    expect(plan.requests.length).toBeGreaterThan(0);
    expect(plan.requests.length).toBeLessThanOrEqual(4);
    expect(plan.nextCursor).toEqual({ chunk_index: 0, row_offset: 50 });
    expect(plan.hasNextStep).toBe(true);
  });

  it("does not generate a giant full-table write request for large uploads", () => {
    const plan = planExternalImportStep({
      chunks: [chunk],
      resolvedZones: { "external_import.payable_raw": resolvedZone },
      cursor: { chunk_index: 0, row_offset: 0 },
      maxRowsPerStep: 40,
    });
    const requestText = JSON.stringify(plan.requests);

    expect(requestText).not.toContain("A1:Z20000");
    expect(requestText).not.toContain("A:Z");
    expect(requestText).not.toContain("ROWS_AND_COLUMNS");
    expect(plan.rows).toHaveLength(40);
    expect(plan.rows.length).toBeLessThan(chunk.rows.length);
  });

  it("bounds wide-table row bands by cell count instead of rows alone", () => {
    const wideHeaders = Array.from({ length: 702 }, (_, index) => `col_${index}`);
    const wideRows = Array.from({ length: 500 }, (_, rowIndex) =>
      wideHeaders.map((_, columnIndex) => `r${rowIndex}c${columnIndex}`),
    );
    const wideChunk = {
      ...chunk,
      headers: wideHeaders,
      rows: wideRows,
      row_count: wideRows.length,
      column_count: wideHeaders.length,
    };
    const wideZone = {
      ...resolvedZone,
      gridRange: {
        ...resolvedZone.gridRange,
        endColumnIndex: resolvedZone.gridRange.startColumnIndex + wideHeaders.length,
      },
    };

    const plan = planExternalImportStep({
      chunks: [wideChunk],
      resolvedZones: { "external_import.payable_raw": wideZone },
      cursor: { chunk_index: 0, row_offset: 0 },
      maxRowsPerStep: 500,
    });

    expect(plan.rows.length).toBeLessThan(500);
    expect(plan.rows.length * wideHeaders.length).toBeLessThanOrEqual(50_000);
    expect(plan.nextCursor).toEqual({ chunk_index: 0, row_offset: plan.rows.length });
    expect(plan.totalChunks).toBeGreaterThan(1);
  });

  it("derives target coordinates from resolved zone and sheet metadata instead of hardcoded physical addresses", () => {
    const requests = buildExternalImportRowBandRequests({
      resolvedZone,
      rows: rows.slice(50, 75),
      headers: chunk.headers,
      cursor: { chunk_index: 0, row_offset: 50 },
    });
    const requestText = JSON.stringify(requests);

    expect(requestText).toContain('"sheetId":987654');
    expect(requestText).toContain('"startRowIndex":62');
    expect(requestText).toContain('"startColumnIndex":3');
    expect(requestText).toContain('"endColumnIndex":9');
    expect(requestText).toContain("Vendor 50");
    expect(requestText).not.toMatch(/Payable![A-Z]+[0-9]+/);
    expect(requestText).not.toMatch(/"sheetId":109|"sheetId":101/);
    expect(requestText).not.toContain('"startRowIndex":0');
    expect(requestText).not.toContain('"startColumnIndex":0');
  });

  it("expands rows for expand_within_managed_sheet zones when the uploaded table exceeds the current sheet grid", () => {
    const smallGridZone = {
      ...resolvedZone,
      gridRange: { ...resolvedZone.gridRange, endRowIndex: 20 },
      sheetGridProperties: { ...resolvedZone.sheetGridProperties, rowCount: 20 },
    };

    const plan = planExternalImportStep({
      chunks: [chunk],
      resolvedZones: { "external_import.payable_raw": smallGridZone },
      cursor: { chunk_index: 0, row_offset: 0 },
      maxRowsPerStep: 50,
    });

    expect(plan.requests).toContainEqual({
      updateSheetProperties: {
        properties: {
          sheetId: 987654,
          gridProperties: { rowCount: resolvedZone.gridRange.startRowIndex + chunk.rows.length },
        },
        fields: "gridProperties.rowCount",
      },
    });
  });

  it("blocks fixed_capacity zones instead of expanding rows", () => {
    const fixedZone = {
      ...resolvedZone,
      capacityPolicy: "fixed_capacity" as const,
      gridRange: { ...resolvedZone.gridRange, endRowIndex: 20 },
      sheetGridProperties: { ...resolvedZone.sheetGridProperties, rowCount: 20 },
    };

    expect(() =>
      planExternalImportStep({
        chunks: [chunk],
        resolvedZones: { "external_import.payable_raw": fixedZone },
        cursor: { chunk_index: 0, row_offset: 0 },
        maxRowsPerStep: 50,
      }),
    ).toThrow("Resolved import zone row capacity is too small.");
  });

  it("clears the stale tail when the previous imported row_count is greater than the current row_count", async () => {
    const recorder = sheetsRecorder();
    mockGetExternalImportStatus.mockResolvedValue(
      manifestStatus({
        manifest_items: [
          {
            id: "manifest-item-123",
            source_table: "payable",
            target_zone_key: "external_import.payable_raw",
            status: "imported",
            row_count: chunk.row_count + 25,
            column_count: chunk.column_count,
            result_meta: {},
          },
        ],
      }) as never,
    );

    await runExternalImportJobStep({ job: job() as never, maxRowsPerStep: 500, sheets: recorder.sheets });

    const requestText = JSON.stringify(recorder.calls.flatMap((call) => call.requestBody.requests));
    expect(requestText).toContain(`"startRowIndex":${resolvedZone.gridRange.startRowIndex + chunk.row_count}`);
    expect(requestText).toContain(`"endRowIndex":${resolvedZone.gridRange.startRowIndex + chunk.row_count + 25}`);
    expect(requestText).toContain('"fields":"userEnteredValue"');
  });

  it("clears stale width drift when the previous column_count is greater than the current column_count", async () => {
    const recorder = sheetsRecorder();
    mockGetExternalImportStatus.mockResolvedValue(
      manifestStatus({
        manifest_items: [
          {
            id: "manifest-item-123",
            source_table: "payable",
            target_zone_key: "external_import.payable_raw",
            status: "imported",
            row_count: chunk.row_count,
            column_count: chunk.column_count + 2,
            result_meta: {},
          },
        ],
      }) as never,
    );

    await runExternalImportJobStep({ job: job() as never, maxRowsPerStep: 500, sheets: recorder.sheets });

    const requestText = JSON.stringify(recorder.calls.flatMap((call) => call.requestBody.requests));
    expect(requestText).toContain(`"startColumnIndex":${resolvedZone.gridRange.startColumnIndex + chunk.column_count}`);
    expect(requestText).toContain(`"endColumnIndex":${resolvedZone.gridRange.startColumnIndex + chunk.column_count + 2}`);
    expect(requestText).toContain('"fields":"userEnteredValue"');
  });

  it("executes Sheets batchUpdate with the Node googleapis Promise style", async () => {
    const recorder = sheetsRecorder();
    const batchUpdate = jest.spyOn(recorder.sheets.spreadsheets, "batchUpdate");

    await runExternalImportJobStep({ job: job() as never, maxRowsPerStep: 500, sheets: recorder.sheets });

    expect(batchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        spreadsheetId: "sheet-123",
        requestBody: expect.objectContaining({
          requests: expect.any(Array),
        }),
      }),
    );
    expect(recorder.calls).toHaveLength(1);
    expect(mockUpdateExternalImportJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
      }),
    );
  });

  it("preserves Google Sheets upstream failure evidence when a batchUpdate chunk fails", async () => {
    const upstreamError = new Error("Bad Gateway") as Error & {
      code?: string;
      response?: {
        status?: number;
        statusText?: string;
        data?: unknown;
        config?: { url?: string };
      };
    };
    upstreamError.code = "ERR_BAD_RESPONSE";
    upstreamError.response = {
      status: 502,
      statusText: "Bad Gateway",
      data: "Bad Gateway",
      config: { url: "https://sheets.googleapis.com/v4/spreadsheets/sheet-123:batchUpdate?key=secret" },
    };
    const sheets = {
      spreadsheets: {
        batchUpdate: jest.fn().mockRejectedValue(upstreamError),
      },
    };

    await expect(runExternalImportJobStep({ job: job() as never, maxRowsPerStep: 500, sheets })).rejects.toMatchObject({
      code: "EXTERNAL_IMPORT_SHEETS_BATCH_UPDATE_FAILED",
      message: expect.stringContaining("Google Sheets batchUpdate failed"),
      details: expect.objectContaining({
        upstream_service: "google_sheets",
        upstream_operation: "spreadsheets.batchUpdate",
        upstream_status: 502,
        upstream_status_text: "Bad Gateway",
        upstream_code: "ERR_BAD_RESPONSE",
        upstream_body_summary: "Bad Gateway",
        upstream_route: "https://sheets.googleapis.com/v4/spreadsheets/sheet-123:batchUpdate",
        request_count: expect.any(Number),
      }),
    } satisfies Partial<ExternalImportStepError>);
  });

  it("leaves non-uploaded tables untouched", async () => {
    const recorder = sheetsRecorder();
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(
      artifact({
        chunks: [
          {
            ...chunk,
            source_role: "template",
            rows: [["template-guid", "Template Vendor", "INV-T", 12, "CA", "template"]],
            row_count: 1,
          },
        ],
      }) as never,
    );

    const result = await runExternalImportJobStep({ job: job() as never, maxRowsPerStep: 500, sheets: recorder.sheets });

    expect(result.rows_written).toBe(0);
    expect(recorder.calls).toHaveLength(0);
    expect(mockUpdateImportManifestItemStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "imported" }),
    );
  });

  it("marks the job, manifest, and items successful after validation succeeds", async () => {
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(
      artifact({
        chunks: [],
        validation: { ok: true, checked_tables: ["payable"] },
      }) as never,
    );

    const result = await runExternalImportJobStep({
      job: job({ result_meta: { current_step: "validation" } }) as never,
      maxRowsPerStep: 500,
      sheets: sheetsRecorder().sheets,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      step: { kind: "validation" },
      has_next_step: false,
    });
    expect(mockUpdateImportManifestStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "validated",
        resultMeta: expect.objectContaining({ validation: { ok: true, checked_tables: ["payable"] } }),
      }),
    );
    expect(mockUpdateImportManifestItemStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "validated",
        resultMeta: expect.objectContaining({ validation: { ok: true, checked_tables: ["payable"] } }),
      }),
    );
    expect(mockUpdateExternalImportJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        progress: 100,
        result: expect.objectContaining({ validation: { ok: true, checked_tables: ["payable"] } }),
      }),
    );
  });

  it("marks all manifest items validated after validation succeeds for a seven-table import", async () => {
    const sevenItems = manifestItems(7);
    mockGetExternalImportStatus.mockResolvedValue(manifestStatus({ manifest_items: sevenItems }) as never);
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(
      artifact({
        chunks: [],
        validation: { ok: true, checked_tables: sevenItems.map((item) => item.source_table) },
      }) as never,
    );

    const result = await runExternalImportJobStep({
      job: job({ result_meta: { current_step: "validation" } }) as never,
      maxRowsPerStep: 500,
      sheets: sheetsRecorder().sheets,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      has_next_step: false,
      step: { kind: "validation" },
    });
    for (const item of sevenItems) {
      expect(mockUpdateImportManifestItemStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: item.id,
          status: "validated",
          resultMeta: expect.objectContaining({
            validation: expect.objectContaining({ ok: true }),
          }),
        }),
      );
    }
    expect(mockUpdateImportManifestItemStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        status: "validated",
      }),
    );
    expect(mockUpdateExternalImportJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        result: expect.objectContaining({ imported_table_count: 7 }),
      }),
    );
  });

  it("leaves stale retained manifest items stale after partial validation succeeds", async () => {
    const partialItems = [
      {
        id: "manifest-item-payable",
        manifest_id: "manifest-123",
        job_id: "job-123",
        source_table: "payable",
        target_zone_key: "external_import.payable_raw",
        status: "imported",
        row_count: 10,
        column_count: 5,
        result_meta: {},
      },
      ...manifestItems(6, {
        status: "stale",
        result_meta: { retained: true, retention_status: "stale" },
      }).map((item, index) => ({
        ...item,
        id: `manifest-item-stale-${index + 1}`,
        source_table: [
          "final_detail",
          "unit_budget",
          "draw_request",
          "draw_invoice_list",
          "transfer_log",
          "change_order_log",
        ][index],
      })),
    ];
    mockGetExternalImportStatus.mockResolvedValue(manifestStatus({ manifest_items: partialItems }) as never);
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(
      artifact({
        chunks: [chunk],
        validation: { ok: true, checked_tables: ["payable"] },
      }) as never,
    );

    const result = await runExternalImportJobStep({
      job: job({ result_meta: { current_step: "validation", cursor: { phase: "validation", chunk_index: 1, row_offset: 0 } } }) as never,
      maxRowsPerStep: 500,
      sheets: sheetsRecorder().sheets,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      has_next_step: false,
    });
    expect(mockUpdateImportManifestItemStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "manifest-item-payable",
        status: "validated",
      }),
    );
    for (const staleItem of partialItems.filter((item) => item.status === "stale")) {
      expect(mockUpdateImportManifestItemStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: staleItem.id,
          status: "validated",
        }),
      );
    }
    expect(mockUpdateImportManifestItemStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        status: "validated",
      }),
    );
  });

  it("marks failed evidence and does not advance next stage when validation fails", async () => {
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(
      artifact({
        chunks: [],
        validation: { ok: false, errors: [{ code: "ROW_TOTAL_MISMATCH", message: "Totals differ" }] },
      }) as never,
    );

    const result = await runExternalImportJobStep({
      job: job({ result_meta: { current_step: "validation" } }) as never,
      maxRowsPerStep: 500,
      sheets: sheetsRecorder().sheets,
    });

    expect(result).toMatchObject({
      status: "failed",
      has_next_step: false,
      next_step: null,
      step: { kind: "validation" },
    });
    const expectedError = expect.objectContaining({
      code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
      details: expect.objectContaining({
        validation: { ok: false, errors: [{ code: "ROW_TOTAL_MISMATCH", message: "Totals differ" }] },
      }),
    });
    expect(mockUpdateImportManifestStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: expectedError }),
    );
    expect(mockUpdateImportManifestItemStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: expectedError }),
    );
    expect(mockUpdateExternalImportJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: expectedError }),
    );
  });

  it("marks all manifest items failed after validation fails for a seven-table import", async () => {
    const sevenItems = manifestItems(7);
    const validation = { ok: false, errors: [{ code: "ROW_TOTAL_MISMATCH", message: "Totals differ" }] };
    mockGetExternalImportStatus.mockResolvedValue(manifestStatus({ manifest_items: sevenItems }) as never);
    mockDownloadExternalImportJsonArtifact.mockResolvedValue(
      artifact({
        chunks: [],
        validation,
      }) as never,
    );

    const result = await runExternalImportJobStep({
      job: job({ result_meta: { current_step: "validation" } }) as never,
      maxRowsPerStep: 500,
      sheets: sheetsRecorder().sheets,
    });

    expect(result).toMatchObject({
      status: "failed",
      has_next_step: false,
      step: { kind: "validation" },
    });
    for (const item of sevenItems) {
      expect(mockUpdateImportManifestItemStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: item.id,
          status: "failed",
          validationMessage: "External import validation failed.",
          error: expect.objectContaining({
            code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
            details: { validation },
          }),
        }),
      );
    }
    expect(mockUpdateImportManifestItemStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-123",
        status: "failed",
      }),
    );
    expect(mockUpdateExternalImportJobProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "EXTERNAL_IMPORT_VALIDATION_FAILED",
          details: { validation },
        }),
      }),
    );
  });
});
