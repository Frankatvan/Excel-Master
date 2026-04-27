import { buildAuditSnapshot } from "@/lib/audit-dashboard";

describe("audit dashboard phase 1 contract", () => {
  it("includes manual input and the new external recon snapshot fields", () => {
    const snapshot = buildAuditSnapshot({
      projectName: "Sandy Cove",
      kpiRows: [],
      payableRows: [["ROE", "R105", "", "", "", "", "", "", "", "", "", "", "", "", "WB Home LLC", "", "", "", "", "", 300, "2025-01-05", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "B-201", "1SF100", "Administration", "", "", "Direct"]],
      finalDetailRows: [["ROE", "R105", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "2025-01-05", "B-201", "Administration", "", "", "Direct", "1SF100", "", 125, "", "WB Home LLC"]],
      drawRequestRows: [],
      unitBudgetRows: [["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "U1", "U2", ""]],
      unitMasterRows: [
        ["Unit Code", "Total Budget", "C/O date", "Final Date", "Actual Settlement Date", "TBD Acceptance Date"],
        ["U1", "1000", "01/01/2025", "01/05/2025", "01/10/2025", "01/20/2025"],
      ],
      scopingRows: [],
      rows109: [],
      internalCompanies: [{ company_name: "WB Home LLC", normalized_name: "wb home llc" }],
    });

    expect(snapshot.audit_tabs.manual_input).toEqual(
      expect.objectContaining({
        profit_statement_entries: expect.any(Array),
        validation_errors: expect.any(Array),
        scoping_groups: expect.any(Array),
        unit_master_dates: expect.any(Array),
      }),
    );
    expect(snapshot.audit_tabs.external_recon).toEqual(
      expect.objectContaining({
        unit_common_counts: expect.any(Array),
        cost_state_matrix: expect.any(Array),
        cost_state_totals: expect.any(Object),
        internal_company_cost_state_matrix: expect.any(Array),
        detail_rows: expect.any(Array),
      }),
    );
    expect(snapshot.audit_tabs.external_recon.unit_common_counts[0]).toEqual(
      expect.objectContaining({
        table_name: "Unit Budget",
        unit_count: 2,
        common_count: 0,
      }),
    );
    expect(snapshot.audit_tabs.external_recon.unit_budget_variances).toEqual([]);
    expect(snapshot.audit_tabs.external_recon.cost_state_totals).toEqual(
      expect.objectContaining({
        payable: expect.objectContaining({
          grouped_total: 300,
          raw_total: 300,
          mismatch: false,
        }),
      }),
    );
    expect(snapshot.audit_tabs.reclass_audit).toEqual(
      expect.objectContaining({
        overview: expect.objectContaining({
          payable_amount: 300,
          final_detail_amount: 125,
          diff_amount: 425,
          diff_invoice_count: 2,
        }),
        category_rows: expect.arrayContaining([
          expect.objectContaining({
            category: "ROE",
            payable_amount: 300,
            payable_count: 1,
            final_detail_amount: 125,
            final_detail_count: 1,
            diff_amount: 175,
            diff_count: 0,
          }),
        ]),
        internal_company_category_matrix: expect.arrayContaining([
          expect.objectContaining({
            company_name: "WB Home LLC",
            category: "ROE",
            payable_amount: 300,
            final_detail_amount: 125,
            diff_amount: 175,
          }),
        ]),
        invoice_rows: expect.arrayContaining([
          expect.objectContaining({
            source_table: "Payable",
            cost_name: "Administration",
            new_category: "ROE",
          }),
          expect.objectContaining({
            source_table: "Final Detail",
            cost_name: "",
            new_category: "ROE",
          }),
        ]),
      }),
    );
  });
});
