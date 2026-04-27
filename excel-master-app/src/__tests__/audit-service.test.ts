import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { buildAuditSnapshot } from "@/lib/audit-dashboard";
import { readInternalCompanies } from "@/lib/internal-company-registry";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

jest.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn(() => ({ mocked: true })),
    },
    sheets: jest.fn(),
    drive: jest.fn(),
  },
}));

jest.mock("@/lib/audit-dashboard", () => ({
  buildAuditSnapshot: jest.fn(() => ({
    project_name: "Test Project",
    highlights: [],
    workflow_stage: "外部核对",
    audit_tabs: {
      external_recon: {
        summary: "已同步",
        discrepancies: [],
        recon_by_cost_state: [],
        unit_budget_variances: [],
        invoice_match_overview: {
          payable_total_invoices: 0,
          final_total_invoices: 0,
          draw_total_invoices: 0,
          matched_to_final: 0,
          matched_to_draw: 0,
          matched_to_both: 0,
          payable_unmatched: 0,
          final_only: 0,
          draw_only: 0,
        },
      },
      reclass_audit: {
        overview: {
          old_total: 0,
          new_total: 0,
          diff_amount: 0,
          diff_invoice_count: 0,
        },
        category_rows: [],
        rule_rows: [],
        invoice_rows: [],
        sankey: { nodes: [], links: [] },
      },
      compare_109: {
        metric_rows: [],
      },
      scoping_logic: [],
    },
  })),
  normalizeSpreadsheetId: jest.fn((value?: string | string[] | null) => {
    if (Array.isArray(value)) {
      return value[0];
    }
    return value || "fallback-sheet-id";
  }),
}));

jest.mock("@/lib/internal-company-registry", () => ({
  readInternalCompanies: jest.fn(),
}));

const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockSheets = google.sheets as jest.Mock;
const mockDrive = google.drive as jest.Mock;
const mockBuildAuditSnapshot = buildAuditSnapshot as jest.MockedFunction<typeof buildAuditSnapshot>;
const mockReadInternalCompanies = readInternalCompanies as jest.MockedFunction<
  typeof readInternalCompanies
>;

