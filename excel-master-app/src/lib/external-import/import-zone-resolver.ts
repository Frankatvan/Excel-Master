export interface ImportZoneGridRange {
  sheetId: number;
  startRowIndex: number;
  startColumnIndex: number;
  endRowIndex?: number;
  endColumnIndex?: number;
}

export interface ResolvedImportZone {
  zoneKey: string;
  sourceRole: string;
  sheetRole: string;
  capacityPolicy: "expand_within_managed_sheet" | "fixed_capacity";
  headerSignaturePolicy: string;
  gridRange: ImportZoneGridRange;
  sheetGridProperties?: {
    rowCount?: number;
    columnCount?: number;
  };
  fingerprint: string;
}

export interface ImportZoneIssue {
  code: string;
  message: string;
}

export type ImportZoneResolution =
  | {
      ok: true;
      zone: ResolvedImportZone;
      warnings: ImportZoneIssue[];
      blockingIssues: [];
    }
  | {
      ok: false;
      zone: null;
      warnings: ImportZoneIssue[];
      blockingIssues: ImportZoneIssue[];
    };

interface SpreadsheetLike {
  sheets?: SheetLike[];
}

interface SheetLike {
  properties?: {
    sheetId?: number;
    title?: string;
    gridProperties?: {
      rowCount?: number;
      columnCount?: number;
    };
  };
  developerMetadata?: DeveloperMetadataLike[];
}

interface DeveloperMetadataLike {
  metadataKey?: string;
  metadataValue?: string;
}

interface RawZoneMetadata {
  zone_key?: unknown;
  source_role?: unknown;
  sheet_role?: unknown;
  managed_by?: unknown;
  schema_version?: unknown;
  capacity_policy?: unknown;
  header_signature_policy?: unknown;
  start_row_index?: unknown;
  start_column_index?: unknown;
  end_row_index?: unknown;
  end_column_index?: unknown;
}

export const IMPORT_ZONE_METADATA_KEY = "aiwb.import_zone";

const SUPPORTED_CAPACITY_POLICIES = new Set(["expand_within_managed_sheet", "fixed_capacity"]);
const BACKFILL_CAPACITY_POLICY = "metadata_backfill_required";
type SupportedCapacityPolicy = "expand_within_managed_sheet" | "fixed_capacity";

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSchemaVersion(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }

  return readString(value);
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

type ParsedZoneMetadata =
  | { kind: "ignored" }
  | { kind: "valid"; metadata: RawZoneMetadata }
  | { kind: "invalid" };

function parseZoneMetadata(metadata: DeveloperMetadataLike): ParsedZoneMetadata {
  if (metadata.metadataKey !== IMPORT_ZONE_METADATA_KEY || !metadata.metadataValue) {
    return { kind: "ignored" };
  }

  try {
    const parsed = JSON.parse(metadata.metadataValue) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid" };
    }
    return { kind: "valid", metadata: parsed as RawZoneMetadata };
  } catch {
    return { kind: "invalid" };
  }
}

function stableFingerprint(range: ImportZoneGridRange, zoneKey: string) {
  return [
    zoneKey,
    range.sheetId,
    range.startRowIndex,
    range.startColumnIndex,
    range.endRowIndex ?? "",
    range.endColumnIndex ?? "",
  ].join(":");
}

function zoneWidth(range: ImportZoneGridRange) {
  if (typeof range.endColumnIndex !== "number") {
    return undefined;
  }
  return range.endColumnIndex - range.startColumnIndex;
}

function readSheetGridProperties(sheet: SheetLike) {
  const rowCount = readNumber(sheet.properties?.gridProperties?.rowCount);
  const columnCount = readNumber(sheet.properties?.gridProperties?.columnCount);
  if (typeof rowCount !== "number" && typeof columnCount !== "number") {
    return undefined;
  }
  return {
    ...(typeof rowCount === "number" ? { rowCount } : {}),
    ...(typeof columnCount === "number" ? { columnCount } : {}),
  };
}

function isSupportedCapacityPolicy(value: string): value is SupportedCapacityPolicy {
  return SUPPORTED_CAPACITY_POLICIES.has(value);
}

