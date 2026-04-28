import {
  buildExternalImportRowBandRequests,
  planExternalImportStep,
} from "@/lib/external-import/step-runner";

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

describe("external import step runner", () => {
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
});
