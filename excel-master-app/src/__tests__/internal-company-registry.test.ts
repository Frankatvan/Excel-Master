import {
  buildInternalCompanyRegistryRows,
  isInternalCompanyVendor,
  normalizeInternalCompanyName,
  readInternalCompanies,
  validateInternalCompanyWorkbookHeaders,
} from "@/lib/internal-company-registry";
import { createClient } from "@supabase/supabase-js";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(),
}));

describe("internal company registry helpers", () => {
  const originalEnv = process.env;
  const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NEXT_PUBLIC_SUPABASE_URL: "http://test-supabase-url",
      SUPABASE_SERVICE_ROLE_KEY: "test-supabase-service-key",
    };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

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

  it("accepts a header-only workbook shape as an empty import", () => {
    expect(buildInternalCompanyRegistryRows([])).toEqual([]);
  });

  it("fails loudly when the workbook is missing the Company column", () => {
    expect(() => validateInternalCompanyWorkbookHeaders(["Vendor", "Other"])).toThrow(
      'Internal companies workbook must include a "Company" column.',
    );
  });

  it("returns an empty registry when the internal_companies table is missing", async () => {
    const order = jest.fn().mockResolvedValue({
      data: null,
      error: { code: "PGRST205", message: "missing table" },
    });
    const select = jest.fn(() => ({ order }));
    const from = jest.fn(() => ({ select }));

    mockCreateClient.mockReturnValue({ from } as never);

    await expect(readInternalCompanies()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          company_name: "AMG Crown Fund LLC",
          normalized_name: "amg crown fund llc",
        }),
      ]),
    );
    expect((await readInternalCompanies()).length).toBeGreaterThan(100);
    expect(from).toHaveBeenCalledWith("internal_companies");
  });

  it("falls back to the bundled registry when the table exists but has no rows", async () => {
    const order = jest.fn().mockResolvedValue({
      data: [],
      error: null,
    });
    const select = jest.fn(() => ({ order }));
    const from = jest.fn(() => ({ select }));

    mockCreateClient.mockReturnValue({ from } as never);

    await expect(readInternalCompanies()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          company_name: "AMG Crown Fund LLC",
        }),
      ]),
    );
  });
});
