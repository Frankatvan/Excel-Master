import { __internal, buildManualInputSnapshot } from "@/lib/audit-manual-input";

function makeRow(length: number): Array<string | number> {
  return Array.from({ length }, () => "");
}

function setField(
  rows: Array<Array<string | number>>,
  rowIndex: number,
  section: string,
  label: string,
  valueColumnIndex: number,
  value: number | string,
) {
  rows[rowIndex][2] = section;
  rows[rowIndex][3] = label;
  rows[rowIndex][valueColumnIndex] = value;
}

function setMergedField(
  rows: Array<Array<string | number>>,
  rowIndex: number,
  label: string,
  valueColumnIndex: number,
  value: number | string,
) {
  rows[rowIndex][3] = label;
  rows[rowIndex][valueColumnIndex] = value;
}

describe("buildManualInputSnapshot", () => {
  it("builds profit statement entries only from manual-input ranges, scoping groups, and unit master dates", () => {
    const rows109 = Array.from({ length: 60 }, (_, rowIndex) => {
      const row = makeRow(30);
      row[5] = rowIndex === 9 ? "2024" : "";
      row[6] = rowIndex === 9 ? "2025" : "";
      row[7] = rowIndex === 9 ? "2026" : "";
      row[12] = rowIndex === 9 ? "2024" : "";
      row[13] = rowIndex === 9 ? "2025" : "";
      row[14] = rowIndex === 9 ? "2026" : "";
      if (rowIndex === 2) {
        row[3] = "Non-manual Cost";
        row[6] = "45.5";
      }
      if (rowIndex === 17) {
        row[3] = "General Conditions fee-Audited";
        row[5] = 123;
        row[12] = 456;
      }
      if (rowIndex === 3) {
        row[2] = "Start date";
        row[5] = "2025-01-01";
      }
      if (rowIndex === 4) {
        row[2] = "Project Name";
        row[5] = 999;
      }
      if (rowIndex === 31) {
        row[2] = "WB Home";
        row[3] = "ROE成本 - WB Home";
        row[4] = 10;
      }
      if (rowIndex === 40) {
        row[3] = "WB Home收入";
        row[4] = 5;
      }
      return row;
    });

    const scopingRows = [
      ["", "", "Group Number", "Group Name", "E", "F", "G", "H", "I", "J", "Warranty Months", "Warranty Due Date", "Budget amount", "Incurred amount"],
      ["", "", "300", "Test Group", "", "", "", "", "", "", "12", "2025-12-31", "1000", "100"],
    ];

    const unitMasterRows = [
      ["Unit Code", "Total Budget", "C/O date", "Final Date", "Actual Settlement Date", "TBD Acceptance Date"],
      ["U1", "1000", "01/01/2025", "01/05/2025", "01/10/2025", "01/20/2025"],
    ];

    const snapshot = buildManualInputSnapshot({
      rows109,
      scopingRows,
      unitMasterRows,
    });

    expect(snapshot.profit_statement_entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cell_position: "F18", field_name: "General Conditions fee-Audited", amount: 123 }),
        expect.objectContaining({ cell_position: "M18", field_name: "General Conditions fee-Audited", amount: 456 }),
      ]),
    );

    expect(snapshot.profit_statement_entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cell_position: "G3", field_name: "Non-manual Cost", amount: 45.5 }),
      ]),
    );
    expect(snapshot.validation_errors.some((row) => row.rule_id === "roe_wbhome_mismatch")).toBe(true);
    expect(snapshot.profit_statement_entries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_name: "Start date" }),
        expect.objectContaining({ field_name: "Project Name" }),
      ]),
    );

    expect(snapshot.scoping_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: "300",
          group_name: "Test Group",
          scope_values: "",
          warranty_months: "12",
          warranty_due_date: "2025-12-31",
          budget_amount: 1000,
          incurred_amount: 100,
          status: "未录入数值",
        }),
      ]),
    );

    expect(snapshot.unit_master_dates).toEqual([
      expect.objectContaining({
        unit_code: "U1",
        co_date: "01/01/2025",
        final_date: "01/05/2025",
        actual_settlement_date: "01/10/2025",
        tbd_acceptance_date: "01/20/2025",
      }),
    ]);
  });

  it("emits the manual-input validation rules for inconsistent completion and WB Home rows", () => {
    const rows109 = Array.from({ length: 60 }, () => makeRow(14));
    // Year axis shifts to I:K so value column becomes H (index 7), not fixed E.
    rows109[5][8] = "2024";
    rows109[5][9] = "2025";
    rows109[5][10] = "2026";
    setField(rows109, 11, "Total Project", "Percentage of Completion", 7, 110);
    setMergedField(rows109, 12, "Completion Rate for the Period", 7, 90);
    setField(rows109, 31, "WB Home", "ROE成本 - WB Home", 7, 10);
    setMergedField(rows109, 40, "WB Home收入", 7, 5);

    const snapshot = buildManualInputSnapshot({
      rows109,
      scopingRows: [],
      unitMasterRows: [],
    });

    expect(snapshot.validation_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: "poc_mismatch" }),
        expect.objectContaining({ rule_id: "poc_over_100" }),
        expect.objectContaining({ rule_id: "roe_wbhome_mismatch" }),
      ]),
    );
  });

  it("flags contract change vs revenue when cumulative POC is exactly 100%", () => {
    const rows109 = Array.from({ length: 60 }, () => makeRow(14));
    rows109[4][7] = "2023";
    rows109[4][8] = "2024";
    rows109[4][9] = "2025";
    setField(rows109, 11, "Total Project", "Percentage of Completion (POC)", 6, 100);
    setMergedField(rows109, 12, "Completion Rate for the Period", 6, 100);
    setMergedField(rows109, 15, "Contract change amount", 6, 1);
    setMergedField(rows109, 16, "General Conditions fee", 6, 2);
    setField(rows109, 31, "WB Home", "ROE成本 - WB Home", 6, 5);
    setMergedField(rows109, 40, "WB Home收入", 6, -5);

    const snapshot = buildManualInputSnapshot({
      rows109,
      scopingRows: [],
      unitMasterRows: [],
    });

    expect(snapshot.validation_errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: "contract_change_revenue_mismatch" }),
      ]),
    );
  });

  it("finds row by label path with merged section cells", () => {
    const rows109 = Array.from({ length: 20 }, () => makeRow(12));
    rows109[3][2] = "Total Project";
    rows109[3][3] = "Initial Budget";
    rows109[4][3] = "Percentage of Completion";
    rows109[5][3] = "Completion Rate for the Period";

    const rowIndex = __internal.findRowByLabelPath(rows109, ["Total Project", "Percentage of Completion"]);
    expect(rowIndex).toBe(4);
  });

  it("finds row labels from column C when column D is blank", () => {
    const rows109 = Array.from({ length: 20 }, () => makeRow(12));
    rows109[10][2] = "General Conditions fee-Company";
    rows109[10][3] = "";

    const rowIndex = __internal.findRowByLabelPath(rows109, ["General Conditions fee-Company"]);
    expect(rowIndex).toBe(10);
  });

  it("discovers multi-year axis dynamically and derives the value column", () => {
    const rows109 = Array.from({ length: 20 }, () => makeRow(16));
    rows109[6][9] = "2022";
    rows109[6][10] = "2023";
    rows109[6][11] = "2024";

    const axis = __internal.discoverYearAxis(rows109);
    expect(axis).toEqual(
      expect.objectContaining({
        rowIndex: 6,
        startColumnIndex: 9,
        endColumnIndex: 11,
      }),
    );
    expect(__internal.resolveValueColumnIndex(rows109)).toBe(8);
  });

  it("marks scoping rows incomplete when warranty fields are missing", () => {
    const snapshot = buildManualInputSnapshot({
      rows109: [],
      scopingRows: [
        ["", "", "Group Number", "Group Name", "E", "F", "G", "H", "I", "J", "Warranty Months", "Warranty Due Date", "Budget amount", "Incurred amount"],
        ["", "", "301", "Complete Group", "1", "2", "3", "4", "5", "6", "12", "", "1000", ""],
      ],
      unitMasterRows: [],
    });

    expect(snapshot.scoping_groups).toEqual([
      expect.objectContaining({
        group: "301",
        group_name: "Complete Group",
        scope_values: "1/2/3/4/5/6",
        status: "未录入数值",
      }),
    ]);
  });

  it("reads scoping values by headers including Final GMP", () => {
    const snapshot = buildManualInputSnapshot({
      rows109: [],
      scopingRows: [
        ["", "", "Group Number", "Group Name", "GMP", "Final GMP", "Fee", "WIP", "WTC", "GC", "TBD", "Warranty Months", "Warranty Due Date", "Budget amount", "Incurred amount"],
        ["", "", "301", "Group 301", "1", "", "2", "", "", "5", "", "12", "07/12/2027", "1000", "100"],
      ],
      unitMasterRows: [],
    });

    expect(snapshot.scoping_groups).toEqual([
      expect.objectContaining({
        group: "301",
        group_name: "Group 301",
        scope_values: "GMP=1 / Final GMP=- / Fee=2 / WIP=- / WTC=- / GC=5 / TBD=-",
        warranty_months: "12",
      }),
    ]);
  });

  it("hides scoping groups when GMP through warranty months are all blank", () => {
    const snapshot = buildManualInputSnapshot({
      rows109: [],
      scopingRows: [
        ["", "", "Group Number", "Group Name", "E", "F", "G", "H", "I", "J", "Warranty Months", "Warranty Due Date", "Budget amount", "Incurred amount"],
        ["", "", "401", "Blank Group", "", "", "", "", "", "", "", "", "1000", "100"],
        ["", "", "402", "Warranty Group", "", "", "", "", "", "", "24", "", "", ""],
      ],
      unitMasterRows: [],
    });

    expect(snapshot.scoping_groups).toEqual([
      expect.objectContaining({
        group: "402",
        group_name: "Warranty Group",
        scope_values: "",
        warranty_months: "24",
      }),
    ]);
  });

  it("reads generated scoping warranty due dates from the O column", () => {
    const header = makeRow(15);
    header[2] = "Group Number";
    header[3] = "Group Name";
    header[4] = "E";
    header[5] = "F";
    header[6] = "G";
    header[7] = "H";
    header[8] = "I";
    header[9] = "J";
    header[10] = "Warranty Months";
    header[14] = "保修到期日";

    const row = makeRow(15);
    row[2] = "403";
    row[3] = "Generated Due Date Group";
    row[4] = "1";
    row[10] = "24";
    row[14] = "07/12/2027";

    const snapshot = buildManualInputSnapshot({
      rows109: [],
      scopingRows: [header, row],
      unitMasterRows: [],
    });

    expect(snapshot.scoping_groups).toEqual([
      expect.objectContaining({
        group: "403",
        group_name: "Generated Due Date Group",
        scope_values: "1",
        warranty_months: "24",
        warranty_due_date: "07/12/2027",
      }),
    ]);
  });

  it("labels columns beyond Z with alphabetic spreadsheet positions", () => {
    const rows109 = [makeRow(30), makeRow(30)];
    rows109[0][26] = "2024";
    rows109[0][27] = "2025";
    rows109[0][28] = "2026";
    rows109[1][3] = "WB Home Income";
    rows109[1][26] = 1;
    rows109[1][27] = 2;

    const snapshot = buildManualInputSnapshot({
      rows109,
      scopingRows: [],
      unitMasterRows: [],
    });

    expect(snapshot.profit_statement_entries).toEqual([
      expect.objectContaining({ cell_position: "AA2", amount: 1 }),
      expect.objectContaining({ cell_position: "AB2", amount: 2 }),
    ]);
  });

  it("formats unit-master dates as MM/DD/YYYY and flags dates that move backward", () => {
    const snapshot = buildManualInputSnapshot({
      rows109: [],
      scopingRows: [],
      unitMasterRows: [
        ["Unit Code", "Total Budget", "C/O date", "Final Date", "Actual Settlement Date", "TBD Acceptance Date"],
        ["U2", "1000", "2025-02-01", "2025-01-15", "2025-03-01", "2025-02-20"],
      ],
    });

    expect(snapshot.unit_master_dates).toEqual([
      expect.objectContaining({
        unit_code: "U2",
        co_date: "02/01/2025",
        final_date: "01/15/2025",
        actual_settlement_date: "03/01/2025",
        tbd_acceptance_date: "02/20/2025",
        final_date_invalid: true,
        actual_settlement_date_invalid: false,
        tbd_acceptance_date_invalid: true,
      }),
    ]);
  });

  it("reads unit-master date columns by header name when columns are shifted", () => {
    const snapshot = buildManualInputSnapshot({
      rows109: [],
      scopingRows: [],
      unitMasterRows: [
        [
          "Total Budget",
          "Unit Code",
          "Unrelated Amount",
          "C/O date",
          "Final Date",
          "实际结算日期",
          "TBD Acceptance Date",
        ],
        ["1000", "U3", "141,266.40", "2025-02-01", "2025-02-05", "2025-02-10", "2025-02-20"],
      ],
    });

    expect(snapshot.unit_master_dates).toEqual([
      expect.objectContaining({
        unit_code: "U3",
        co_date: "02/01/2025",
        final_date: "02/05/2025",
        actual_settlement_date: "02/10/2025",
        tbd_acceptance_date: "02/20/2025",
      }),
    ]);
  });
});