describe("audit-service cache fallback", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-key",
      GOOGLE_CLIENT_EMAIL: "service-account@example.com",
      GOOGLE_PRIVATE_KEY: "line1\\nline2",
    };
    jest.clearAllMocks();
    mockDrive.mockReturnValue({
      files: {
        get: jest.fn().mockResolvedValue({
          data: { modifiedTime: "2026-04-26T12:00:00.000Z" },
        }),
      },
    });
    mockReadInternalCompanies.mockResolvedValue([
      {
        company_name: "Internal Company",
        normalized_name: "internal company",
      },
    ]);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("marks old running audit sync rows as stale", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-04-27T12:10:00.000Z"));
    const { classifyAuditSyncRun } = await import("@/lib/audit-service");

    expect(
      classifyAuditSyncRun({
        status: "running",
        started_at: "2026-04-27T12:00:00.000Z",
        finished_at: null,
      }),
    ).toBe("stale");

    jest.useRealTimers();
  });

  it("keeps external recon detail and comparison rows complete for matrix drilldowns", async () => {
    const detailRows = Array.from({ length: 501 }, (_, index) => ({
      source_table: "Payable" as const,
      row_no: index + 1,
      unit_code: `U-${index + 1}`,
      vendor: "Vendor",
      old_cost_state: "Direct",
      cost_name: "100 Direct",
      amount: 1,
    }));
    const comparisonRows = Array.from({ length: 501 }, (_, index) => ({
      comparison_key: `key-${index + 1}`,
      invoice_label: `INV-${index + 1}`,
      vendor: "Vendor",
      unit_code: `U-${index + 1}`,
      cost_code: "1SF100",
      amount: 1,
      payable_cost_states: ["Direct"],
      final_detail_cost_states: ["Direct"],
      draw_request_cost_states: ["Direct"],
      is_fully_aligned: true,
    }));

    const { compactAuditSnapshotForPersistence } = await import("@/lib/audit-service");
    const compacted = compactAuditSnapshotForPersistence({
      project_name: "Sandy Cove",
      highlights: [],
      workflow_stage: "external_data_ready",
      audit_tabs: {
        external_recon: {
          summary: "已同步",
          discrepancies: [],
          recon_by_cost_state: [],
          unit_budget_variances: [],
          invoice_match_overview: {
            payable_total_invoices: 0,
            final_total_invoices: 0,
            draw_total_invoices: 0,
            matched_to_final: 0,
            matched_to_draw: 0,
            matched_to_both: 0,
            payable_unmatched: 0,
            final_only: 0,
            draw_only: 0,
          },
          unit_common_counts: [],
          cost_state_matrix: [],
          cost_state_totals: {
            payable: { grouped_total: 0, raw_total: 0, mismatch: false },
            final_detail: { grouped_total: 0, raw_total: 0, mismatch: false },
            draw_request: { grouped_total: 0, raw_total: 0, mismatch: false },
          },
          internal_company_cost_state_matrix: [],
          detail_rows: detailRows,
          comparison_rows: comparisonRows,
        },
        manual_input: {
          profit_statement_entries: [],
          validation_errors: [],
          scoping_groups: [],
          unit_master_dates: [],
        },
        reclass_audit: {
          overview: {
            payable_amount: 0,
            payable_count: 0,
            final_detail_amount: 0,
            final_detail_count: 0,
            diff_count: 0,
            old_total: 0,
            new_total: 0,
            diff_amount: 0,
            diff_invoice_count: 0,
          },
          category_rows: [],
          rule_rows: [],
          invoice_rows: [],
          table_summaries: [],
          internal_company_category_matrix: [],
          sankey: { nodes: [], links: [] },
        },
        compare_109: { metric_rows: [], warnings: [] },
        scoping_logic: [],
      },
    });

    expect(compacted.audit_tabs.external_recon.detail_rows).toHaveLength(501);
    expect(compacted.audit_tabs.external_recon.comparison_rows).toHaveLength(501);
    expect((compacted.audit_tabs.external_recon as unknown as Record<string, unknown>).detail_rows_truncated).toBe(false);
    expect((compacted.audit_tabs.external_recon as unknown as Record<string, unknown>).comparison_rows_truncated).toBe(false);
  });

  it("loads a live snapshot when audit_cache is missing", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: null,
    });
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const upsert = jest.fn(() => ({ select: jest.fn(() => ({ single })) }));
    const from = jest.fn((table: string) => {
      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
          upsert,
        };
      }

      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [["Audit Project"]] },
          { values: [["109"]] },
          { values: [["Unit Budget"]] },
          {},
          {},
          {},
          {},
          {},
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from } as never);
    const get = jest.fn().mockResolvedValue({
      data: {
        sheets: [{ properties: { title: "109" } }],
      },
    });
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
        get,
      },
    });

    const { getAuditSummary } = await import("@/lib/audit-service");
    const payload = await getAuditSummary("sheet-123");

    expect(payload).toEqual(
      expect.objectContaining({
        project_name: "Test Project",
        from_cache: false,
      }),
    );
    expect(from).toHaveBeenCalledWith("audit_cache");
    expect(mockSheets).toHaveBeenCalledWith({
      version: "v4",
      auth: { mocked: true },
    });
    expect(batchGet).toHaveBeenCalledWith(
      expect.objectContaining({
        ranges: expect.arrayContaining([
          "'109'!C2",
          "'109'!A1:R120",
          "'Unit Budget'!A:ZZ",
          "'Payable'!A:AZ",
          "'Final Detail'!A:AL",
          "'Draw request report'!A:AR",
          "'Unit Master'!A:M",
          "'Scoping'!A:Z",
        ]),
      }),
    );
  });

  it("reads the registered 109 sheet title before building the live audit snapshot", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const upsert = jest.fn(() => ({ select: jest.fn(() => ({ single })) }));
    const from = jest.fn((table: string) => {
      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
          upsert,
        };
      }

      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [["Project 237"]] },
          { values: [["Header"], ["", "", "Compare 237"]] },
          { values: [["Unit Budget"], ["Division", "Amount"], ["Paint", "1250"]] },
          { values: [["Payable"]] },
          { values: [["Final Detail"]] },
          { values: [["Draw"]] },
          { values: [["Unit Master"]] },
          { values: [["Scoping"]] },
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
      },
    });

    const { fetchLiveAuditSnapshot } = await import("@/lib/audit-service");

    const result = await fetchLiveAuditSnapshot("sheet-237");

    expect(batchGet).toHaveBeenCalledWith(
      expect.objectContaining({
        ranges: [
          "'237'!C2",
          "'237'!A1:R120",
          "'Unit Budget'!A:ZZ",
          "'Payable'!A:AZ",
          "'Final Detail'!A:AL",
          "'Draw request report'!A:AR",
          "'Unit Master'!A:M",
          "'Scoping'!A:Z",
        ],
      }),
    );
    expect(mockReadInternalCompanies).toHaveBeenCalledTimes(1);
    expect(mockReadInternalCompanies.mock.invocationCallOrder[0]).toBeLessThan(
      mockBuildAuditSnapshot.mock.invocationCallOrder[0],
    );
    expect(result.sourceLastEditAt).toBe("2026-04-26T12:00:00.000Z");
    expect(mockDrive).toHaveBeenCalledWith({
      version: "v3",
      auth: { mocked: true },
    });
    expect(mockBuildAuditSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "Project 237",
        rows109: [["Header"], ["", "", "Compare 237"]],
        kpiRows: [["Header"], ["", "", "Compare 237"]],
        unitBudgetRows: [["Unit Budget"], ["Division", "Amount"], ["Paint", "1250"]],
        internalCompanies: [
          {
            company_name: "Internal Company",
            normalized_name: "internal company",
          },
        ],
      }),
    );
  });

  it("preserves the existing project-name fallback when live sheet inputs are blank", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const upsert = jest.fn(() => ({ select: jest.fn(() => ({ single })) }));
    const from = jest.fn((table: string) => {
      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
          upsert,
        };
      }

      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [[""]] },
          { values: [["Header"], ["", "", ""]] },
          { values: [["Unit Budget"]] },
          { values: [["Payable"]] },
          { values: [["Final Detail"]] },
          { values: [["Draw"]] },
          { values: [["Unit Master"]] },
          { values: [["Scoping"]] },
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
      },
    });

    const { fetchLiveAuditSnapshot } = await import("@/lib/audit-service");

    await fetchLiveAuditSnapshot("sheet-237");

    expect(mockBuildAuditSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "Unnamed Project",
      }),
    );
  });

  it("guesses the project 109 sheet title from spreadsheet metadata when the projects table is unavailable", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const upsert = jest.fn(() => ({ select: jest.fn(() => ({ single })) }));
    const from = jest.fn((table: string) => {
      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
          upsert,
        };
      }

      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [["Project 237"]] },
          { values: [["Header"], ["", "", "Compare 237"]] },
          { values: [["Unit Budget"]] },
          { values: [["Payable"]] },
          { values: [["Final Detail"]] },
          { values: [["Draw"]] },
          { values: [["Unit Master"]] },
          { values: [["Scoping"]] },
        ],
      },
    });
    const get = jest.fn().mockResolvedValue({
      data: {
        sheets: [
          { properties: { title: "Payable" } },
          { properties: { title: "Final Detail" } },
          { properties: { title: "237" } },
          { properties: { title: "Scoping" } },
          { properties: { title: "Unit Master" } },
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
        get,
      },
    });

    const { fetchLiveAuditSnapshot } = await import("@/lib/audit-service");

    await fetchLiveAuditSnapshot("sheet-237");

    expect(get).toHaveBeenCalledWith({
      spreadsheetId: "sheet-237",
      fields: "sheets(properties(title))",
    });
    expect(batchGet).toHaveBeenCalledWith(
      expect.objectContaining({
        ranges: [
          "'237'!C2",
          "'237'!A1:R120",
          "'Unit Budget'!A:ZZ",
          "'Payable'!A:AZ",
          "'Final Detail'!A:AL",
          "'Draw request report'!A:AR",
          "'Unit Master'!A:M",
          "'Scoping'!A:Z",
        ],
      }),
    );
  });

  it("reuses a short-lived in-memory snapshot when audit_cache is unavailable", async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "237" },
      error: null,
    });
    const single = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const upsert = jest.fn(() => ({ select: jest.fn(() => ({ single })) }));
    const from = jest.fn((table: string) => {
      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle })) })),
          upsert,
        };
      }

      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [["Project 237"]] },
          { values: [["Header"], ["", "", "Compare 237"]] },
          { values: [["Unit Budget"]] },
          { values: [["Payable"]] },
          { values: [["Final Detail"]] },
          { values: [["Draw"]] },
          { values: [["Unit Master"]] },
          { values: [["Scoping"]] },
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
      },
    });

    const { getAuditSummary } = await import("@/lib/audit-service");

    await getAuditSummary("sheet-cache-test");
    await getAuditSummary("sheet-cache-test");

    expect(batchGet).toHaveBeenCalledTimes(1);
  });

  it("blocks live audit summary fallback when snapshot-only mode is enforced", async () => {
    process.env.AIWB_DISABLE_LIVE_AUDIT_SUMMARY = "1";
    const cacheMaybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: null,
    });
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: null,
    });
    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: cacheMaybeSingle })) })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);
    const { getAuditSummary } = await import("@/lib/audit-service");

    await expect(getAuditSummary("sheet-snapshot-only")).rejects.toMatchObject({
      name: "AuditSnapshotServiceError",
      statusCode: 409,
      code: "AUDIT_SNAPSHOT_NOT_READY",
    });
    expect(mockSheets).not.toHaveBeenCalled();
  });

  it("prefers the current audit snapshot payload before cache/live reads", async () => {
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-1" },
      error: null,
    });
    const currentSnapshotMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "snapshot-1",
        sync_run_id: "run-1",
        created_at: "2026-04-26T01:23:45.000Z",
        data_json: {
          audit_dashboard_snapshot: {
            project_name: "Snapshot Project",
            workflow_stage: "外部核对",
            highlights: [],
            audit_tabs: {
              external_recon: {
                summary: "snapshot",
                discrepancies: [],
                cost_state_matrix: [],
                cost_state_totals: undefined,
                unit_common_counts: [],
                internal_company_cost_state_matrix: [],
                unit_budget_variances: [],
                invoice_match_overview: {
                  payable_total_invoices: 0,
                  final_total_invoices: 0,
                  draw_total_invoices: 0,
                  matched_to_final: 0,
                  matched_to_draw: 0,
                  matched_to_both: 0,
                  payable_unmatched: 0,
                  final_only: 0,
                  draw_only: 0,
                },
                detail_rows: [],
                comparison_rows: [],
              },
              manual_input: {
                profit_statement_entries: [],
                validation_errors: [],
                scoping_groups: [],
                unit_master_dates: [],
              },
              reclass_audit: {
                overview: {
                  old_total: 0,
                  new_total: 0,
                  diff_amount: 0,
                  diff_invoice_count: 0,
                },
                category_rows: [],
                rule_rows: [],
                invoice_rows: [],
                sankey: { nodes: [], links: [] },
              },
              compare_109: {
                metric_rows: [{ label: "收入", year_rows: [] }],
              },
              scoping_logic: [],
            },
          },
          audit_dashboard_last_synced_at: "2026-04-26T01:40:00.000Z",
        },
        mapping_manifest_json: {
          source_mode: "snapshot_only",
        },
      },
      error: null,
    });

    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => ({ maybeSingle: currentSnapshotMaybeSingle })),
                })),
              })),
            })),
          })),
        };
      }

      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);

    const { getAuditSummary } = await import("@/lib/audit-service");
    const payload = await getAuditSummary("sheet-from-snapshot");

    expect(payload).toEqual(
      expect.objectContaining({
        project_name: "Snapshot Project",
        from_cache: true,
        from_snapshot: true,
        snapshot_id: "snapshot-1",
        snapshot_source_mode: "snapshot_only",
        last_synced_at: "2026-04-26T01:40:00.000Z",
      }),
    );
    expect(mockSheets).not.toHaveBeenCalled();
  });

  it("uses a newer audit cache when the attached current snapshot is stale", async () => {
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-1" },
      error: null,
    });
    const currentSnapshotMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "snapshot-old",
        sync_run_id: "run-old",
        created_at: "2026-04-26T01:23:45.000Z",
        data_json: {
          audit_dashboard_snapshot: {
            project_name: "Old Snapshot",
            workflow_stage: "external_data_ready",
            highlights: [],
            audit_tabs: { external_recon: { cost_state_matrix: [] } },
          },
          audit_dashboard_last_synced_at: "2026-04-26T01:40:00.000Z",
        },
        mapping_manifest_json: { source_mode: "snapshot_plus_dashboard" },
      },
      error: null,
    });
    const cacheMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        project_id: "sheet-from-snapshot",
        last_synced_at: "2026-04-26T12:27:23.132Z",
        data_json: {
          project_name: "Fresh Cache",
          workflow_stage: "external_data_ready",
          highlights: [],
          audit_tabs: {
            external_recon: {
              cost_state_matrix: [
                {
                  cost_state: "Direct",
                  payable_amount: 8237699.62,
                  final_detail_amount: 8237699.62,
                  draw_request_amount: 8237699.62,
                  draw_request_diff_count: 0,
                },
              ],
            },
          },
        },
      },
      error: null,
    });

    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => ({ maybeSingle: currentSnapshotMaybeSingle })),
                })),
              })),
            })),
          })),
        };
      }

      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({ maybeSingle: cacheMaybeSingle })),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);

    const { getAuditSummary } = await import("@/lib/audit-service");
    const payload = await getAuditSummary("sheet-from-snapshot");

    expect(payload).toEqual(
      expect.objectContaining({
        project_name: "Fresh Cache",
        from_cache: true,
        last_synced_at: "2026-04-26T12:27:23.132Z",
      }),
    );
    expect(payload.audit_tabs.external_recon.cost_state_matrix[0]).toEqual(
      expect.objectContaining({ cost_state: "Direct", draw_request_diff_count: 0 }),
    );
    expect(mockSheets).not.toHaveBeenCalled();
  });

  it("treats reclass overview counts as a usable current dashboard snapshot", async () => {
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-109" },
      error: null,
    });
    const currentSnapshotMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "snapshot-109",
        sync_run_id: "run-109",
        created_at: "2026-04-26T06:15:18.000Z",
        data_json: {
          dashboard_summary: {
            project_name: "Project 1g17SLJD",
            workflow_stage: "manual_input_ready",
            highlights: [
              { label: "收入", value: "-", color: "slate" },
              { label: "成本", value: "-", color: "slate" },
              { label: "毛利", value: "-", color: "slate" },
              { label: "完工进度", value: "-", color: "slate" },
            ],
            audit_tabs: {
              external_recon: {
                summary: "后台快照已更新，前端将直接渲染快照摘要。",
              },
              manual_input: {},
              reclass_audit: {
                overview: {
                  payable_count: 15823,
                  final_detail_count: 19376,
                  diff_count: 10,
                },
              },
              compare_109: {
                metric_rows: [],
              },
            },
          },
        },
        mapping_manifest_json: {
          source_mode: "semantic_runtime",
        },
      },
      error: null,
    });

    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => ({ maybeSingle: currentSnapshotMaybeSingle })),
                })),
              })),
            })),
          })),
        };
      }

      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);

    const { getAuditSummary } = await import("@/lib/audit-service");
    const payload = await getAuditSummary("sheet-109");

    expect(payload).toEqual(
      expect.objectContaining({
        project_name: "Project 1g17SLJD",
        from_snapshot: true,
        snapshot_id: "snapshot-109",
        snapshot_source_mode: "semantic_runtime",
      }),
    );
    expect(mockSheets).not.toHaveBeenCalled();
  });

  it("prefers the attached audit dashboard snapshot over an older dashboard summary", async () => {
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-109" },
      error: null,
    });
    const currentSnapshotMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "snapshot-109",
        sync_run_id: "run-109",
        created_at: "2026-04-26T06:15:18.000Z",
        data_json: {
          dashboard_summary: {
            project_name: "Project 1g17SLJD",
            workflow_stage: "manual_input_ready",
            highlights: [
              { label: "收入", value: "-", color: "slate" },
              { label: "成本", value: "-", color: "slate" },
              { label: "毛利", value: "-", color: "slate" },
              { label: "完工进度", value: "-", color: "slate" },
            ],
            audit_tabs: {
              reclass_audit: {
                overview: {
                  payable_count: 15823,
                  final_detail_count: 19376,
                  diff_count: 10,
                },
              },
            },
          },
          audit_dashboard_snapshot: {
            project_name: "WBWT Sandy Cove",
            workflow_stage: "manual_input_ready",
            highlights: [
              { label: "Revenue", value: "  -13,711,454.23 ", color: "blue" },
              { label: "Actual Cost", value: "  11,652,859.74 ", color: "indigo" },
              { label: "Gross Margin", value: "  -2,058,594.49 ", color: "emerald" },
              { label: "POC (%)", value: "100.00%", color: "purple" },
            ],
            audit_tabs: {
              external_recon: {
                summary: "live dashboard",
                discrepancies: [],
              },
              reclass_audit: {
                overview: {
                  payable_count: 15823,
                  final_detail_count: 19376,
                  diff_count: 10,
                },
              },
            },
          },
          audit_dashboard_last_synced_at: "2026-04-26T10:32:29.324Z",
        },
        mapping_manifest_json: {
          source_mode: "snapshot_plus_dashboard",
        },
      },
      error: null,
    });

    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => ({ maybeSingle: currentSnapshotMaybeSingle })),
                })),
              })),
            })),
          })),
        };
      }

      if (table === "audit_cache") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);

    const { getAuditSummary } = await import("@/lib/audit-service");
    const payload = await getAuditSummary("sheet-109");

    expect(payload).toEqual(
      expect.objectContaining({
        project_name: "WBWT Sandy Cove",
        highlights: expect.arrayContaining([
          expect.objectContaining({ label: "Revenue", value: "  -13,711,454.23 " }),
        ]),
        from_snapshot: true,
        snapshot_id: "snapshot-109",
        last_synced_at: "2026-04-26T10:32:29.324Z",
      }),
    );
  });

  it("computes fallback metrics from sheet discoveries for runtime fallback fields", async () => {
    const { buildMappingWarningMetrics } = await import("@/lib/audit-service");
    const metrics = buildMappingWarningMetrics([
      {
        sheet_name: "Payable",
        header_row_index: 1,
        header_cells: ["Vendor", "Amount"],
        candidates: [
          {
            logical_field: "vendor",
            column_index: 1,
            column_letter: "A",
            header_value: "Vendor",
            match_strategy: "exact",
            confidence: 1,
            is_required: true,
            is_selected: true,
            rejection_reason: null,
          },
          {
            logical_field: "amount",
            column_index: 2,
            column_letter: "B",
            header_value: "Amount",
            match_strategy: "exact",
            confidence: 1,
            is_required: true,
            is_selected: true,
            rejection_reason: null,
          },
        ],
      },
      {
        sheet_name: "Draw request report",
        header_row_index: 2,
        header_cells: ["Draw Invoice", "Unit Code"],
        candidates: [
          {
            logical_field: "unit_code",
            column_index: 2,
            column_letter: "B",
            header_value: "Unit Code",
            match_strategy: "exact",
            confidence: 1,
            is_required: false,
            is_selected: true,
            rejection_reason: null,
          },
        ],
      },
    ]);

    expect(metrics).toEqual({
      fallback_count: 3,
      fallback_fields: ["Payable.cost_name", "Payable.invoice_no", "Payable.unit_code"],
    });
  });

  it("acquires and releases a project run lock through Supabase RPC", async () => {
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            acquired: true,
            lock_token: "lock-1",
            active_operation: "audit_sync",
            expires_at: "2026-04-26T12:05:00.000Z",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: true,
        error: null,
      });

    const { acquireAuditProjectRunLock, releaseAuditProjectRunLock } = await import("@/lib/audit-service");
    const lock = await acquireAuditProjectRunLock({
      supabase: { rpc } as never,
      projectId: "project-1",
      operation: "audit_sync",
      owner: "unit-test",
      ttlSeconds: 300,
    });

    expect(lock).toEqual({
      project_id: "project-1",
      lock_token: "lock-1",
      operation: "audit_sync",
      expires_at: "2026-04-26T12:05:00.000Z",
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "try_acquire_audit_project_lock", {
      p_project_id: "project-1",
      p_operation: "audit_sync",
      p_owner: "unit-test",
      p_ttl_seconds: 300,
    });

    await releaseAuditProjectRunLock({
      supabase: { rpc } as never,
      projectId: "project-1",
      lockToken: "lock-1",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "release_audit_project_lock", {
      p_project_id: "project-1",
      p_lock_token: "lock-1",
    });
  });

  it("rejects a project run lock when another operation owns it", async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        {
          acquired: false,
          lock_token: null,
          active_operation: "formula_sync",
          expires_at: "2026-04-26T12:05:00.000Z",
        },
      ],
      error: null,
    });

    const { acquireAuditProjectRunLock, AuditSnapshotServiceError } = await import("@/lib/audit-service");

    await expect(
      acquireAuditProjectRunLock({
        supabase: { rpc } as never,
        projectId: "project-1",
        operation: "audit_sync",
        owner: "unit-test",
      }),
    ).rejects.toMatchObject({
      name: "AuditSnapshotServiceError",
      statusCode: 409,
      code: "PROJECT_RUN_LOCKED",
    });
    expect(AuditSnapshotServiceError).toBeDefined();
  });

  it("returns sync payload when audit_cache write fails after live snapshot generation", async () => {
    const projectIdMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-109" },
      error: null,
    });
    const projectTitleMaybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "109", project_sequence: "109" },
      error: null,
    });
    const projectsSelect = jest.fn((columns: string) => ({
      eq: jest.fn(() => ({
        maybeSingle: columns.includes("sheet_109_title")
          ? projectTitleMaybeSingle
          : projectIdMaybeSingle,
      })),
    }));
    const auditSyncInsertSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const auditCacheSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "cache write failed", code: "23505" },
    });
    const currentSnapshotMaybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: null,
    });
    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: projectsSelect,
        };
      }

      if (table === "audit_sync_runs") {
        return {
          insert: jest.fn(() => ({
            select: jest.fn(() => ({ single: auditSyncInsertSingle })),
          })),
        };
      }

      if (table === "audit_cache") {
        return {
          upsert: jest.fn(() => ({
            select: jest.fn(() => ({ single: auditCacheSingle })),
          })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => ({ maybeSingle: currentSnapshotMaybeSingle })),
                })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            acquired: true,
            lock_token: "lock-109",
            active_operation: "audit_sync",
            expires_at: "2026-04-26T12:05:00.000Z",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: true,
        error: null,
      });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [["WBWT Sandy Cove"]] },
          { values: [["Header"], ["", "", "WBWT Sandy Cove"]] },
          { values: [["Unit Budget"]] },
          { values: [["Payable"]] },
          { values: [["Final Detail"]] },
          { values: [["Draw"]] },
          { values: [["Unit Master"]] },
          { values: [["Scoping"]] },
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from, rpc } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
      },
    });

    const { syncAuditSummary } = await import("@/lib/audit-service");
    await expect(syncAuditSummary("sheet-109")).resolves.toEqual(
      expect.objectContaining({
        spreadsheetId: "sheet-109",
        snapshot: expect.objectContaining({
          project_name: "Test Project",
        }),
      }),
    );
    expect(from).toHaveBeenCalledWith("audit_cache");
    expect(rpc).toHaveBeenNthCalledWith(2, "release_audit_project_lock", {
      p_project_id: "project-109",
      p_lock_token: "lock-109",
    });
  });

  it("records a running audit sync run before reading the live spreadsheet", async () => {
    const projectIdMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-109" },
      error: null,
    });
    const projectTitleMaybeSingle = jest.fn().mockResolvedValue({
      data: { sheet_109_title: "109", project_sequence: "109" },
      error: null,
    });
    const projectsSelect = jest.fn((columns: string) => ({
      eq: jest.fn(() => ({
        maybeSingle: columns.includes("sheet_109_title")
          ? projectTitleMaybeSingle
          : projectIdMaybeSingle,
      })),
    }));
    const auditSyncInsertSingle = jest.fn().mockResolvedValue({
      data: { id: "run-early" },
      error: null,
    });
    const auditSyncInsert = jest.fn(() => ({
      select: jest.fn(() => ({ single: auditSyncInsertSingle })),
    }));
    const auditSyncUpdateEq = jest.fn().mockResolvedValue({
      data: null,
      error: null,
    });
    const auditSyncUpdate = jest.fn(() => ({ eq: auditSyncUpdateEq }));
    const discoveryInsertSingle = jest.fn().mockResolvedValue({
      data: null,
      error: { message: "table missing", code: "PGRST205" },
    });
    const cacheSingle = jest.fn().mockResolvedValue({
      data: { project_id: "sheet-109", last_synced_at: "2026-04-26T12:00:00.000Z" },
      error: null,
    });
    const currentSnapshotMaybeSingle = jest.fn().mockResolvedValue({
      data: null,
      error: null,
    });
    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: projectsSelect,
        };
      }

      if (table === "audit_sync_runs") {
        return {
          insert: auditSyncInsert,
          update: auditSyncUpdate,
        };
      }

      if (table === "sheet_discovery_snapshots") {
        return {
          insert: jest.fn(() => ({
            select: jest.fn(() => ({ single: discoveryInsertSingle })),
          })),
        };
      }

      if (table === "audit_cache") {
        return {
          upsert: jest.fn(() => ({
            select: jest.fn(() => ({ single: cacheSingle })),
          })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              eq: jest.fn(() => ({
                order: jest.fn(() => ({
                  limit: jest.fn(() => ({ maybeSingle: currentSnapshotMaybeSingle })),
                })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });
    const rpc = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            acquired: true,
            lock_token: "lock-109",
            active_operation: "audit_sync",
            expires_at: "2026-04-26T12:05:00.000Z",
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: true,
        error: null,
      });
    const batchGet = jest.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { values: [["WBWT Sandy Cove"]] },
          { values: [["Header"], ["", "", "WBWT Sandy Cove"]] },
          { values: [["Unit Budget"]] },
          { values: [["Payable"]] },
          { values: [["Final Detail"]] },
          { values: [["Draw"]] },
          { values: [["Unit Master"]] },
          { values: [["Scoping"]] },
        ],
      },
    });

    mockCreateClient.mockReturnValue({ from, rpc } as never);
    mockSheets.mockReturnValue({
      spreadsheets: {
        values: {
          batchGet,
        },
      },
    });

    const { syncAuditSummary } = await import("@/lib/audit-service");
    await syncAuditSummary("sheet-109");

    expect(auditSyncInsert).toHaveBeenCalledTimes(1);
    expect(auditSyncInsert).toHaveBeenCalledWith({
      project_id: "project-109",
      spreadsheet_id: "sheet-109",
      trigger_source: "manual",
      status: "running",
      source_last_edit_at: null,
    });
    expect(auditSyncInsert.mock.invocationCallOrder[0]).toBeLessThan(
      batchGet.mock.invocationCallOrder[0],
    );
    expect(auditSyncUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
      }),
    );
    expect(auditSyncUpdateEq).toHaveBeenCalledWith("id", "run-early");
  });

  it("loads the latest audit sync run status for a spreadsheet", async () => {
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-109" },
      error: null,
    });
    const syncRunMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: "run-109",
        status: "running",
        created_at: "2026-04-26T12:00:00.000Z",
        finished_at: null,
        source_last_edit_at: null,
        error_message: null,
      },
      error: null,
    });
    const syncRunEq = jest.fn(() => ({
      eq: jest.fn(() => ({
        order: jest.fn(() => ({
          limit: jest.fn(() => ({ maybeSingle: syncRunMaybeSingle })),
        })),
      })),
    }));
    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_sync_runs") {
        return {
          select: jest.fn(() => ({
            eq: syncRunEq,
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);

    const { getLatestAuditSyncRunStatus } = await import("@/lib/audit-service");
    const payload = await getLatestAuditSyncRunStatus("sheet-109", "run-109");

    expect(payload).toEqual({
      spreadsheet_id: "sheet-109",
      project_id: "project-109",
      latest_run: {
        sync_run_id: "run-109",
        status: "running",
        created_at: "2026-04-26T12:00:00.000Z",
      },
    });
    expect(syncRunEq).toHaveBeenCalledWith("project_id", "project-109");
    expect(syncRunEq.mock.results[0].value.eq).toHaveBeenCalledWith("id", "run-109");
  });

  it("falls back to snapshot-only query when audit_sync_runs embed relation is unavailable", async () => {
    const projectMaybeSingle = jest.fn().mockResolvedValue({
      data: { id: "project-1" },
      error: null,
    });
    const auditSnapshotsSelect = jest.fn((query: string) => {
      const chain = (payload: unknown) => ({
        eq: jest.fn(() => ({
          order: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue(payload),
          })),
        })),
      });

      if (query.includes("audit_sync_runs(status)")) {
        return chain({
          data: null,
          error: {
            code: "PGRST200",
            message: "Could not find a relationship between 'audit_snapshots' and 'audit_sync_runs'",
          },
        });
      }

      return chain({
        data: [
          {
            id: "snapshot-1",
            sync_run_id: "run-1",
            created_at: "2026-04-26T12:00:00.000Z",
            is_current: true,
            source_last_edit_at: "2026-04-26T11:59:00.000Z",
            data_json: {
              classification_decisions: {
                payable: [{ row_index_1based: 1 }],
                final_detail: [{ row_index_1based: 2 }],
              },
              formula_plan_templates: [{ sheet: "110", cell: "E12", formula_template: "=${Payable.amount}" }],
            },
          },
        ],
        error: null,
      });
    });

    const from = jest.fn((table: string) => {
      if (table === "projects") {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: projectMaybeSingle })) })),
        };
      }

      if (table === "audit_snapshots") {
        return {
          select: auditSnapshotsSelect,
        };
      }

      if (table === "audit_sync_runs") {
        return {
          select: jest.fn(() => ({
            in: jest.fn().mockResolvedValue({
              data: null,
              error: { code: "PGRST205", message: "table not found" },
            }),
          })),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    });

    mockCreateClient.mockReturnValue({ from } as never);
    const { listAuditSnapshots } = await import("@/lib/audit-service");

    const payload = await listAuditSnapshots("sheet-123", 10);

    expect(auditSnapshotsSelect).toHaveBeenCalledTimes(1);
    expect(payload).toEqual({
      project_id: "project-1",
      spreadsheet_id: "sheet-123",
      items: [
        {
          snapshot_id: "snapshot-1",
          sync_run_id: "run-1",
          created_at: "2026-04-26T12:00:00.000Z",
          is_current: true,
          sync_run_status: "unknown",
          source_last_edit_at: "2026-04-26T11:59:00.000Z",
          decision_count: 2,
          formula_template_count: 1,
        },
      ],
    });
  });

  it("computes mapping score metrics from selected discovery candidates", async () => {
    const { buildMappingScoreMetrics } = await import("@/lib/audit-service");
    const metrics = buildMappingScoreMetrics([
      {
        sheet_name: "Payable",
        header_row_index: 1,
        header_cells: ["Vendor", "Amount"],
        candidates: [
          {
            logical_field: "vendor",
            column_index: 1,
            column_letter: "A",
            header_value: "Vendor",
            match_strategy: "exact",
            confidence: 1,
            is_required: true,
            is_selected: true,
            rejection_reason: null,
          },
          {
            logical_field: "amount",
            column_index: 2,
            column_letter: "B",
            header_value: "Amount",
            match_strategy: "alias",
            confidence: 0.9,
            is_required: true,
            is_selected: true,
            rejection_reason: null,
          },
        ],
      },
    ]);

    expect(metrics).toEqual({
      mapping_score: 0.95,
      mapping_field_count: 2,
    });
  });

  it("computes decision-level diff summary from two snapshot payloads", async () => {
    const { computeSnapshotDecisionDiff } = await import("@/lib/audit-service");
    const diff = computeSnapshotDecisionDiff(
      {
        classification_decisions: {
          payable: [
            { row_index_1based: 1, category: "Direct", rule_id: "R101" },
            { row_index_1based: 2, category: "ROE", rule_id: "R204" },
          ],
          final_detail: [{ row_index_1based: 1, category: "Income", rule_id: "R301" }],
        },
        formula_plan_templates: [{ sheet: "109", cell: "E12", formula_template: "=${Payable.amount}" }],
      },
      {
        classification_decisions: {
          payable: [
            { row_index_1based: 1, category: "Direct", rule_id: "R101" },
            { row_index_1based: 2, category: "EXP", rule_id: "R205" },
          ],
          final_detail: [{ row_index_1based: 1, category: "Income", rule_id: "R301" }],
        },
        formula_plan_templates: [{ sheet: "109", cell: "E12", formula_template: "=${Payable.amount}*1.01" }],
      },
    );

    expect(diff).toEqual({
      decision_change_count: 1,
      table_change_counts: {
        payable: 1,
        final_detail: 0,
      },
      formula_template_change_count: 1,
    });
  });
});
