import { resolveImportZone } from "@/lib/external-import/import-zone-resolver";

const metadataSpreadsheet = {
  sheets: [
    {
      properties: { sheetId: 101, title: "Payable" },
      developerMetadata: [
        {
          metadataKey: "aiwb.import_zone",
          metadataValue: JSON.stringify({
            zone_key: "external_import.payable_raw",
            source_role: "payable",
            sheet_role: "Payable",
            managed_by: "AiWB",
            schema_version: "1",
            capacity_policy: "expand_within_managed_sheet",
            header_signature_policy: "required_semantic_headers",
            start_row_index: 0,
            start_column_index: 0,
            end_row_index: 20000,
            end_column_index: 50,
          }),
        },
      ],
    },
  ],
};

function spreadsheetWithZoneMetadata(metadataValue: string) {
  return {
    sheets: [
      {
        properties: { sheetId: 101, title: "Payable" },
        developerMetadata: [
          {
            metadataKey: "aiwb.import_zone",
            metadataValue,
          },
        ],
      },
    ],
  };
}

function zoneMetadata(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    zone_key: "external_import.payable_raw",
    source_role: "payable",
    sheet_role: "Payable",
    managed_by: "AiWB",
    schema_version: "1",
    capacity_policy: "expand_within_managed_sheet",
    header_signature_policy: "required_semantic_headers",
    start_row_index: 0,
    start_column_index: 0,
    end_row_index: 20000,
    end_column_index: 50,
    ...overrides,
  });
}

describe("import-zone-resolver", () => {
  it("resolves semantic import zone metadata into a structured GridRange", () => {
    expect(resolveImportZone(metadataSpreadsheet, "payable")).toEqual({
      ok: true,
      zone: {
        zoneKey: "external_import.payable_raw",
        sourceRole: "payable",
        sheetRole: "Payable",
        capacityPolicy: "expand_within_managed_sheet",
        headerSignaturePolicy: "required_semantic_headers",
        gridRange: {
          sheetId: 101,
          startRowIndex: 0,
          startColumnIndex: 0,
          endRowIndex: 20000,
          endColumnIndex: 50,
        },
        fingerprint: expect.any(String),
      },
      warnings: [],
      blockingIssues: [],
    });
  });

  it("carries current sheet grid properties for managed runtime expansion", () => {
    const resolution = resolveImportZone(
      {
        sheets: [
          {
            properties: {
              sheetId: 101,
              title: "Payable",
              gridProperties: { rowCount: 50000, columnCount: 702 },
            },
            developerMetadata: metadataSpreadsheet.sheets[0].developerMetadata,
          },
        ],
      },
      "payable",
    );

    expect(resolution).toMatchObject({
      ok: true,
      zone: {
        sheetGridProperties: { rowCount: 50000, columnCount: 702 },
      },
    });
  });

  it("accepts numeric schema version emitted by workbook bootstrap metadata", () => {
    const resolution = resolveImportZone(
      spreadsheetWithZoneMetadata(zoneMetadata({ schema_version: 1 })),
      "payable",
    );

    expect(resolution.ok).toBe(true);
  });

  it("blocks when metadata is missing or source role does not match", () => {
    expect(resolveImportZone({ sheets: [] }, "payable")).toEqual({
      ok: false,
      zone: null,
      warnings: [],
      blockingIssues: [
        {
          code: "IMPORT_ZONE_NOT_FOUND",
          message: "No AiWB semantic import zone metadata found for source role payable.",
        },
      ],
    });
  });

  it("blocks extra columns when fixed capacity cannot contain the source width", () => {
    const fixedCapacitySpreadsheet = {
      sheets: [
        {
          properties: { sheetId: 202, title: "Final Detail" },
          developerMetadata: [
            {
              metadataKey: "aiwb.import_zone",
              metadataValue: JSON.stringify({
                zone_key: "external_import.final_detail_raw",
                source_role: "final_detail",
                sheet_role: "Final Detail",
                managed_by: "AiWB",
                schema_version: "1",
                capacity_policy: "fixed_capacity",
                header_signature_policy: "required_semantic_headers",
                start_row_index: 0,
                start_column_index: 0,
                end_row_index: 100,
                end_column_index: 2,
              }),
            },
          ],
        },
      ],
    };

    expect(resolveImportZone(fixedCapacitySpreadsheet, "final_detail", { sourceColumnCount: 3 })).toEqual({
      ok: false,
      zone: null,
      warnings: [],
      blockingIssues: [
        {
          code: "IMPORT_ZONE_CAPACITY_EXCEEDED",
          message: "Source role final_detail has 3 columns but zone external_import.final_detail_raw can contain 2.",
        },
      ],
    });
  });

  it("blocks import zones missing a schema version", () => {
    expect(resolveImportZone(spreadsheetWithZoneMetadata(zoneMetadata({ schema_version: undefined })), "payable")).toEqual({
      ok: false,
      zone: null,
      warnings: [],
      blockingIssues: [
        {
          code: "IMPORT_ZONE_METADATA_INVALID",
          message: "AiWB semantic import zone metadata for source role payable is incomplete.",
        },
      ],
    });
  });

  it("blocks import zones with unsupported capacity policy values", () => {
    expect(
      resolveImportZone(spreadsheetWithZoneMetadata(zoneMetadata({ capacity_policy: "append_to_hidden_manifest" })), "payable"),
    ).toEqual({
      ok: false,
      zone: null,
      warnings: [],
      blockingIssues: [
        {
          code: "IMPORT_ZONE_METADATA_INVALID",
          message: "AiWB semantic import zone metadata for source role payable uses unsupported capacity policy append_to_hidden_manifest.",
        },
      ],
    });
  });

  it("requires backfill before using import zones marked metadata_backfill_required", () => {
    expect(
      resolveImportZone(
        spreadsheetWithZoneMetadata(zoneMetadata({ capacity_policy: "metadata_backfill_required" })),
        "payable",
      ),
    ).toEqual({
      ok: false,
      zone: null,
      warnings: [],
      blockingIssues: [
        {
          code: "IMPORT_ZONE_METADATA_BACKFILL_REQUIRED",
          message: "AiWB semantic import zone metadata for source role payable requires metadata backfill before import.",
        },
      ],
    });
  });

  it("reports malformed aiwb import zone metadata as invalid instead of not found", () => {
    expect(resolveImportZone(spreadsheetWithZoneMetadata("{not-json"), "payable")).toEqual({
      ok: false,
      zone: null,
      warnings: [],
      blockingIssues: [
        {
          code: "IMPORT_ZONE_METADATA_INVALID",
          message: "AiWB semantic import zone metadata is malformed.",
        },
      ],
    });
  });
});
