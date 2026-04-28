/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createClient } from "@supabase/supabase-js";

import Home from "@/pages/index";

const signInMock = jest.fn();
const signOutMock = jest.fn();

let sessionData: { user: { email: string } } | null = { user: { email: "test@example.com" } };

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: sessionData }),
  signIn: (...args: unknown[]) => signInMock(...args),
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

const replaceMock = jest.fn();
const routerState = {
  query: { spreadsheetId: "sheet-123" } as Record<string, string>,
  asPath: "/?spreadsheetId=sheet-123",
};

jest.mock("next/router", () => ({
  useRouter: () => ({
    query: routerState.query,
    replace: replaceMock,
    asPath: routerState.asPath,
  }),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

function jsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, resolve, reject };
}

function baseDashboardPayload() {
  return {
    project_name: "Sandy Cove",
    workflow_stage: "external_data_ready",
    highlights: [
      { label: "收入", value: "$800,000", color: "emerald" },
      { label: "成本", value: "$540,000", color: "slate" },
      { label: "毛利", value: "$260,000", color: "emerald" },
      { label: "完工进度", value: "68%", color: "amber" },
    ],
    audit_tabs: {
      external_recon: {
        summary: "首轮核对完成",
        discrepancies: [],
        unit_common_counts: [
          { table_name: "Unit Budget", unit_count: 2, common_count: 0 },
          {
            table_name: "Payable",
            unit_count: 1,
            common_count: 2,
          },
          { table_name: "Final Detail", unit_count: 1, common_count: 0 },
          { table_name: "Draw Request report", unit_count: 1, common_count: 0 },
        ],
        cost_state_matrix: [
          {
            cost_state: "Direct",
            payable_amount: 1700,
            final_detail_amount: 900,
            draw_request_amount: 700,
            draw_request_diff_count: 0,
          },
          {
            cost_state: "未分配",
            payable_amount: 25,
            final_detail_amount: 0,
            draw_request_amount: 0,
            draw_request_diff_count: 1,
          },
        ],
        cost_state_totals: {
          payable: { grouped_total: 1725, raw_total: 1725, mismatch: false },
          final_detail: { grouped_total: 900, raw_total: 900, mismatch: false },
          draw_request: { grouped_total: 700, raw_total: 700, mismatch: false },
        },
        internal_company_cost_state_matrix: [
          { company_name: "AMG Crown Fund LLC", cost_state: "ROE", amount: 120 },
          { company_name: "WB Home LLC", cost_state: "Direct", amount: 500 },
          { company_name: "WB Home LLC", cost_state: "未分配", amount: 25 },
        ],
        unit_budget_variances: [],
        detail_rows: [
          {
            source_table: "Payable",
            row_no: 2,
            unit_code: "A-102",
            vendor: "WB Home LLC",
            old_cost_state: "Direct",
            cost_name: "100 Administration",
            amount: 500,
          },
          {
            source_table: "Payable",
            row_no: 4,
            unit_code: "",
            vendor: "WB Home LLC",
            old_cost_state: "未分配",
            cost_name: "699 Interest Reserves",
            amount: 25,
          },
          {
            source_table: "Payable",
            row_no: 12,
            unit_code: "A-101",
            vendor: "Acme Drywall",
            old_cost_state: "Direct",
            cost_name: "033000 / Finishes",
            amount: 1200,
          },
          {
            source_table: "Final Detail",
            row_no: 3,
            unit_code: "A-101",
            vendor: "Bravo Plumbing",
            old_cost_state: "Direct",
            cost_name: "033000 / Finishes",
            amount: 900,
          },
        ],
        comparison_rows: [
          {
            comparison_key: "aligned-key",
            invoice_label: "INV-001",
            vendor: "WB Home LLC",
            unit_code: "A-102",
            cost_code: "1SF116",
            amount: 500,
            payable_cost_states: ["Direct"],
            final_detail_cost_states: ["Direct"],
            draw_request_cost_states: ["Direct"],
            is_fully_aligned: true,
          },
          {
            comparison_key: "mismatch-key",
            invoice_label: "WPRED-SandyCove-11",
            vendor: "The Home Depot",
            unit_code: "WBWT Sandy Cove Common",
            cost_code: "2HD540",
            amount: 84.61,
            payable_cost_states: ["Income"],
            final_detail_cost_states: ["Direct"],
            draw_request_cost_states: ["未分配"],
            is_fully_aligned: false,
          },
        ],
      },
      manual_input: {
        profit_statement_entries: [
          {
            cell_position: "I12",
            field_name: "Revenue",
            amount: 800000,
          },
        ],
        validation_errors: [
          {
            rule_id: "roe_wbhome_mismatch",
            label: "E32 ROE成本 - WB Home 不等于 -E41 WB Home收入",
            severity: "error",
          },
        ],
        scoping_groups: [
          {
            group: "G-01",
            group_name: "Scope Group",
            scope_values: "1/3/5",
            e: "1",
            f: "",
            g: "3",
            h: "",
            i: "5",
            j: "",
            warranty_months: "12",
            warranty_due_date: "2026-12-31",
            budget_amount: 250000,
            incurred_amount: 125000,
            status: "",
          },
        ],
        unit_master_dates: [
          {
            unit_code: "A-101",
            co_date: "01/20/2025",
            final_date: "01/15/2025",
            actual_settlement_date: "02/01/2025",
            tbd_acceptance_date: "01/28/2025",
            final_date_invalid: true,
            actual_settlement_date_invalid: false,
            tbd_acceptance_date_invalid: true,
          },
        ],
      },
      reclass_audit: {
        overview: {
          payable_amount: 300,
          payable_count: 1,
          final_detail_amount: 125,
          final_detail_count: 1,
          diff_count: 0,
          old_total: 300,
          new_total: 125,
          diff_amount: 175,
          diff_invoice_count: 0,
        },
        category_rows: [
          {
            category: "ROE",
            payable_amount: 300,
            payable_count: 1,
            final_detail_amount: 125,
            final_detail_count: 1,
            diff_count: 0,
            old_total: 300,
            new_total: 125,
            diff_amount: 175,
            diff_invoice_count: 0,
          },
        ],
        table_summaries: [
          {
            source_table: "Payable",
            total_amount: 300,
            total_count: 1,
            changed_amount: 300,
            changed_count: 1,
            unchanged_amount: 0,
            unchanged_count: 0,
            before_rows: [{ cost_state: "Direct", amount: 300, count: 1 }],
            after_rows: [{ cost_state: "ROE", amount: 300, count: 1 }],
            transition_rows: [{ old_cost_state: "Direct", new_cost_state: "ROE", amount: 300, count: 1 }],
            internal_company_transition_rows: [
              {
                company_name: "WB Home LLC",
                old_cost_state: "Direct",
                new_cost_state: "ROE",
                amount: 300,
                count: 1,
              },
            ],
          },
          {
            source_table: "Final Detail",
            total_amount: 125,
            total_count: 1,
            changed_amount: 125,
            changed_count: 1,
            unchanged_amount: 0,
            unchanged_count: 0,
            before_rows: [{ cost_state: "Direct", amount: 125, count: 1 }],
            after_rows: [{ cost_state: "ROE", amount: 125, count: 1 }],
            transition_rows: [{ old_cost_state: "Direct", new_cost_state: "ROE", amount: 125, count: 1 }],
            internal_company_transition_rows: [
              {
                company_name: "WB Home LLC",
                old_cost_state: "Direct",
                new_cost_state: "ROE",
                amount: 125,
                count: 1,
              },
            ],
          },
        ],
        rule_rows: [
          {
            rule_id: "R105",
            category: "ROE",
            old_cost_states: ["Direct"],
            amount: 300,
            diff_amount: 300,
            invoice_count: 1,
          },
        ],
        invoice_rows: [
          {
            source_table: "Payable",
            row_no: 1,
            vendor: "WB Home LLC",
            amount: 300,
            incurred_date: "2025-01-05",
            unit_code: "B-201",
            cost_code: "1SF100",
            cost_name: "100 Administration",
            old_cost_state: "Direct",
            new_category: "ROE",
            rule_id: "R105",
            match_status: "reclassed",
            present_in_final_detail: false,
          },
          {
            source_table: "Final Detail",
            row_no: 1,
            vendor: "WB Home LLC",
            amount: 125,
            incurred_date: "2025-01-05",
            unit_code: "B-201",
            cost_code: "1SF100",
            cost_name: "100 Administration",
            old_cost_state: "Direct",
            new_category: "ROE",
            rule_id: "R105",
            match_status: "reclassed",
            present_in_final_detail: true,
          },
        ],
        internal_company_category_matrix: [
          {
            company_name: "WB Home LLC",
            category: "ROE",
            payable_amount: 300,
            final_detail_amount: 125,
            diff_amount: 175,
          },
        ],
        sankey: { nodes: [], links: [] },
      },
      compare_109: {
        metric_rows: [
          {
            label: "收入",
            year_rows: [
              { year_offset: 0, year_label: "2024", company: 100, audit: 90, diff: 10, has_value: true },
              { year_offset: 1, year_label: "2025", company: 0, audit: 0, diff: 0, has_value: false },
            ],
          },
          {
            label: "成本",
            year_rows: [
              { year_offset: 0, year_label: "2024", company: 80, audit: 70, diff: 10, has_value: true },
              { year_offset: 1, year_label: "2025", company: 0, audit: 0, diff: 0, has_value: false },
            ],
          },
          {
            label: "毛利",
            year_rows: [
              { year_offset: 0, year_label: "2024", company: 20, audit: 20, diff: 0, has_value: true },
              { year_offset: 1, year_label: "2025", company: 0, audit: 0, diff: 0, has_value: false },
            ],
          },
        ],
      },
      scoping_logic: [],
    },
  };
}

function baseProjectStatePayload(overrides?: Record<string, unknown>) {
  return {
    state: {
      current_stage: "external_data_ready",
      locked: false,
      external_data_dirty: false,
      manual_input_dirty: false,
      is_owner_or_admin: true,
      last_sync_at: "2026-04-23T06:00:00.000Z",
      ...overrides,
    },
    logs: [
      {
        timestamp: "2026-04-23T06:00:00.000Z",
        actor_email: "owner@example.com",
        action: "validate_input",
        previous_stage: "project_created",
        next_stage: "external_data_ready",
        status: "success",
        message: "Input data validated.",
      },
    ],
    edit_logs: [
      {
        timestamp: "2026-04-23T06:10:00.000Z",
        actor_email: "editor@example.com",
        sheet_name: "Payable",
        edited_range: "A12:B12",
        edit_area_type: "external_data",
        source: "apps_script",
      },
    ],
  };
}

describe("phase 1 workbench page", () => {
  beforeEach(() => {
    sessionData = { user: { email: "test@example.com" } };
    replaceMock.mockReset();
    signInMock.mockReset();
    signOutMock.mockReset();
    mockCreateClient.mockReset();
    routerState.query = { spreadsheetId: "sheet-123" };
    routerState.asPath = "/?spreadsheetId=sheet-123";
    window.localStorage.clear();
  });

  it("uses the new login copy", () => {
    sessionData = null;
    global.fetch = jest.fn() as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    expect(screen.getByText("审计工作台")).toBeTruthy();
    expect(screen.getByText("Start")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Gmail 登录" })).toBeTruthy();
    expect(screen.getByText("已登记非 Gmail 邮箱")).toBeTruthy();
  });

  it("shows project summary first when multiple projects exist", async () => {
    routerState.query = {};
    routerState.asPath = "/";
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "summary",
          projects: [
            { id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-1" },
            { id: "p2", name: "Sunrise Villas", spreadsheet_id: "sheet-2" },
          ],
        });
      }

      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "打开项目 Sandy Cove" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "打开项目 Sandy Cove" }));
    expect(replaceMock).toHaveBeenCalledWith("/?spreadsheetId=sheet-1");
  });

  it("uses Drive sharing guidance when no accessible projects exist", async () => {
    routerState.query = {};
    routerState.asPath = "/";
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "empty",
          projects: [],
        });
      }

      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() =>
      expect(
        screen.getByText("当前账号暂无可访问项目。请确认该邮箱已加入项目 Google Sheet 分享名单，或创建一个新项目。"),
      ).toBeTruthy(),
    );
  });

  it("lets a writable Drive collaborator submit audit confirmation", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "manual_input_ready",
            is_owner_or_admin: false,
            can_write: true,
            drive_role: "writer",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/projects/action")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });
    global.fetch = fetchMock as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "提交审计确认" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "提交审计确认" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).startsWith("/api/projects/action") &&
            init?.method === "POST" &&
            init.body === JSON.stringify({ spreadsheet_id: "sheet-123", action: "approve_109" }),
        ),
      ).toBe(true),
    );
  });

  it("hides workflow write actions for readonly Drive collaborators", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "manual_input_ready",
            is_owner_or_admin: true,
            can_write: false,
            drive_role: "reader",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "同步数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "验证录入数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "成本重分类" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交审计确认" })).toBeNull();
  });

  it("lets writable collaborators select an external import file, confirm it, and refresh status", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "external_data_ready",
            is_owner_or_admin: false,
            can_write: true,
            drive_role: "writer",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/external_import/status")) {
        return jsonResponse({
          manifest: {
            tables: [
              {
                detected_table: "Payable",
                file_name: "payable-april.xlsx",
                source_sheet: "Payable",
                row_count: 128,
                amount_total: 45000,
                semantic_target_zone: "external_data.payable",
                status: "preview_ready",
                warnings: ["Amount column normalized"],
                blocking: [],
              },
              {
                detected_table: "Final Detail",
                file_name: "final-detail-current.xlsx",
                source_sheet: "Final Detail",
                row_count: 64,
                amount_total: 32000,
                semantic_target_zone: "external_data.final_detail",
                status: "retained",
                warnings: [],
                blocking: [],
              },
            ],
          },
        });
      }
      if (url.startsWith("/api/external_import/preview")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toEqual(expect.any(String));
        return jsonResponse({
          status: "preview_ready",
          spreadsheet_id: "sheet-123",
          preview_hash: "preview-hash-123",
          confirm_allowed: true,
          source_tables: [
            {
              source_role: "payable",
              source_sheet_name: "Payable",
              row_count: 128,
              amount_total: 45000,
              target_zone_id: "external_import.payable_raw",
              status: "preview_ready",
              warnings: ["Amount column normalized"],
              blocking_issues: [],
            },
          ],
          files: [],
        });
      }
      if (url.startsWith("/api/external_import/confirm")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ spreadsheet_id: "sheet-123", preview_hash: "preview-hash-123" }));
        return jsonResponse({ status: "queued", job_id: "job-123" });
      }
      return jsonResponse({});
    });
    global.fetch = fetchMock as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByLabelText("选择外部导入文件")).toBeTruthy());
    expect(screen.getByText("只会替换本次识别到的外部表。未上传的表保留当前版本。")).toBeTruthy();
    expect(screen.getByText("导入成功后会自动验证录入数据。")).toBeTruthy();
    expect(screen.getAllByText("Payable").length).toBeGreaterThan(0);
    expect(screen.getByText("payable-april.xlsx")).toBeTruthy();
    expect(screen.getByText("external_data.payable")).toBeTruthy();
    expect(screen.getByText("Amount column normalized")).toBeTruthy();
    expect(screen.getAllByText("Final Detail").length).toBeGreaterThan(0);
    expect(screen.getByText("retained")).toBeTruthy();

    const file = new File(["demo"], "payable-april.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(screen.getByLabelText("选择外部导入文件"), { target: { files: [file] } });
    expect(screen.getByText("已选择 payable-april.xlsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "预览导入" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/external_import/preview"))).toBe(true),
    );
    expect(screen.getByText("预览完成，可以确认导入")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认导入" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/external_import/confirm"))).toBe(true),
    );
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/external_import/status")).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps preview available but disables external import confirm when the worker is not configured", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "external_data_ready",
            is_owner_or_admin: false,
            can_write: true,
            drive_role: "writer",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/external_import/status")) {
        return jsonResponse({
          status: "not_started",
          worker_configured: false,
          manifest_items: [],
        });
      }
      if (url.startsWith("/api/external_import/preview")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({
          status: "preview_ready",
          spreadsheet_id: "sheet-123",
          preview_hash: "preview-hash-123",
          confirm_allowed: true,
          worker_configured: false,
          source_tables: [
            {
              source_role: "payable",
              source_sheet_name: "Payable",
              row_count: 1,
              amount_total: 100,
              target_zone_key: "external_import.payable_raw",
              status: "preview_ready",
              warnings: [],
              blocking_issues: [],
            },
          ],
          files: [],
        });
      }
      return jsonResponse({});
    });
    global.fetch = fetchMock as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByLabelText("选择外部导入文件")).toBeTruthy());
    expect(screen.getByText("外部导入 Worker 未配置，确认导入暂不可用。")).toBeTruthy();

    const file = new File(["demo"], "payable-april.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(screen.getByLabelText("选择外部导入文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "预览导入" }));

    await waitFor(() => expect(screen.getByText("预览完成；外部导入 Worker 未配置，暂不能确认导入")).toBeTruthy());
    expect(screen.getByRole("button", { name: "确认导入" })).toHaveProperty("disabled", true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/external_import/confirm"))).toBe(false);
  });

  it("uploads large external import files through signed storage before previewing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.com";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    const uploadToSignedUrl = jest.fn().mockResolvedValue({ data: { path: "external-import/sheet-123/upload-1/draw.xlsx" }, error: null });
    mockCreateClient.mockReturnValue({
      storage: {
        from: jest.fn(() => ({
          uploadToSignedUrl,
        })),
      },
    } as never);

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "external_data_ready",
            is_owner_or_admin: false,
            can_write: true,
            drive_role: "writer",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/external_import/status")) {
        return jsonResponse({ status: "not_started", manifest_items: [] });
      }
      if (url.startsWith("/api/external_import/upload")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          spreadsheet_id: "sheet-123",
          files: [
            {
              file_name: "_Draw request report_2026-04-27.xlsx",
              size: 6291457,
            },
          ],
        });
        return jsonResponse({
          status: "upload_ready",
          spreadsheet_id: "sheet-123",
          bucket: "external-import-uploads",
          files: [
            {
              file_name: "_Draw request report_2026-04-27.xlsx",
              bucket: "external-import-uploads",
              path: "external-import/sheet-123/upload-1/draw.xlsx",
              token: "signed-token",
              upload_url: "https://storage.example.com/signed",
            },
          ],
        });
      }
      if (url.startsWith("/api/external_import/preview")) {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          spreadsheet_id: "sheet-123",
          storage_files: [
            {
              file_name: "_Draw request report_2026-04-27.xlsx",
              path: "external-import/sheet-123/upload-1/draw.xlsx",
            },
          ],
        });
        expect(String(init?.body)).not.toContain("content_base64");
        return jsonResponse({
          status: "preview_ready",
          spreadsheet_id: "sheet-123",
          preview_hash: "preview-hash-123",
          confirm_allowed: true,
          worker_configured: true,
          source_tables: [],
          files: [],
        });
      }
      return jsonResponse({});
    });
    global.fetch = fetchMock as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByLabelText("选择外部导入文件")).toBeTruthy());
    const file = new File([new Uint8Array(6 * 1024 * 1024 + 1)], "_Draw request report_2026-04-27.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    fireEvent.change(screen.getByLabelText("选择外部导入文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "预览导入" }));

    await waitFor(() => expect(uploadToSignedUrl).toHaveBeenCalledWith(
      "external-import/sheet-123/upload-1/draw.xlsx",
      "signed-token",
      file,
      { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: true },
    ));
    await waitFor(() => expect(screen.getByText("预览完成，可以确认导入")).toBeTruthy());
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/external_import/upload"))).toBe(true);
  });

  it("shows external import status to readonly collaborators without upload controls", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "external_data_ready",
            is_owner_or_admin: false,
            can_write: false,
            drive_role: "reader",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/external_import/status")) {
        return jsonResponse({
          manifest: {
            tables: [
              {
                detected_table: "Payable",
                file_name: "payable-april.xlsx",
                source_sheet: "Payable",
                row_count: 128,
                amount_total: 45000,
                semantic_target_zone: "external_data.payable",
                status: "succeeded",
                warnings: [],
                blocking: [],
              },
              {
                detected_table: "Draw Request report",
                file_name: "current-drive-version",
                source_sheet: "Draw Request report",
                row_count: 42,
                amount_total: 12000,
                semantic_target_zone: "external_data.draw_request",
                status: "retained",
                warnings: ["No file uploaded in this run"],
                blocking: ["Waiting for collaborator upload"],
              },
            ],
          },
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByText("外部数据导入")).toBeTruthy());
    expect(screen.getByText("Reader/Commenter 只能查看导入状态，不能上传。")).toBeTruthy();
    expect(screen.queryByLabelText("选择外部导入文件")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认导入" })).toBeNull();
    await waitFor(() => expect(screen.getAllByText("Payable").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Draw Request report").length).toBeGreaterThan(0);
    expect(screen.getByText("No file uploaded in this run")).toBeTruthy();
    expect(screen.getByText("Waiting for collaborator upload")).toBeTruthy();
  });

  it("requires a three-digit project serial before allowing project creation", async () => {
    routerState.query = {};
    routerState.asPath = "/";
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "summary",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-1", sheet_109_title: "109" }],
        });
      }
      if (url.startsWith("/api/projects/init")) {
        return jsonResponse({
          spreadsheetId: "sheet-999",
        });
      }

      return jsonResponse({});
    });
    global.fetch = fetchMock as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "添加新项目" }).length).toBeGreaterThan(0));
    const addButtons = screen.getAllByRole("button", { name: "添加新项目" });
    fireEvent.click(addButtons[addButtons.length - 1]);

    fireEvent.change(screen.getByLabelText("Project Short Name"), { target: { value: "Project Atlas" } });
    fireEvent.change(screen.getByLabelText("Project Owner"), { target: { value: "Taylor Chen" } });
    fireEvent.change(screen.getByLabelText("Project Serial"), { target: { value: "12" } });

    expect(screen.getByRole("button", { name: "创建项目" })).toHaveProperty("disabled", true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/projects/init"))).toBe(false);

    fireEvent.change(screen.getByLabelText("Project Serial"), { target: { value: "109" } });
    expect(screen.getByRole("button", { name: "创建项目" })).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/projects/init"))).toBe(true),
    );
    const initCall = fetchMock.mock.calls.find(([input]) => String(input).startsWith("/api/projects/init"));
    expect(initCall?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        projectShortName: "Project Atlas",
        projectName: "Project Atlas",
        projectOwner: "Taylor Chen",
        projectSerial: "109",
      }),
    });
  });

  it("redirects directly when only one project exists", async () => {
    routerState.query = {};
    routerState.asPath = "/";
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }

      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/?spreadsheetId=sheet-123"));
  });

  it("keeps route spreadsheetId when list mode is direct", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Another Project", spreadsheet_id: "sheet-999" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    });
    global.fetch = fetchMock as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());
    expect(replaceMock).not.toHaveBeenCalledWith("/?spreadsheetId=sheet-999");
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/projects/state?spreadsheet_id=sheet-123"),
      ),
    ).toBe(true);
  });

  it("keeps the registered project name when the dashboard summary has a placeholder name", async () => {
    routerState.query = { spreadsheetId: "sheet-109" };
    routerState.asPath = "/?spreadsheetId=sheet-109";
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [
            {
              id: "p109",
              name: "WBWT Sandy Cove",
              spreadsheet_id: "sheet-109",
              sheet_109_title: "109",
            },
          ],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse({
          ...baseDashboardPayload(),
          project_name: "Project 1g17SLJD",
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "109 · WBWT Sandy Cove" })).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "109 · Project 1g17SLJD" })).toBeNull();
  });

  it("renders user-facing buttons and hides maintenance buttons", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "同步数据" })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "验证录入数据" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "成本重分类" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交审计确认" })).toBeTruthy();
    expect(screen.queryByText("同步109/保护规则")).toBeNull();
    expect(screen.queryByText("验证正式表")).toBeNull();
  });

  it("renders summary highlight cards with label and value on a single row", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByText("$800,000")).toBeTruthy());
    const incomeCard = screen.getByText("收入").parentElement;
    const highlightStack = incomeCard?.parentElement;

    expect(highlightStack?.className).not.toContain("sm:grid-cols-2");
    expect(incomeCard?.className).toContain("flex");
    expect(incomeCard?.className).toContain("items-center");
    expect(incomeCard?.className).toContain("justify-between");
  });

  it("renders the renamed tabs, opens manual input, and shows external recon amount details without reclass category", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-总览" })).toBeTruthy());

    expect(screen.getByRole("button", { name: "标签页-总览" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标签页-外部数据核对" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标签页-手工录入核对" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标签页-成本重分类" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标签页-项目利润表对比" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "标签页-手工录入核对" }));
    expect(screen.getByText("项目利润表录入金额")).toBeTruthy();
    expect(screen.getByText("年份")).toBeTruthy();
    expect(screen.getByText("Revenue")).toBeTruthy();
    expect(screen.getByText("2024")).toBeTruthy();
    expect(screen.queryByText("错误数据")).toBeNull();
    expect(screen.queryByText("级别")).toBeNull();
    expect(screen.queryByText("Rule ID")).toBeNull();
    expect(screen.queryByText("roe_wbhome_mismatch")).toBeNull();
    expect(screen.queryByText("E32 ROE成本 - WB Home 不等于 -E41 WB Home收入")).toBeNull();
    expect(screen.getAllByText("Scoping").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("E-J")).toBeNull();
    expect(screen.getByText("保修月数")).toBeTruthy();
    expect(screen.getByText("保修到期日")).toBeTruthy();
    expect(screen.getByText("G-01")).toBeTruthy();
    expect(screen.getByText("Scope Group")).toBeTruthy();
    expect(screen.getByText("1/3/5")).toBeTruthy();
    expect(screen.queryByText("Budget amount")).toBeNull();
    expect(screen.queryByText("Incurred amount")).toBeNull();
    expect(screen.getByText("Unit Master 日期链")).toBeTruthy();
    expect(screen.getByText("Unit Code")).toBeTruthy();
    expect(screen.getByText("C/O date")).toBeTruthy();
    expect(screen.getByText("TBD Acceptance Date")).toBeTruthy();
    expect(screen.queryByText("Final Date")).toBeNull();
    expect(screen.queryByText("实际结算日期")).toBeNull();
    expect(screen.getAllByText("A-101").length).toBeGreaterThan(0);
    expect(screen.getByText("01/20/2025")).toBeTruthy();
    const acceptanceDateCell = screen.getByText("01/28/2025");
    expect(acceptanceDateCell.className).toContain("text-red-600");

    fireEvent.click(screen.getByRole("button", { name: "标签页-外部数据核对" }));
    fireEvent.click(screen.getByRole("button", { name: "查看 Direct Payable 金额明细" }));

    const drawerHeading = screen.getByRole("heading", { name: "金额明细" });
    const drawer = drawerHeading.closest("aside");

    expect(drawerHeading).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(within(drawer as HTMLElement).getAllByText("Payable").length).toBeGreaterThan(0);
    expect(within(drawer as HTMLElement).getByText("12")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("Acme Drywall")).toBeTruthy();
    expect(within(drawer as HTMLElement).queryByText("Bravo Plumbing")).toBeNull();
    expect(within(drawer as HTMLElement).queryByText("重分类类别")).toBeNull();
  });

  it("renders the 109 comparison by year and hides years without values", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-项目利润表对比" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "标签页-项目利润表对比" }));

    expect(screen.getByText("项目利润表年度对比")).toBeTruthy();
    expect(screen.getByText("收入 公司")).toBeTruthy();
    expect(screen.getByText("成本 审计")).toBeTruthy();
    expect(screen.getByText("毛利 差异")).toBeTruthy();
    expect(screen.getByText("2024")).toBeTruthy();
    expect(screen.queryByText("2025")).toBeNull();
  });

  it("renders the spec external recon sections and opens internal-company amount details", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-外部数据核对" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "标签页-外部数据核对" }));

    expect(screen.getByText("Unit/Common 个数")).toBeTruthy();
    expect(screen.getByText("Payable 内部公司矩阵")).toBeTruthy();
    expect(screen.getByText("Cost State 汇总合计")).toBeTruthy();
    expect(screen.getByText("原始 Amount 合计")).toBeTruthy();
    expect(screen.getByText("Common 个数")).toBeTruthy();
    expect(screen.queryByText(/North Common/)).toBeNull();
    expect(screen.getByText("WB Home LLC")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看内部公司 WB Home LLC Direct 金额明细" }));

    const drawerHeading = screen.getByRole("heading", { name: "金额明细" });
    const drawer = drawerHeading.closest("aside");

    expect(drawerHeading).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("WB Home LLC")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("100 Administration")).toBeTruthy();
    expect(within(drawer as HTMLElement).queryByText("重分类类别")).toBeNull();
  });

  it("renders external recon amounts without currency symbols and leaves zero matrix cells blank", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-外部数据核对" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "标签页-外部数据核对" }));

    expect(screen.getByRole("button", { name: "查看 Direct Payable 金额明细" }).textContent).toContain("1,700");
    expect(screen.queryByText("US$1,700")).toBeNull();

    const unassignedRow = screen.getAllByText("未分配").find((element) => element.tagName.toLowerCase() === "td")?.closest("tr");
    expect(unassignedRow).toBeTruthy();
    const cells = within(unassignedRow as HTMLElement).getAllByRole("cell");
    expect(cells[2].textContent).toBe("");
    expect(cells[3].textContent).toBe("");
  });

  it("renders draw-request discrepancy counts and opens the comparison detail drawer", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-外部数据核对" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "标签页-外部数据核对" }));

    expect(screen.getByText("差异条数")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看 未分配 差异条数明细" }));

    const drawerHeading = screen.getByRole("heading", { name: "金额明细" });
    const drawer = drawerHeading.closest("aside");

    expect(drawerHeading).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("Payable 判定")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("Final Detail 判定")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("Draw Request 判定")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("The Home Depot")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("Income")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("Direct")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("未分配")).toBeTruthy();
  });

  it("uses the cost-state matrix counts for the discrepancy total row", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-外部数据核对" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "标签页-外部数据核对" }));

    const totalRow = screen.getByText("Cost State 汇总合计").closest("tr");
    expect(totalRow).toBeTruthy();
    const cells = within(totalRow as HTMLElement).getAllByRole("cell");
    expect(cells.at(-1)?.textContent).toBe("1");
  });

  it("renders reclass table-internal before-after transitions without payable-vs-final-detail diffs", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-成本重分类" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "标签页-成本重分类" }));

    expect(screen.getByText("Payable 表内重分类对比")).toBeTruthy();
    expect(screen.getByText("Final Detail 表内重分类对比")).toBeTruthy();
    expect(screen.getAllByText("Direct → ROE").length).toBeGreaterThan(0);
    expect(screen.queryByText("Rule_ID 对比")).toBeNull();
    expect(screen.queryByText("差异金额")).toBeNull();
    expect(screen.queryByText("差异数量")).toBeNull();

    expect(screen.getByRole("button", { name: "查看 Payable Direct 到 ROE 金额明细" }).textContent).toContain("300");
    expect(screen.queryByText("US$300")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 Payable Direct 到 ROE 金额明细" }));

    const drawerHeading = screen.getByRole("heading", { name: "金额明细" });
    const drawer = drawerHeading.closest("aside");

    expect(drawerHeading).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("重分类类别")).toBeTruthy();
    expect(within(drawer as HTMLElement).getAllByText("WB Home LLC").length).toBeGreaterThan(0);
    expect(within(drawer as HTMLElement).getAllByText("ROE").length).toBeGreaterThan(0);
  });

  it("renders table-separated internal-company reclass transitions and opens a company amount detail", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "标签页-成本重分类" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "标签页-成本重分类" }));

    expect(screen.getByText("Payable 表内重分类对比")).toBeTruthy();
    expect(screen.getByText("Final Detail 表内重分类对比")).toBeTruthy();
    expect(screen.getAllByText("WB Home LLC").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "查看内部公司 WB Home LLC Payable Direct 到 ROE 金额明细" }));

    const drawerHeading = screen.getByRole("heading", { name: "金额明细" });
    const drawer = drawerHeading.closest("aside");

    expect(drawerHeading).toBeTruthy();
    expect(drawer).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("100 Administration")).toBeTruthy();
    expect(within(drawer as HTMLElement).getByText("ROE")).toBeTruthy();
  });

  it("opens the logs drawer and shows both flow logs and edit logs", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "项目日志" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "项目日志" }));

    expect(screen.getByText("流程操作")).toBeTruthy();
    expect(screen.getByText("表格修改")).toBeTruthy();
    expect(screen.getByText("validate_input")).toBeTruthy();
    expect(screen.getByText("Payable")).toBeTruthy();
  });

  it("places snapshot and lock icons before logs and opens their detail drawers", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123", sheet_109_title: "109" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/audit_snapshots")) {
        return jsonResponse({
          project_id: "p1",
          spreadsheet_id: "sheet-123",
          items: [],
        });
      }
      if (url.startsWith("/api/live_sheet_status")) {
        return jsonResponse({
          spreadsheet_id: "sheet-123",
          verified_at: "2026-04-23T06:20:00.000Z",
          checks: {
            managed_sheets: ["109"],
            formula_lock_ranges_109: ["109!E12:E20"],
          },
          protections: [
            {
              title: "109",
              description: "AiWB managed formula lock",
              protected_range: "109!E12:E20",
              unprotected_ranges: [],
            },
          ],
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "快照历史" })).toBeTruthy());
    const snapshotButton = screen.getByRole("button", { name: "快照历史" });
    const lockButton = screen.getByRole("button", { name: "物理锁定区域" });
    const logButton = screen.getByRole("button", { name: "项目日志" });

    expect(snapshotButton.compareDocumentPosition(lockButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lockButton.compareDocumentPosition(logButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(snapshotButton);
    expect(screen.getByRole("heading", { name: "快照历史详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭详情" }));

    fireEvent.click(lockButton);
    expect(screen.getByRole("heading", { name: "物理锁定区域详情" })).toBeTruthy();
  });

  it("shows a stale snapshot warning when source edits are newer than the current snapshot", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123", sheet_109_title: "109" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse({
          ...baseDashboardPayload(),
          from_snapshot: true,
          snapshot_at: "2026-04-26T10:00:00.000Z",
          source_last_edit_at: "2026-04-26T10:05:00.000Z",
        });
      }
      if (url.startsWith("/api/audit_snapshots")) {
        return jsonResponse({
          project_id: "p1",
          spreadsheet_id: "sheet-123",
          items: [],
        });
      }
      if (url.startsWith("/api/live_sheet_status")) {
        return jsonResponse({
          spreadsheet_id: "sheet-123",
          verified_at: "2026-04-23T06:20:00.000Z",
          checks: {
            managed_sheets: ["109"],
            formula_lock_ranges_109: [],
          },
          protections: [],
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByText("快照过期")).toBeTruthy());
    expect(screen.getAllByText(/源文件更新时间/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/快照时间/).length).toBeGreaterThan(0);
  });

  it("opens the global reclassification rules drawer from the top nav without project hit metrics", async () => {
    const dashboard = baseDashboardPayload();
    (
      dashboard.audit_tabs.reclass_audit.rule_rows as Array<{
        rule_id: string;
        category: string;
        old_cost_states: string[];
        amount: number;
        diff_amount: number;
        invoice_count: number;
      }>
    ).push({
      rule_id: "R105",
      category: "GC",
      old_cost_states: ["GMP"],
      amount: 1200,
      diff_amount: 300,
      invoice_count: 4,
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(dashboard);
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "重分类规则" })).toBeTruthy());
    const title = screen.getByText("审计工作台");
    const rulesButton = screen.getByRole("button", { name: "重分类规则" });
    const operatorGuideLink = screen.getByRole("link", { name: "财务人员操作说明" });
    const addButton = screen.getByRole("button", { name: "添加新项目" });

    expect(title.compareDocumentPosition(rulesButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rulesButton.compareDocumentPosition(operatorGuideLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(operatorGuideLink.compareDocumentPosition(addButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(operatorGuideLink.getAttribute("href")).toBe("/operator-guide");
    expect(operatorGuideLink.getAttribute("target")).toBe("_blank");

    fireEvent.click(rulesButton);

    expect(screen.getByRole("heading", { name: "重分类规则" })).toBeTruthy();
    expect(screen.getByText("R105")).toBeTruthy();
    expect(screen.getByText("规则库 16 条")).toBeTruthy();
    expect(screen.queryByText("当前项目命中")).toBeNull();
    expect(screen.queryByText("金额 US$1,200")).toBeNull();
    expect(screen.queryByText("差异 US$300")).toBeNull();
    expect(screen.queryByText("发票 4")).toBeNull();
    expect(screen.getByText("R000")).toBeTruthy();
    expect(screen.getByText("Type 为 Sharing 的记录（仅限 Final Detail）排除在成本重分类之外")).toBeTruthy();
  });

  it("shows a cleaner project header with a single stage label and the log button before the title", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "WBWT Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse({ ...baseDashboardPayload(), project_name: "WBWT Sandy Cove" });
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "WBWT Sandy Cove" })).toBeTruthy());
    const heading = screen.getByRole("heading", { name: "WBWT Sandy Cove" });
    const logButton = screen.getByRole("button", { name: "项目日志" });

    expect(screen.queryByText(/^项目$/)).toBeNull();
    expect(screen.queryByText("项目 / 阶段")).toBeNull();
    expect(screen.getAllByText("人工录入数据已完善")).toHaveLength(1);
    expect(logButton.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not show unlock action for non-owner locked state", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "locked_109_approved",
            locked: true,
            is_owner_or_admin: false,
            can_write: true,
            drive_role: "writer",
            is_drive_owner: false,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "同步数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "验证录入数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "成本重分类" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交审计确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "解除锁定数据" })).toBeNull();
  });

  it("shows unlock action for Drive owner locked state", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(
          baseProjectStatePayload({
            current_stage: "locked_109_approved",
            locked: true,
            is_owner_or_admin: false,
            can_write: true,
            drive_role: "owner",
            is_drive_owner: true,
          }),
        );
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "解除锁定数据" })).toBeTruthy());
  });

  it("fails closed when project state is still loading", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return new Promise<Response>(() => {
          return;
        });
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "同步数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "验证录入数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "成本重分类" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交审计确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "解除锁定数据" })).toBeNull();
  });

  it("fails closed when project state API returns an error", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse({ error: "state api failed" }, false);
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "同步数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "验证录入数据" })).toBeNull();
    expect(screen.queryByRole("button", { name: "成本重分类" })).toBeNull();
    expect(screen.queryByRole("button", { name: "提交审计确认" })).toBeNull();
    expect(screen.queryByRole("button", { name: "解除锁定数据" })).toBeNull();
  });

  it("starts audit sync and surfaces stale polling status when clicking 同步数据", async () => {
    let stateCalls = 0;
    let dashboardCalls = 0;
    let auditSyncCalls = 0;
    let auditSyncStatusCalls = 0;
    let auditSyncBody: unknown = null;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        stateCalls += 1;
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        dashboardCalls += 1;
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/audit_sync_status")) {
        auditSyncStatusCalls += 1;
        return jsonResponse({
          status: "stale",
          run: {
            id: "run-123",
            sync_run_id: "run-123",
            status: "stale",
            started_at: "2026-04-27T12:00:00.000Z",
          },
          latest_run: {
            sync_run_id: "run-123",
            status: "stale",
            started_at: "2026-04-27T12:00:00.000Z",
          },
        });
      }
      if (url.startsWith("/api/audit_sync")) {
        auditSyncCalls += 1;
        auditSyncBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse({
          status: "accepted",
          mode: "async",
          spreadsheet_id: "sheet-123",
          sync_run_id: "run-123",
          message: "同步已开始，后台完成后会刷新快照",
        });
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "同步数据" })).toBeTruthy());
    expect(screen.getByText("同步会先检查工作表结构，再校验并刷新审计快照。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "同步数据" }));

    await waitFor(() => expect(stateCalls).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(dashboardCalls).toBeGreaterThanOrEqual(2));
    expect(auditSyncCalls).toBe(1);
    expect(auditSyncStatusCalls).toBeGreaterThanOrEqual(1);
    expect(auditSyncBody).toEqual({ spreadsheet_id: "sheet-123" });
    expect(await screen.findByText("同步任务可能已超时，请稍后重试或联系管理员清理运行锁。")).toBeTruthy();
  });

  it("drops stale responses from previous spreadsheetId", async () => {
    const staleStateResponse = createDeferred<Response>();
    const staleDashboardResponse = createDeferred<Response>();

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state?spreadsheet_id=sheet-123")) {
        return staleStateResponse.promise;
      }
      if (url.startsWith("/api/audit_summary?spreadsheet_id=sheet-123")) {
        return staleDashboardResponse.promise;
      }
      if (url.startsWith("/api/projects/state?spreadsheet_id=sheet-456")) {
        return jsonResponse(baseProjectStatePayload({ current_stage: "manual_input_ready" }));
      }
      if (url.startsWith("/api/audit_summary?spreadsheet_id=sheet-456")) {
        return jsonResponse({ ...baseDashboardPayload(), project_name: "New Project" });
      }
      return jsonResponse({});
    }) as typeof fetch;

    const view = render(<Home defaultSpreadsheetId="configured-sheet-id" />);
    await waitFor(() => expect(screen.getByRole("link", { name: "当前项目 Google Sheet" })).toBeTruthy());

    routerState.query = { spreadsheetId: "sheet-456" };
    routerState.asPath = "/?spreadsheetId=sheet-456";
    view.rerender(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByText("New Project")).toBeTruthy());

    staleStateResponse.resolve(jsonResponse(baseProjectStatePayload()));
    staleDashboardResponse.resolve(jsonResponse({ ...baseDashboardPayload(), project_name: "Old Project" }));

    await waitFor(() => expect(screen.getByText("New Project")).toBeTruthy());
    expect(screen.queryByText("Old Project")).toBeNull();
  });

  it("disables concurrent actions while another action is pending", async () => {
    const actionResponse = createDeferred<Response>();
    const reclassifyResponse = createDeferred<Response>();

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/projects/list")) {
        return jsonResponse({
          mode: "direct",
          projects: [{ id: "p1", name: "Sandy Cove", spreadsheet_id: "sheet-123" }],
        });
      }
      if (url.startsWith("/api/projects/state")) {
        return jsonResponse(baseProjectStatePayload());
      }
      if (url.startsWith("/api/audit_summary")) {
        return jsonResponse(baseDashboardPayload());
      }
      if (url.startsWith("/api/projects/action")) {
        return actionResponse.promise;
      }
      if (url.startsWith("/api/reclassify")) {
        return reclassifyResponse.promise;
      }
      return jsonResponse({});
    }) as typeof fetch;

    render(<Home defaultSpreadsheetId="configured-sheet-id" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "验证录入数据" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "验证录入数据" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "验证中" })).toHaveProperty("disabled", true));
    expect(screen.getByRole("button", { name: "同步数据" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "成本重分类" })).toHaveProperty("disabled", true);

    actionResponse.resolve(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "验证录入数据" })).toHaveProperty("disabled", false));

    fireEvent.click(screen.getByRole("button", { name: "成本重分类" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "验证录入数据" })).toHaveProperty("disabled", true));
    expect(screen.getByRole("button", { name: "提交审计确认" })).toHaveProperty("disabled", true);

    await act(async () => {
      reclassifyResponse.resolve(jsonResponse({ triggered_at: "2026-04-23T06:00:00.000Z", message: "ok" }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "验证录入数据" })).toHaveProperty("disabled", false));
  });
});
