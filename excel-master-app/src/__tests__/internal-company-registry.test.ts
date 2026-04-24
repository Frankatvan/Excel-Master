import {
  isInternalCompanyVendor,
  normalizeInternalCompanyName,
} from "@/lib/internal-company-registry";

describe("internal company registry helpers", () => {
  it("normalizes whitespace and casing but keeps exact-name matching", () => {
    const registry = ["AMG Crown Fund LLC", "WB Home LLC"];

    expect(normalizeInternalCompanyName("  amg   crown fund llc  ")).toBe("amg crown fund llc");
    expect(isInternalCompanyVendor("AMG Crown Fund LLC", registry)).toBe(true);
    expect(isInternalCompanyVendor("AMG Crown Fund", registry)).toBe(false);
    expect(isInternalCompanyVendor("WB Home LLC - Houston", registry)).toBe(false);
  });
});
