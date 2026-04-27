import * as XLSX from "xlsx";

import { parseWorkbookBuffer } from "@/lib/external-import/workbook-parser";

function workbookBuffer(sheets: Array<{ name: string; rows: unknown[][] }>): Buffer {
  const workbook = XLSX.utils.book_new();

  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
  });

  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
}

describe("external import workbook parser", () => {
  it("detects a payable sheet and maps it to the payable raw zone", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [
            ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
            ["g-1", "Apex", "INV-1", "$1,200.50", "CA"],
          ],
        },
      ]),
      "payables.xlsx",
    );

    expect(preview.tables).toHaveLength(1);
    expect(preview.tables[0]).toMatchObject({
      sourceRole: "payable",
      sourceSheetName: "Payable",
      rowCount: 1,
      columnCount: 5,
      amountTotal: 1200.5,
      targetZoneKey: "external_import.payable_raw",
      headers: ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
      blockingIssues: [],
    });
  });

  it("scans past report title rows to find semantic headers", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Draw request report",
          rows: [
            ["Draw Request Export"],
            ["Generated", "2026-04-27"],
            ["Unit Code", "Cost Code", "Vendor", "Amount"],
            ["101", "03-100", "Apex", "$1,250"],
          ],
        },
      ]),
      "draw-request-preamble.xlsx",
    );

    expect(preview.tables[0]).toMatchObject({
      sourceRole: "draw_request",
      rowCount: 1,
      amountTotal: 1250,
      blockingIssues: [],
      headers: ["Unit Code", "Cost Code", "Vendor", "Amount"],
    });
  });

  it("detects a final detail sheet and maps it to the final detail raw zone", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Final Detail",
          rows: [
            ["RowId", "Final Amount", "Posting Date 1", "Unit Code", "Cost Code", "Vendor"],
            ["r-1", "50", "2026-04-01", "101", "03-100", "Apex"],
          ],
        },
      ]),
      "final-detail.xlsx",
    );

    expect(preview.tables[0]).toMatchObject({
      sourceRole: "final_detail",
      sourceSheetName: "Final Detail",
      rowCount: 1,
      columnCount: 6,
      amountTotal: 50,
      targetZoneKey: "external_import.final_detail_raw",
      blockingIssues: [],
    });
  });

  it("detects a unit budget horizontal matrix and maps it to the unit budget raw zone", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Unit Budget",
          rows: [
            ["Unit Code", "Cost Code", "Foundation", "Framing", "Plumbing"],
            ["101", "03-100", 1000, "$2,000", ""],
            ["102", "03-100", "", 3000, 4000],
          ],
        },
      ]),
      "unit-budget.xlsx",
    );

    expect(preview.tables[0]).toMatchObject({
      sourceRole: "unit_budget",
      sourceSheetName: "Unit Budget",
      rowCount: 2,
      columnCount: 5,
      amountTotal: 10000,
      targetZoneKey: "external_import.unit_budget_raw",
      blockingIssues: [],
    });
  });

  it("imports only the exact Draw request report sheet from a draw request workbook", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        { name: "Total", rows: [["Total"], [123]] },
        { name: "Address list", rows: [["Address"], ["1 Main"]] },
        {
          name: "Draw request report",
          rows: [
            ["Unit Code", "Cost Code", "Vendor", "Amount"],
            ["101", "03-100", "Apex", "$1,250"],
          ],
        },
        { name: "Unit 101", rows: [["Amount"], [999]] },
      ]),
      "draw-request.xlsx",
    );

    expect(preview.tables).toHaveLength(1);
    expect(preview.tables[0]).toMatchObject({
      sourceRole: "draw_request",
      sourceSheetName: "Draw request report",
      amountTotal: 1250,
      targetZoneKey: "external_import.draw_request_raw",
      blockingIssues: [],
    });
  });

  it("detects draw invoice workbook sheets and assigns raw zones", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Draw Invoice List",
          rows: [
            ["Invoice No", "Vendor", "Amount"],
            ["INV-1", "Apex", 100],
          ],
        },
        {
          name: "Transfer Log",
          rows: [
            ["Transfer Date", "From Unit", "To Unit", "Amount"],
            ["2026-04-02", "101", "102", "$200"],
          ],
        },
        {
          name: "Change Order Log",
          rows: [
            ["Change Order No", "Vendor", "Amount"],
            ["CO-1", "Apex", "$300"],
          ],
        },
      ]),
      "draw-invoice.xlsx",
    );

    expect(preview.tables.map((table) => [table.sourceRole, table.targetZoneKey])).toEqual([
      ["draw_invoice_list", "external_import.draw_invoice_list_raw"],
      ["transfer_log", "external_import.transfer_log_raw"],
      ["change_order_log", "external_import.change_order_log_raw"],
    ]);
    expect(preview.tables.map((table) => table.amountTotal)).toEqual([100, 200, 300]);
  });

  it("ignores commas, currency symbols, and blank rows when totaling amounts", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [
            ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
            ["g-1", "Apex", "INV-1", "$1,200.50", "CA"],
            [],
            ["g-2", "Bravo", "INV-2", "USD 2,300", "NV"],
            ["", "", "", "", ""],
          ],
        },
      ]),
      "payables.xlsx",
    );

    expect(preview.tables[0]).toMatchObject({
      rowCount: 2,
      amountTotal: 3500.5,
      blockingIssues: [],
    });
  });

  it("marks empty detected data as blocking", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [["GuId", "Vendor", "Invoice No", "Amount", "Cost State"]],
        },
      ]),
      "empty-payables.xlsx",
    );

    expect(preview.tables[0].sourceRole).toBe("payable");
    expect(preview.tables[0].blockingIssues).toContain("Detected sheet has no data rows.");
  });

  it("treats extra non-key columns and missing optional columns as warning-only", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [
            ["GuId", "Vendor", "Invoice No", "Amount", "Notes", "Unexpected"],
            ["g-1", "Apex", "INV-1", 100, "ok", "extra"],
          ],
        },
      ]),
      "payables-extra-columns.xlsx",
    );

    expect(preview.tables[0].blockingIssues).toEqual([]);
    expect(preview.tables[0].warnings).toEqual(
      expect.arrayContaining([
        "Missing optional columns: Cost State.",
        "Extra non-key columns: Notes, Unexpected.",
      ]),
    );
  });

  it("marks missing required semantic fields as blocking", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [
            ["GuId", "Vendor", "Amount", "Cost State"],
            ["g-1", "Apex", 100, "CA"],
          ],
        },
      ]),
      "payables-missing-required.xlsx",
    );

    expect(preview.tables[0].sourceRole).toBe("payable");
    expect(preview.tables[0].blockingIssues).toContain("Missing required columns: Invoice No.");
  });

  it("marks unparsable required amounts as blocking instead of totaling them as zero", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [
            ["GuId", "Vendor", "Invoice No", "Amount", "Cost State"],
            ["g-1", "Apex", "INV-1", "not a number", "CA"],
          ],
        },
      ]),
      "payables-invalid-amount.xlsx",
    );

    expect(preview.tables[0]).toMatchObject({
      sourceRole: "payable",
      amountTotal: 0,
    });
    expect(preview.tables[0].blockingIssues).toContain(
      'Unparsable amount values in required columns: Amount has invalid value "not a number".',
    );
  });

  it("marks unparsable required dates as blocking", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Transfer Log",
          rows: [
            ["Transfer Date", "From Unit", "To Unit", "Amount"],
            ["not a date", "101", "102", 200],
          ],
        },
      ]),
      "transfer-log-invalid-date.xlsx",
    );

    expect(preview.tables[0].sourceRole).toBe("transfer_log");
    expect(preview.tables[0].blockingIssues).toContain(
      'Unparsable date values in required columns: Transfer Date has invalid value "not a date".',
    );
  });

  it("marks duplicate required semantic headers as blocking", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Payable",
          rows: [
            ["GuId", "Vendor", "Invoice No", "Amount", "Amount", "Cost State"],
            ["g-1", "Apex", "INV-1", 100, 200, "CA"],
          ],
        },
      ]),
      "payables-duplicate-required.xlsx",
    );

    expect(preview.tables[0].sourceRole).toBe("payable");
    expect(preview.tables[0].blockingIssues).toContain("Duplicate required columns: Amount.");
  });

  it("marks ambiguous source detection as blocking rather than silently picking one role", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Import",
          rows: [
            ["GuId", "Vendor", "Invoice No", "Amount", "RowId", "Final Amount", "Posting Date 1", "Unit Code", "Cost Code"],
            ["g-1", "Apex", "INV-1", 100, "r-1", 50, "2026-04-01", "101", "03-100"],
          ],
        },
      ]),
      "ambiguous-import.xlsx",
    );

    expect(preview.tables[0].blockingIssues).toContain(
      "Ambiguous source detection: matched multiple source roles (payable, final_detail).",
    );
  });

  it("does not detect unit budget from headers alone on non-unit-budget sheets", () => {
    const preview = parseWorkbookBuffer(
      workbookBuffer([
        {
          name: "Import",
          rows: [
            ["Unit Code", "Cost Code", "Foundation"],
            ["101", "03-100", 1000],
          ],
        },
      ]),
      "not-unit-budget.xlsx",
    );

    expect(preview.tables).toHaveLength(0);
  });
});
