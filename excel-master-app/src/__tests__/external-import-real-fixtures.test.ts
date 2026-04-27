import fs from "node:fs";
import path from "node:path";

import { buildPreviewPayload, hashFileBuffer } from "@/lib/external-import/preview-store";
import { parseWorkbookBuffer } from "@/lib/external-import/workbook-parser";

const repoRoot = path.resolve(__dirname, "../../..");

function readFixture(fileName: string) {
  const buffer = fs.readFileSync(path.join(repoRoot, "docs", fileName));

  return {
    fileName,
    buffer,
    parsed: parseWorkbookBuffer(buffer, fileName),
    hash: hashFileBuffer(buffer),
  };
}

describe("external import real staging fixtures", () => {
  it("recognizes all five staging upload classes without blocking pre-write issues", () => {
    const fixtures = [
      readFixture("Payable Report_20260427023857.xlsx"),
      readFixture("LS Fronterra - Final Detail - 20260427.xlsx"),
      readFixture("LS Fronterra_Budget.xlsx"),
      readFixture("_Draw request report_2026-04-27.xlsx"),
      readFixture("Draw Invoice.xlsx"),
    ];
    const preview = buildPreviewPayload({
      spreadsheetId: "staging-fixture",
      parsedWorkbooks: fixtures.map((fixture) => fixture.parsed),
      fileHashes: fixtures.map((fixture) => fixture.hash),
    });

    expect(preview.confirm_allowed).toBe(true);
    expect(preview.source_tables.map((table) => table.source_role).sort()).toEqual([
      "change_order_log",
      "draw_invoice_list",
      "draw_request",
      "final_detail",
      "payable",
      "transfer_log",
      "unit_budget",
    ]);
    expect(preview.source_tables.flatMap((table) => table.blocking_issues)).toEqual([]);
  });

  it("imports only the Draw request report sheet from the draw request workbook", () => {
    const fixture = readFixture("_Draw request report_2026-04-27.xlsx");

    expect(fixture.parsed.tables.map((table) => table.sourceSheetName)).toEqual(["Draw request report"]);
  });

  it("uses semantic zones and never returns spreadsheet coordinates in preview metadata", () => {
    const fixture = readFixture("Payable Report_20260427023857.xlsx");
    const preview = buildPreviewPayload({
      spreadsheetId: "staging-fixture",
      parsedWorkbooks: [fixture.parsed],
      fileHashes: [fixture.hash],
    });
    const metadata = preview.source_tables.map((table) => ({
      source_role: table.source_role,
      source_sheet_name: table.source_sheet_name,
      target_zone_id: table.target_zone_id,
      target_zone_key: table.target_zone_key,
      warnings: table.warnings,
      blocking_issues: table.blocking_issues,
    }));

    expect(fixture.parsed.tables[0].targetZoneKey).toBe("external_import.payable_raw");
    expect(metadata[0].target_zone_key).toBe("external_import.payable_raw");
    expect(JSON.stringify(metadata)).not.toMatch(/\b(?:L1|N1|S1|H1|G1)\b|![A-Z]{1,3}:|![A-Z]{1,3}\$?\d/);
  });
});