export function resolveImportZone(
  spreadsheet: SpreadsheetLike,
  sourceRole: string,
  options: { sourceColumnCount?: number } = {},
): ImportZoneResolution {
  const normalizedSourceRole = sourceRole.trim();

  for (const sheet of spreadsheet.sheets ?? []) {
    const sheetId = sheet.properties?.sheetId;
    if (typeof sheetId !== "number") {
      continue;
    }

    for (const metadata of sheet.developerMetadata ?? []) {
      const parsedZoneMetadata = parseZoneMetadata(metadata);
      if (parsedZoneMetadata.kind === "ignored") {
        continue;
      }
      if (parsedZoneMetadata.kind === "invalid") {
        return {
          ok: false,
          zone: null,
          warnings: [],
          blockingIssues: [
            {
              code: "IMPORT_ZONE_METADATA_INVALID",
              message: "AiWB semantic import zone metadata is malformed.",
            },
          ],
        };
      }

      const zoneMetadata = parsedZoneMetadata.metadata;

      const metadataSourceRole = readString(zoneMetadata.source_role);
      if (metadataSourceRole !== normalizedSourceRole) {
        continue;
      }

      const zoneKey = readString(zoneMetadata.zone_key);
      const sheetRole = readString(zoneMetadata.sheet_role) ?? sheet.properties?.title;
      const managedBy = readString(zoneMetadata.managed_by);
      const schemaVersion = readSchemaVersion(zoneMetadata.schema_version);
      const capacityPolicy = readString(zoneMetadata.capacity_policy);
      const headerSignaturePolicy = readString(zoneMetadata.header_signature_policy);
      const startRowIndex = readNumber(zoneMetadata.start_row_index);
      const startColumnIndex = readNumber(zoneMetadata.start_column_index);
      const endRowIndex = readNumber(zoneMetadata.end_row_index);
      const endColumnIndex = readNumber(zoneMetadata.end_column_index);

      if (
        !zoneKey ||
        !sheetRole ||
        managedBy !== "AiWB" ||
        !schemaVersion ||
        !capacityPolicy ||
        !headerSignaturePolicy ||
        typeof startRowIndex !== "number" ||
        typeof startColumnIndex !== "number"
      ) {
        return {
          ok: false,
          zone: null,
          warnings: [],
          blockingIssues: [
            {
              code: "IMPORT_ZONE_METADATA_INVALID",
              message: `AiWB semantic import zone metadata for source role ${normalizedSourceRole} is incomplete.`,
            },
          ],
        };
      }

      if (capacityPolicy === BACKFILL_CAPACITY_POLICY) {
        return {
          ok: false,
          zone: null,
          warnings: [],
          blockingIssues: [
            {
              code: "IMPORT_ZONE_METADATA_BACKFILL_REQUIRED",
              message: `AiWB semantic import zone metadata for source role ${normalizedSourceRole} requires metadata backfill before import.`,
            },
          ],
        };
      }

      if (!isSupportedCapacityPolicy(capacityPolicy)) {
        return {
          ok: false,
          zone: null,
          warnings: [],
          blockingIssues: [
            {
              code: "IMPORT_ZONE_METADATA_INVALID",
              message: `AiWB semantic import zone metadata for source role ${normalizedSourceRole} uses unsupported capacity policy ${capacityPolicy}.`,
            },
          ],
        };
      }

      const gridRange: ImportZoneGridRange = {
        sheetId,
        startRowIndex,
        startColumnIndex,
        ...(typeof endRowIndex === "number" ? { endRowIndex } : {}),
        ...(typeof endColumnIndex === "number" ? { endColumnIndex } : {}),
      };
      const sheetGridProperties = readSheetGridProperties(sheet);

      const width = zoneWidth(gridRange);
      if (
        capacityPolicy === "fixed_capacity" &&
        typeof options.sourceColumnCount === "number" &&
        typeof width === "number" &&
        options.sourceColumnCount > width
      ) {
        return {
          ok: false,
          zone: null,
          warnings: [],
          blockingIssues: [
            {
              code: "IMPORT_ZONE_CAPACITY_EXCEEDED",
              message: `Source role ${normalizedSourceRole} has ${options.sourceColumnCount} columns but zone ${zoneKey} can contain ${width}.`,
            },
          ],
        };
      }

      return {
        ok: true,
        zone: {
          zoneKey,
          sourceRole: metadataSourceRole,
          sheetRole,
          capacityPolicy,
          headerSignaturePolicy,
          gridRange,
          ...(sheetGridProperties ? { sheetGridProperties } : {}),
          fingerprint: stableFingerprint(gridRange, zoneKey),
        },
        warnings: [],
        blockingIssues: [],
      };
    }
  }

  return {
    ok: false,
    zone: null,
    warnings: [],
    blockingIssues: [
      {
        code: "IMPORT_ZONE_NOT_FOUND",
        message: `No AiWB semantic import zone metadata found for source role ${normalizedSourceRole}.`,
      },
    ],
  };
}
