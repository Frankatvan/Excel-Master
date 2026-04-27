import { google } from "googleapis";

import { getGoogleServiceAccountCredentials } from "@/lib/google-service-account";
import { buildProject109Range, getProject109Title } from "@/lib/project-109-sheet";

interface GridRangeLike {
  sheetId?: number | null;
  startRowIndex?: number | null;
  endRowIndex?: number | null;
  startColumnIndex?: number | null;
  endColumnIndex?: number | null;
}

interface ManagedProtectionSummary {
  title: string;
  description: string;
  protected_range: string;
  unprotected_ranges: string[];
}

export interface LiveSheetStatus {
  spreadsheet_id: string;
  verified_at: string;
  checks: {
    units_count_formula: string;
    units_count_uses_unit_master: boolean;
    scoping_o56: string;
    scoping_o93: string;
    managed_sheets: string[];
    formula_lock_ranges_109: string[];
    unit_master_manual_ranges: string[];
    header_input_ranges_109: string[];
  };
  protections: ManagedProtectionSummary[];
}

function quoteSheetName(name: string) {
  return `'${name.replace(/'/g, "''")}'`;
}

function columnNumberToA1(index1Based: number) {
  let value = index1Based;
  let out = "";

  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }

  return out || "A";
}

function gridRangeToA1(range: GridRangeLike | undefined, sheetTitle: string) {
  if (!range) {
    return quoteSheetName(sheetTitle);
  }

  const startRow = (range.startRowIndex ?? 0) + 1;
  const endRow = range.endRowIndex ?? startRow;
  const startCol = (range.startColumnIndex ?? 0) + 1;
  const endCol = range.endColumnIndex ?? startCol;
  const startCell = `${columnNumberToA1(startCol)}${startRow}`;
  const endCell = `${columnNumberToA1(endCol)}${endRow}`;

  if (startCell === endCell) {
    return `${quoteSheetName(sheetTitle)}!${startCell}`;
  }

  return `${quoteSheetName(sheetTitle)}!${startCell}:${endCell}`;
}

function readFirstCell(values: unknown) {
  if (!Array.isArray(values) || !Array.isArray(values[0])) {
    return "";
  }

  const value = values[0][0];
  return value === undefined || value === null ? "" : String(value);
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: getGoogleServiceAccountCredentials(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  return google.sheets({ version: "v4", auth });
}

export async function getLiveSheetStatus(spreadsheetId: string): Promise<LiveSheetStatus> {
  const sheet109Title = await getProject109Title(spreadsheetId);
  if (!sheet109Title) {
    throw new Error(`PROJECT_MAIN_SHEET_TITLE_UNRESOLVED:${spreadsheetId}`);
  }
  const headerInputRanges109 = [
    buildProject109Range(sheet109Title, "C2:E2"),
    buildProject109Range(sheet109Title, "G2:I2"),
  ];
  const sheets = await getSheetsClient();
  const formulaResponse = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [buildProject109Range(sheet109Title, "C5")],
    valueRenderOption: "FORMULA",
  });
  const valueResponse = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    // TODO(WBS-02): resolve Scoping controls from semantic mapping context, not fixed cells.
    ranges: ["'Scoping'!O56", "'Scoping'!O93"],
    valueRenderOption: "FORMATTED_VALUE",
  });
  const metadataResponse = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title),protectedRanges(protectedRangeId,description,unprotectedRanges,range))",
  });

  const titleBySheetId = new Map<number, string>();
  const protections: ManagedProtectionSummary[] = [];

  for (const sheet of metadataResponse.data.sheets ?? []) {
    const title = sheet.properties?.title;
    const sheetId = sheet.properties?.sheetId;
    if (typeof title === "string" && typeof sheetId === "number") {
      titleBySheetId.set(sheetId, title);
    }
  }

  for (const sheet of metadataResponse.data.sheets ?? []) {
    const title = sheet.properties?.title;
    if (!title) {
      continue;
    }

    for (const protection of sheet.protectedRanges ?? []) {
      const description = protection.description?.trim();
      if (!description || !description.startsWith("AiWB managed")) {
        continue;
      }

      protections.push({
        title,
        description,
        protected_range: gridRangeToA1(protection.range, title),
        unprotected_ranges: (protection.unprotectedRanges ?? []).map((range) =>
          gridRangeToA1(range, titleBySheetId.get(range.sheetId ?? sheet.properties?.sheetId ?? -1) || title),
        ),
      });
    }
  }

  const unitsCountFormula = readFirstCell(formulaResponse.data.valueRanges?.[0]?.values);
  const scopingO56 = readFirstCell(valueResponse.data.valueRanges?.[0]?.values);
  const scopingO93 = readFirstCell(valueResponse.data.valueRanges?.[1]?.values);
  const protection109 = protections.find((item) => item.title === sheet109Title);
  const formulaLockRanges109 = protections
    .filter(
      (item) => item.title === sheet109Title && item.description.startsWith("AiWB managed formula lock"),
    )
    .map((item) => item.protected_range);
  const protectionUnitMaster = protections.find((item) => item.title === "Unit Master");

  return {
    spreadsheet_id: spreadsheetId,
    verified_at: new Date().toISOString(),
    checks: {
      units_count_formula: unitsCountFormula,
      units_count_uses_unit_master: unitsCountFormula.includes("'Unit Master'!$A$3:$A"),
      scoping_o56: scopingO56,
      scoping_o93: scopingO93,
      managed_sheets: protections.map((item) => item.title),
      formula_lock_ranges_109: formulaLockRanges109,
      unit_master_manual_ranges: protectionUnitMaster?.unprotected_ranges ?? [],
      header_input_ranges_109:
        protection109?.unprotected_ranges.filter((range) => headerInputRanges109.includes(range)) ?? [],
    },
    protections,
  };
}
