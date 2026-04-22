import {
  buildAuditSnapshot,
  buildHighlights,
  buildReconDiscrepancies,
  DEFAULT_SPREADSHEET_ID,
} from "@/lib/audit-dashboard";

describe("audit dashboard helpers", () => {
  it("uses the agreed fallback spreadsheet id", () => {
    expect(DEFAULT_SPREADSHEET_ID).toBe("1N6iQ3-7H-I_p0p_Pq_G9U8U5k5l-Mv1mKz_N7D_8_8");
  });

  it("builds KPI cards from the 109 sheet snapshot", () => {
    expect(
      buildHighlights([
        ["Project"],
        ["", "$100", "$40", "$60", "", "", "", "", "", "60%"],
      ]),
    ).toEqual([
      { label: "Revenue", value: "$100", color: "blue" },
      { label: "Actual Cost", value: "$40", color: "indigo" },
      { label: "Gross Margin", value: "$60", color: "emerald" },
      { label: "POC (%)", value: "60%", color: "purple" },
    ]);
  });

  it("aggregates payable and final detail totals by recon state", () => {
    expect(
      buildReconDiscrepancies(
        [
          ["amount", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "state"],
          [100, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Direct"],
          [50, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "ROE"],
        ],
        [
          ["state", "", "", "amount"],
          ["Direct", "", "", 90],
          ["ROE", "", "", 80],
        ],
      ),
    ).toEqual([
      { state: "Direct", payable: 100, final: 90, diff: 10 },
      { state: "ROE", payable: 50, final: 80, diff: -30 },
      { state: "Income", payable: 0, final: 0, diff: 0 },
      { state: "Consulting", payable: 0, final: 0, diff: 0 },
    ]);
  });

  it("builds the dashboard snapshot envelope used by the Next.js frontend", () => {
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
            summary: "Live Sync Successful",
            discrepancies: expect.any(Array),
          }),
          reclass_audit: expect.objectContaining({
            sankey: expect.objectContaining({
              nodes: expect.any(Array),
              links: expect.any(Array),
            }),
          }),
        }),
      }),
    );
  });
});
