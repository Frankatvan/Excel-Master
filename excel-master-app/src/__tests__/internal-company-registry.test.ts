import {
  buildInternalCompanyRegistryRows,
  isInternalCompanyVendor,
  normalizeInternalCompanyName,
  validateInternalCompanyWorkbookHeaders,
} from "@/lib/internal-company-registry";

describe("internal company registry helpers", () => {
  it("normalizes whitespace and casing but keeps exact-name matching", () => {
    const registry = [
      {
        company_name: "AMG Crown Fund LLC",
        normalized_name: "amg crown fund llc",
      },
      {
        company_name: "WB Home LLC",
        normalized_name: "wb home llc",
      },
    ];

    expect(normalizeInternalCompanyName("  amg   crown fund llc  ")).toBe("amg crown fund llc");
    expect(isInternalCompanyVendor("AMG Crown Fund LLC", registry)).toBe(true);
    expect(isInternalCompanyVendor("AMG Crown Fund", registry)).toBe(false);
    expect(isInternalCompanyVendor("WB Home LLC - Houston", registry)).toBe(false);
  });

  it("dedupes imported workbook rows by normalized company name and keeps the latest display name", () => {
    const rows = buildInternalCompanyRegistryRows([
      { Company: "  AMG Crown Fund LLC " },
      { Company: "amg   crown fund llc" },
      { Company: "WB Home LLC" },
      { Company: "" },
    ]);

    expect(rows).toEqual([
      {
        company_name: "amg   crown fund llc",
        normalized_name: "amg crown fund llc",
      },
      {
        company_name: "WB Home LLC",
        normalized_name: "wb home llc",
      },
    ]);
  });

  it("fails loudly when the workbook is missing the Company column", () => {
    expect(() => validateInternalCompanyWorkbookHeaders(["Vendor", "Other"])).toThrow(
      'Internal companies workbook must include a "Company" column.',
    );
  });
});
