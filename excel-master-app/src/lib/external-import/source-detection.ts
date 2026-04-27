export type ExternalImportSourceRole =
  | "payable"
  | "final_detail"
  | "unit_budget"
  | "draw_request"
  | "draw_invoice_list"
  | "transfer_log"
  | "change_order_log";

export type TargetZoneKey =
  | "external_import.payable_raw"
  | "external_import.final_detail_raw"
  | "external_import.unit_budget_raw"
  | "external_import.draw_request_raw"
  | "external_import.draw_invoice_list_raw"
  | "external_import.transfer_log_raw"
  | "external_import.change_order_log_raw";

export interface SourceDetectionRule {
  sourceRole: ExternalImportSourceRole;
  targetZoneKey: TargetZoneKey;
  sheetNames?: string[];
  exactSheetNames?: string[];
  requiredHeaders: string[];
  optionalHeaders?: string[];
  amountHeaders?: string[];
  dateHeaders?: string[];
  matrixAmountColumns?: boolean;
}

export interface DetectedSource {
  rule: SourceDetectionRule;
  requiredHeadersPresent: string[];
  missingRequiredHeaders: string[];
  missingOptionalHeaders: string[];
  duplicateRequiredHeaders: string[];
  extraHeaders: string[];
  ambiguousSourceRoles: ExternalImportSourceRole[];
}

const SOURCE_RULES: SourceDetectionRule[] = [
  {
    sourceRole: "draw_request",
    targetZoneKey: "external_import.draw_request_raw",
    exactSheetNames: ["Draw request report"],
    requiredHeaders: ["Unit Code", "Cost Code", "Vendor", "Amount"],
    amountHeaders: ["Amount"],
  },
  {
    sourceRole: "draw_invoice_list",
    targetZoneKey: "external_import.draw_invoice_list_raw",
    exactSheetNames: ["Draw Invoice List"],
    requiredHeaders: ["Invoice No", "Vendor", "Amount"],
    amountHeaders: ["Amount"],
  },
  {
    sourceRole: "transfer_log",
    targetZoneKey: "external_import.transfer_log_raw",
    exactSheetNames: ["Transfer Log"],
    requiredHeaders: ["Transfer Date", "From Unit", "To Unit", "Amount"],
    amountHeaders: ["Amount"],
    dateHeaders: ["Transfer Date"],
  },
  {
    sourceRole: "change_order_log",
    targetZoneKey: "external_import.change_order_log_raw",
    exactSheetNames: ["Change Order Log"],
    requiredHeaders: ["Change Order No", "Vendor", "Amount"],
    amountHeaders: ["Amount"],
  },
  {
    sourceRole: "payable",
    targetZoneKey: "external_import.payable_raw",
    sheetNames: ["Payable", "Payables"],
    requiredHeaders: ["GuId", "Vendor", "Invoice No", "Amount"],
    optionalHeaders: ["Cost State"],
    amountHeaders: ["Amount"],
  },
  {
    sourceRole: "final_detail",
    targetZoneKey: "external_import.final_detail_raw",
    sheetNames: ["Final Detail"],
    requiredHeaders: ["RowId", "Final Amount", "Posting Date 1", "Unit Code", "Cost Code", "Vendor"],
    amountHeaders: ["Final Amount"],
    dateHeaders: ["Posting Date 1"],
  },
  {
    sourceRole: "unit_budget",
    targetZoneKey: "external_import.unit_budget_raw",
    sheetNames: ["Unit Budget"],
    requiredHeaders: ["Unit Code", "Cost Code"],
    matrixAmountColumns: true,
  },
];

export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeSheetName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function findHeader(headersByName: Map<string, string>, header: string): string | null {
  return headersByName.get(normalizeHeader(header)) ?? null;
}

function matchesSheetName(rule: SourceDetectionRule, sheetName: string): boolean {
  const normalizedName = normalizeSheetName(sheetName);

  if (rule.exactSheetNames) {
    return rule.exactSheetNames.some((candidate) => normalizeSheetName(candidate) === normalizedName);
  }

  return (rule.sheetNames ?? []).some((candidate) => normalizeSheetName(candidate) === normalizedName);
}

function matchesByHeaders(rule: SourceDetectionRule, headersByName: Map<string, string>): boolean {
  if (rule.requiredHeaders.every((header) => findHeader(headersByName, header))) {
    return true;
  }

  const presentCount = rule.requiredHeaders.filter((header) => findHeader(headersByName, header)).length;
  return presentCount >= Math.max(2, rule.requiredHeaders.length - 1);
}

export function detectSourceForSheet(sheetName: string, headers: string[]): DetectedSource | null {
  const headersByName = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const duplicateRequiredHeadersByRule = new Map<ExternalImportSourceRole, string[]>();
  const candidates: DetectedSource[] = [];

  for (const rule of SOURCE_RULES) {
    const duplicateRequiredHeaders = rule.requiredHeaders.filter((requiredHeader) => {
      const normalizedRequiredHeader = normalizeHeader(requiredHeader);
      return headers.filter((header) => normalizeHeader(header) === normalizedRequiredHeader).length > 1;
    });
    const matchesName = matchesSheetName(rule, sheetName);
    const matchesHeaders = !rule.exactSheetNames && !rule.matrixAmountColumns && matchesByHeaders(rule, headersByName);

    duplicateRequiredHeadersByRule.set(rule.sourceRole, duplicateRequiredHeaders);

    if (!matchesName && !matchesHeaders) {
      continue;
    }

    const requiredHeadersPresent = rule.requiredHeaders.filter((header) => findHeader(headersByName, header));
    const missingRequiredHeaders = rule.requiredHeaders.filter((header) => !findHeader(headersByName, header));
    const missingOptionalHeaders = (rule.optionalHeaders ?? []).filter((header) => !findHeader(headersByName, header));
    const knownHeaders = new Set(
      [...rule.requiredHeaders, ...(rule.optionalHeaders ?? []), ...(rule.amountHeaders ?? []), ...(rule.dateHeaders ?? [])].map(
        normalizeHeader,
      ),
    );
    const extraHeaders = rule.matrixAmountColumns
      ? []
      : headers.filter((header) => header && !knownHeaders.has(normalizeHeader(header)));

    candidates.push({
      rule,
      requiredHeadersPresent,
      missingRequiredHeaders,
      missingOptionalHeaders,
      duplicateRequiredHeaders,
      extraHeaders,
      ambiguousSourceRoles: [],
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const ambiguousSourceRoles = candidates.map((candidate) => candidate.rule.sourceRole);

  return {
    ...candidates[0],
    duplicateRequiredHeaders: duplicateRequiredHeadersByRule.get(candidates[0].rule.sourceRole) ?? [],
    ambiguousSourceRoles: candidates.length > 1 ? ambiguousSourceRoles : [],
  };
}
