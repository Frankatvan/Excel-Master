/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import Home from "@/pages/index";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "test@example.com" } } }),
  signIn: jest.fn(),
  signOut: jest.fn(),
}));

const replaceMock = jest.fn();

jest.mock("next/router", () => ({
  useRouter: () => ({
    query: { spreadsheetId: "sheet-123" },
    replace: replaceMock,
    asPath: "/?spreadsheetId=sheet-123",
  }),
}));

describe("phase 1 workbench page", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project_name: "Sandy Cove",
        workflow_stage: "成本重分类",
        highlights: [],
        audit_tabs: {
          external_recon: {
            summary: "Payable / Final Detail / Draw request report 已完成首轮核对",
            discrepancies: [{ state: "Direct", payable: 140000, final: 120000, diff: 20000 }],
            recon_by_cost_state: [],
            unit_budget_variances: [{ unit_code: "A-101", total_budget: 85000, wip_budget: 80000, diff: 5000 }],
            invoice_match_overview: {
              payable_total_invoices: 4,
              final_total_invoices: 3,
              draw_total_invoices: 2,
              matched_to_final: 2,
              matched_to_draw: 1,
              matched_to_both: 1,
              payable_unmatched: 1,
              final_only: 1,
              draw_only: 1,
            },
          },
          reclass_audit: {
            overview: { old_total: 420000, new_total: 415000, diff_amount: 5000, diff_invoice_count: 3 },
            category_rows: [
              { category: "ROE", old_total: 90000, new_total: 110000, diff_amount: 20000, diff_invoice_count: 2 },
            ],
            rule_rows: [
              {
                rule_id: "R107",
                category: "ROE",
                old_cost_states: ["Direct"],
                amount: 110000,
                diff_amount: 20000,
                invoice_count: 2,
              },
            ],
            invoice_rows: [
              {
                vendor: "Vendor A",
                amount: 120000,
                incurred_date: "2025-01-02",
                unit_code: "U1",
                cost_code: "1SF100",
                old_cost_state: "Direct",
                new_category: "ROE",
                rule_id: "R105",
              },
              {
                vendor: "Vendor C",
                amount: 300,
                incurred_date: "2025-01-03",
                unit_code: "U3",
                cost_code: "1SF700",
                old_cost_state: "Direct",
                new_category: "GC",
                rule_id: "R107",
              },
            ],
            sankey: { nodes: [], links: [] },
          },
          compare_109: {
            metric_rows: [
              {
                label: "Gross Profit",
                year_rows: [{ year_offset: 0, company: 300000, audit: 280000, diff: 20000 }],
              },
            ],
          },
          scoping_logic: [
            {
              group_number: "301",
              group_name: "Core Build",
              statuses: ["GMP", "WIP"],
              budget: 85000,
              incurred_amount: 79000,
            },
          ],
        },
      }),
    }) as typeof fetch;
  });

  it("renders the refined phase1 workbench overview and audit summaries", async () => {
    render(<Home />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("/api/audit_summary?spreadsheet_id=sheet-123"),
    );
    await waitFor(() => expect(screen.getAllByText("Sandy Cove").length).toBeGreaterThan(0));

    expect(screen.getByRole("button", { name: /成本重分类/ })).toBeTruthy();
    expect(screen.getAllByText("109 Compare").length).toBeGreaterThan(0);
    expect(screen.getAllByText("External Recon").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Audit Command Deck").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Review 3 reclassified invoices").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Payable / Final Detail / Draw request report 已完成首轮核对").length).toBeGreaterThan(0);
    expect(screen.getByText("Open year breakdown")).toBeTruthy();
  });

  it("switches tabs and reveals the detailed audit sections", async () => {
    render(<Home />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith("/api/audit_summary?spreadsheet_id=sheet-123"),
    );
    await waitFor(() => expect(screen.getAllByText("Sandy Cove").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "External Recon" })[0]);
    expect(screen.getByText("Unit Budget Variance")).toBeTruthy();
    expect(screen.getByText("Invoice Match Overview")).toBeTruthy();
    expect(screen.getByText("Matched to both")).toBeTruthy();
    expect(screen.getByText("Payable unmatched")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Reclass Audit" })[0]);
    expect(screen.getByText("Rule Drilldown")).toBeTruthy();
    expect(screen.getByText("Invoice-level reclassification rows")).toBeTruthy();
    expect(screen.getByText("Vendor C")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "109 Compare" })[0]);
    expect(screen.getByText("Gross Profit")).toBeTruthy();
  });
});
