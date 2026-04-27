describe("audit dashboard helpers", () => {
  it("normalizes spreadsheet ids against the built-in fallback", async () => {
    const { DEFAULT_SPREADSHEET_ID, normalizeSpreadsheetId } = await import("@/lib/audit-dashboard");

    expect(normalizeSpreadsheetId(undefined)).toBe(DEFAULT_SPREADSHEET_ID);
    expect(normalizeSpreadsheetId("MOCK_ID")).toBe(DEFAULT_SPREADSHEET_ID);
    expect(normalizeSpreadsheetId("configured-sheet-id")).toBe("configured-sheet-id");
  });

  it("builds KPI cards from the 109 sheet snapshot", () => {
    const { buildHighlights } = require("@/lib/audit-dashboard");
    const rows109 = Array.from({ length: 20 }, () => Array.from({ length: 12 }, () => ""));
    rows109[2][6] = "-13,719,597.12"; // G3
    rows109[3][6] = "12,414,415.71"; // G4
    rows109[4][6] = "-1,305,181.41"; // G5
    rows109[12][4] = "99.94%"; // E13

    expect(
      buildHighlights(rows109),
    ).toEqual([
      { label: "Revenue", value: "-13,719,597.12", color: "blue" },
      { label: "Actual Cost", value: "12,414,415.71", color: "indigo" },
      { label: "Gross Margin", value: "-1,305,181.41", color: "emerald" },
      { label: "POC (%)", value: "99.94%", color: "purple" },
    ]);
  });

  it("builds the compare-109 snapshot from paired company and audit rows", () => {
    const { build109CompareSnapshot } = require("@/lib/audit-dashboard");
    const rows109: Array<Array<string | number>> = Array.from({ length: 60 }, () =>
      Array.from({ length: 20 }, () => ""),
    );
    rows109[9][5] = "2024";
    rows109[9][6] = "2025";
    rows109[9][7] = "2026";
    rows109[9][12] = "2024";
    rows109[9][13] = "2025";
    rows109[9][14] = "2026";
    rows109[16][3] = "General Conditions fee-Company";
    rows109[17][3] = "General Conditions fee-Audited";
    rows109[27][3] = "Cost of Goods Sold-Company";
    rows109[28][3] = "Cost of Goods Sold-Audited";
    rows109[50][3] = "Gross Profit-Company";
    rows109[51][3] = "Gross Profit-Audit";
    rows109[16][5] = 100;
    rows109[17][12] = 90;
    rows109[50][5] = -40;
    rows109[51][12] = -30;

    expect(
      build109CompareSnapshot(rows109),
    ).toEqual(
      expect.objectContaining({
        warnings: [],
        metric_rows: expect.arrayContaining([
          expect.objectContaining({
            label: "收入",
            year_rows: expect.arrayContaining([
              expect.objectContaining({
                year_offset: 0,
                year_label: "2024",
                company: 100,
                audit: 90,
                diff: 10,
                has_value: true,
              }),
            ]),
          }),
          expect.objectContaining({ label: "成本" }),
          expect.objectContaining({
            label: "毛利",
            year_rows: expect.arrayContaining([
              expect.objectContaining({ company: -40, audit: -30, diff: -10, has_value: true }),
            ]),
          }),
        ]),
      }),
    );
  });

  it("reads scoping logic statuses by headers including Final GMP", () => {
    const { buildAuditSnapshot } = require("@/lib/audit-dashboard");
    const snapshot = buildAuditSnapshot({
      projectName: "Sandy Cove",
      kpiRows: [],
      payableRows: [],
      finalDetailRows: [],
      drawRequestRows: [],
      unitBudgetRows: [],
      unitMasterRows: [],
      scopingRows: [
        ["", "", "Group Number", "Group Name", "GMP", "Final GMP", "Fee", "WIP", "WTC", "GC", "TBD", "Warranty Months", "Warranty Due Date", "Budget amount", "Incurred amount"],
        ["", "", "301", "Group 301", "1", "", "2", "", "", "5", "", "12", "07/12/2027", "1000", "100"],
      ],
      rows109: [],
      internalCompanies: [],
    });

    expect(snapshot.audit_tabs.scoping_logic).toEqual([
      expect.objectContaining({
        group_number: "301",
        group_name: "Group 301",
        statuses: {
          gmp: "1",
          final_gmp: "",
          fee: "2",
          wip: "",
          wtc: "",
          gc: "5",
          tbd: "",
        },
        budget: 1000,
        incurred_amount: 100,
      }),
    ]);
  });

  it("passes mapping health metrics into compare-109 snapshot", () => {
    const { build109CompareSnapshot } = require("@/lib/audit-dashboard");
    const rows109 = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => ""));
    rows109[9][5] = "2024";
    rows109[9][6] = "2025";
    rows109[9][12] = "2024";
    rows109[9][13] = "2025";

    const snapshot = build109CompareSnapshot(rows109, {
      mapping_score: 0.94,
      fallback_count: 2,
      fallback_fields: ["Payable.vendor", "Draw request report.unit_code"],
      mapping_field_count: 12,
    });

    expect(snapshot.mapping_health).toEqual({
      mapping_score: 0.94,
      fallback_count: 2,
      fallback_fields: ["Payable.vendor", "Draw request report.unit_code"],
      mapping_field_count: 12,
    });
  });

  it("keeps compare-109 aligned when year columns are shifted to J", () => {
    const { build109CompareSnapshot } = require("@/lib/audit-dashboard");
    const rows109: Array<Array<string | number>> = Array.from({ length: 70 }, () =>
      Array.from({ length: 30 }, () => ""),
    );

    // 年份列从 J(K...) 开始，模拟左侧插入备注列
    rows109[12][9] = "2024";
    rows109[12][10] = "2025";
    rows109[12][11] = "2026";
    rows109[12][16] = "2024";
    rows109[12][17] = "2025";
    rows109[12][18] = "2026";

    rows109[16][3] = "General Conditions fee-Company";
    rows109[17][3] = "General Conditions fee-Audited";
    rows109[16][9] = 1000;
    rows109[16][10] = 1100;
    rows109[16][11] = 1200;
    rows109[17][16] = 950;
    rows109[17][17] = 1080;
    rows109[17][18] = 1210;

    const snapshot = build109CompareSnapshot(rows109);
    const revenueRow = snapshot.metric_rows.find((row: { label: string }) => row.label === "收入");

    expect(snapshot.warnings).toEqual([]);
    expect(revenueRow?.year_rows).toEqual([
      {
        year_offset: 0,
        year_label: "2024",
        company: 1000,
        audit: 950,
        diff: 50,
        has_value: true,
      },
      {
        year_offset: 1,
        year_label: "2025",
        company: 1100,
        audit: 1080,
        diff: 20,
        has_value: true,
      },
      {
        year_offset: 2,
        year_label: "2026",
        company: 1200,
        audit: 1210,
        diff: -10,
        has_value: true,
      },
    ]);
  });

  it("returns MAPPING_AMBIGUITY warning when duplicate year headers exist", () => {
    const { build109CompareSnapshot } = require("@/lib/audit-dashboard");
    const rows109 = Array.from({ length: 60 }, () => Array.from({ length: 30 }, () => ""));
    rows109[9][5] = "2026";
    rows109[9][6] = "2026";
    rows109[9][7] = "2027";
    rows109[9][12] = "2026";
    rows109[9][13] = "2027";
    rows109[9][14] = "2028";

    const snapshot = build109CompareSnapshot(rows109);
    expect(snapshot.warnings.some((warning: { code: string }) => warning.code === "MAPPING_AMBIGUITY")).toBe(true);
  });

  it("builds the dashboard snapshot envelope used by the Next.js frontend", () => {
    const { buildAuditSnapshot } = require("@/lib/audit-dashboard");
    expect(
      buildAuditSnapshot({
        projectName: "Sandy Cove",
        kpiRows: [["Project"], ["", "$100", "$40", "$60", "", "", "", "", "", "60%"]],
        payableRows: [["amount", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "state"]],
        finalDetailRows: [["state", "", "", "amount"]],
      }),
    ).toEqual(
      expect.objectContaining({
        project_name: "Sandy Cove",
        highlights: expect.any(Array),
        audit_tabs: expect.objectContaining({
          external_recon: expect.objectContaining({
            summary: "已同步",
            discrepancies: expect.any(Array),
          }),
          manual_input: expect.objectContaining({
            profit_statement_entries: expect.any(Array),
            validation_errors: expect.any(Array),
            scoping_groups: expect.any(Array),
            unit_master_dates: expect.any(Array),
          }),
          reclass_audit: expect.objectContaining({
            sankey: expect.objectContaining({
              nodes: expect.any(Array),
              links: expect.any(Array),
            }),
          }),
          compare_109: expect.objectContaining({
            metric_rows: expect.any(Array),
          }),
        }),
      }),
    );
  });

  it("builds reclass table summaries as per-table before-after cost state analysis", () => {
    const { buildAuditSnapshot } = require("@/lib/audit-dashboard");
    const payableRow = Array.from({ length: 45 }, () => "");
    payableRow[0] = "ROE";
    payableRow[1] = "R105";
    payableRow[14] = "WB Home LLC";
    payableRow[20] = "300";
    payableRow[21] = "2025-01-05";
    payableRow[37] = "B-201";
    payableRow[38] = "1SF100";
    payableRow[39] = "100 Administration";
    payableRow[42] = "Direct";

    const finalDetailRow = Array.from({ length: 32 }, () => "");
    finalDetailRow[0] = "ROE";
    finalDetailRow[1] = "R105";
    finalDetailRow[19] = "2025-01-05";
    finalDetailRow[20] = "B-201";
    finalDetailRow[24] = "Direct";
    finalDetailRow[25] = "1SF100";
    finalDetailRow[27] = "125";
    finalDetailRow[29] = "WB Home LLC";

    const snapshot = buildAuditSnapshot({
      projectName: "Sandy Cove",
      kpiRows: [],
      payableRows: [["Category", "Rule_ID", "Vendor", "Amount", "Cost State"], payableRow],
      finalDetailRows: [["Category", "Rule_ID", "Final Date", "Incurred Date", "Cost State", "Amount"], finalDetailRow],
      internalCompanies: [{ company_name: "WB Home LLC", normalized_name: "wb home llc" }],
    });

    expect(snapshot.audit_tabs.reclass_audit.table_summaries).toEqual([
      expect.objectContaining({
        source_table: "Payable",
        total_amount: 300,
        total_count: 1,
        changed_amount: 300,
        changed_count: 1,
        transition_rows: [
          expect.objectContaining({
            old_cost_state: "Direct",
            new_cost_state: "ROE",
            amount: 300,
            count: 1,
          }),
        ],
        internal_company_transition_rows: [
          expect.objectContaining({
            company_name: "WB Home LLC",
            old_cost_state: "Direct",
            new_cost_state: "ROE",
            amount: 300,
            count: 1,
          }),
        ],
      }),
      expect.objectContaining({
        source_table: "Final Detail",
        total_amount: 125,
        total_count: 1,
        changed_amount: 125,
        changed_count: 1,
        transition_rows: [
          expect.objectContaining({
            old_cost_state: "Direct",
            new_cost_state: "ROE",
            amount: 125,
            count: 1,
          }),
        ],
      }),
    ]);
  });

  it("does not use Payable posting date as old cost state when Cost State is blank", () => {
    const { buildAuditSnapshot } = require("@/lib/audit-dashboard");
    const payableRow = Array.from({ length: 48 }, () => "");
    payableRow[0] = "ROE";
    payableRow[20] = "500";
    payableRow[43] = "2025-01-31";

    const snapshot = buildAuditSnapshot({
      projectName: "Sandy Cove",
      kpiRows: [],
      payableRows: [["Category", "Rule_ID", "Vendor", "Amount", "Cost State"], payableRow],
      finalDetailRows: [],
    });

    const payableSummary = snapshot.audit_tabs.reclass_audit.table_summaries.find(
      (summary: { source_table: string }) => summary.source_table === "Payable",
    );
    expect(payableSummary?.before_rows).toEqual([
      expect.objectContaining({ cost_state: "未分配", amount: 500, count: 1 }),
    ]);
    expect(payableSummary?.transition_rows).toEqual([
      expect.objectContaining({ old_cost_state: "未分配", new_cost_state: "ROE", amount: 500, count: 1 }),
    ]);
  });
});
