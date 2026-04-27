import { buildSheetDiscoveries, discoverSheetFieldCandidates } from "@/lib/sheet-field-mapper";

describe("sheet-field-mapper", () => {
  it("discovers payable amount/vendor candidates from header aliases", () => {
    const rows = [
      ["", "", ""],
      ["Vendor", "Invoice No", "Amount", "Cost State"],
      ["A", "INV-1", "100", "Direct"],
    ];

    const result = discoverSheetFieldCandidates("Payable", rows);
    expect(result).toBeTruthy();
    expect(result?.header_row_index).toBe(2);

    const selectedAmount = result?.candidates.find(
      (candidate) => candidate.logical_field === "amount" && candidate.is_selected,
    );
    expect(selectedAmount).toEqual(
      expect.objectContaining({
        column_index: 3,
        column_letter: "C",
        match_strategy: "exact",
      }),
    );
  });

  it("pins draw raw_cost_state to C column as selected manual mapping", () => {
    const rows = [
      ["Draw Invoice", "Invoiced No", "Cost State", "Amount"],
      ["D-1", "INV-1", "ROE", "100"],
    ];

    const result = discoverSheetFieldCandidates("Draw request report", rows);
    expect(result).toBeTruthy();

    const selectedState = result?.candidates.find(
      (candidate) => candidate.logical_field === "raw_cost_state" && candidate.is_selected,
    );
    expect(selectedState).toEqual(
      expect.objectContaining({
        column_index: 3,
        column_letter: "C",
        match_strategy: "manual",
        confidence: 1,
      }),
    );
  });

  it("builds discoveries only for configured sheets", () => {
    const discoveries = buildSheetDiscoveries({
      Payable: [["Vendor", "Amount"], ["A", 10]],
      UnknownSheet: [["Foo", "Bar"]],
      "Unit Master": [["Unit Code", "C/O date"], ["U1", "2025-01-01"]],
    });

    expect(discoveries.map((item) => item.sheet_name).sort()).toEqual(["Payable", "Unit Master"]);
  });
});

