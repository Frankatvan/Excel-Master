# External Import Staging Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the current external import release blockers without expanding into broader architecture work.

**Architecture:** Keep the durable external import design from `4af58d0` intact. Remediation is limited to deploy/runtime configuration, real-file parser compatibility, and staging role smoke evidence. No new permission model, no new manifest store, no sheet-coordinate mapping, and no production deployment in this task.

**Tech Stack:** Next.js API routes, Jest, TypeScript external import parser, Python worker pytest, Vercel env/deploy scripts, Supabase durable jobs/manifests, Google Drive role checks.

---

---

## Scope Boundary

### In Scope

- Make external import worker config explicit and verifiable:
  - `EXTERNAL_IMPORT_WORKER_URL`
  - `EXTERNAL_IMPORT_WORKER_SECRET`
- Fix real-file parser blockers found in `docs/superpowers/evidence/2026-04-27-external-import-staging-acceptance-evidence.md`.
- Run authenticated staging role smoke:
  - Reader / Commenter can view status but cannot upload.
  - Collaborator / writer can preview and confirm after parser blockers are cleared.
- Produce updated staging acceptance evidence.

### Out Of Scope

- Any architecture upgrade beyond this remediation.
- New permission model.
- New durable job schema beyond the existing `jobs`, `external_import_manifests`, and `external_import_manifest_items`.
- New mapping UI or admin console.
- Moving manifest truth back into Google Sheets.
- Any hardcoded spreadsheet write coordinates.
- Production deployment or PR merge before updated staging evidence is green.

## Files

- Modify: `excel-master-app/scripts/vercel_env_sync.mjs`
- Modify: `excel-master-app/scripts/vercel_deploy.mjs`
- Modify: `excel-master-app/src/__tests__/deployment-config.test.ts`
- Modify: `excel-master-app/src/pages/api/debug-env.ts`
- Modify: `excel-master-app/docs/vercel-env-migration.md`
- Modify: `docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md`
- Modify: `excel-master-app/src/lib/external-import/source-detection.ts`
- Modify: `excel-master-app/src/lib/external-import/workbook-parser.ts`
- Modify: `excel-master-app/src/__tests__/external-import-parser.test.ts`
- Create: `excel-master-app/src/__tests__/external-import-real-fixtures.test.ts`
- Create: `docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md`

## Task 1: Worker Config Readiness

**Files:**
- Modify: `excel-master-app/scripts/vercel_env_sync.mjs`
- Modify: `excel-master-app/scripts/vercel_deploy.mjs`
- Modify: `excel-master-app/src/__tests__/deployment-config.test.ts`
- Modify: `excel-master-app/src/pages/api/debug-env.ts`
- Modify: `excel-master-app/docs/vercel-env-migration.md`
- Modify: `docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md`

- [ ] **Step 1: Write failing deployment config tests**

Add these tests to `excel-master-app/src/__tests__/deployment-config.test.ts`:

```ts
it("requires external import worker env vars for deployment checks", () => {
  const projectRoot = path.resolve(__dirname, "../..");

  for (const scriptName of ["scripts/vercel_env_sync.mjs", "scripts/vercel_deploy.mjs"]) {
    const scriptText = fs.readFileSync(path.join(projectRoot, scriptName), "utf8");

    expect(scriptText).toContain('"EXTERNAL_IMPORT_WORKER_URL"');
    expect(scriptText).toContain('"EXTERNAL_IMPORT_WORKER_SECRET"');
  }
});

it("debug env reports external import worker readiness without exposing secrets", () => {
  const projectRoot = path.resolve(__dirname, "../..");
  const debugEnvPath = path.join(projectRoot, "src/pages/api/debug-env.ts");
  const debugEnvText = fs.readFileSync(debugEnvPath, "utf8");

  expect(debugEnvText).toContain("hasExternalImportWorkerUrl");
  expect(debugEnvText).toContain("hasExternalImportWorkerSecret");
  expect(debugEnvText).not.toContain("EXTERNAL_IMPORT_WORKER_SECRET,");
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/deployment-config.test.ts
```

Expected: FAIL because deploy scripts and debug env do not yet mention `EXTERNAL_IMPORT_WORKER_URL` / `EXTERNAL_IMPORT_WORKER_SECRET`.

- [ ] **Step 3: Add worker env vars to Vercel sync and deploy scripts**

In both `excel-master-app/scripts/vercel_env_sync.mjs` and `excel-master-app/scripts/vercel_deploy.mjs`, extend the existing required key array:

```js
const REQUIRED_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SHEET_TEMPLATE_ID",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
  "AIWB_WORKER_SECRET",
  "EXTERNAL_IMPORT_WORKER_URL",
  "EXTERNAL_IMPORT_WORKER_SECRET",
];
```

If the file uses `REQUIRED_ENV_KEYS` instead of `REQUIRED_KEYS`, apply the same two entries to that array.

- [ ] **Step 4: Add masked debug readiness fields**

Update `excel-master-app/src/pages/api/debug-env.ts` response:

```ts
res.status(200).json({
  clientId: maskedClientId,
  hasSecret: !!process.env.GOOGLE_CLIENT_SECRET,
  nextAuthUrl: process.env.NEXTAUTH_URL,
  hasServiceAccountJson: !!process.env.GOOGLE_CREDENTIALS_JSON,
  hasGoogleProjectId: !!process.env.GOOGLE_PROJECT_ID,
  hasGooglePrivateKey: !!process.env.GOOGLE_PRIVATE_KEY,
  hasGoogleClientEmail: !!process.env.GOOGLE_CLIENT_EMAIL,
  hasWorkerUrlOverride: !!process.env.RECLASSIFY_WORKER_URL,
  hasExternalImportWorkerUrl: !!process.env.EXTERNAL_IMPORT_WORKER_URL,
  hasExternalImportWorkerSecret: !!process.env.EXTERNAL_IMPORT_WORKER_SECRET,
  deploymentCommit,
  vercelEnv: process.env.VERCEL_ENV || "unknown",
});
```

- [ ] **Step 5: Update docs**

In `excel-master-app/docs/vercel-env-migration.md`, add these required variables to the worker/env section:

```md
- `EXTERNAL_IMPORT_WORKER_URL`
- `EXTERNAL_IMPORT_WORKER_SECRET`
```

In `docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md`, add a preflight check:

```md
- [ ] Confirm `/api/debug-env` reports:
  - [ ] `hasExternalImportWorkerUrl: true`
  - [ ] `hasExternalImportWorkerSecret: true`
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/deployment-config.test.ts
```

Expected: PASS.

Commit:

```bash
git add \
  excel-master-app/scripts/vercel_env_sync.mjs \
  excel-master-app/scripts/vercel_deploy.mjs \
  excel-master-app/src/__tests__/deployment-config.test.ts \
  excel-master-app/src/pages/api/debug-env.ts \
  excel-master-app/docs/vercel-env-migration.md \
  docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md
git commit -m "fix: require external import worker config"
```

## Task 2: Real-File Parser Blockers

**Files:**
- Modify: `excel-master-app/src/lib/external-import/source-detection.ts`
- Modify: `excel-master-app/src/lib/external-import/workbook-parser.ts`
- Modify: `excel-master-app/src/__tests__/external-import-parser.test.ts`
- Create: `excel-master-app/src/__tests__/external-import-real-fixtures.test.ts`

- [ ] **Step 1: Write failing real fixture tests**

Create `excel-master-app/src/__tests__/external-import-real-fixtures.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

import { buildPreviewPayload, hashFileBuffer } from "@/lib/external-import/preview-store";
import { parseWorkbookBuffer } from "@/lib/external-import/workbook-parser";

const repoRoot = path.resolve(__dirname, "../../..");

function readFixture(fileName: string) {
  const buffer = fs.readFileSync(path.join(repoRoot, "docs", fileName));
  return {
    fileName,
    buffer,
    parsed: parseWorkbookBuffer(buffer, fileName),
    hash: hashFileBuffer(buffer),
  };
}

describe("external import real staging fixtures", () => {
  it("recognizes all five staging upload classes without blocking pre-write issues", () => {
    const fixtures = [
      readFixture("Payable Report_20260427023857.xlsx"),
      readFixture("LS Fronterra - Final Detail - 20260427.xlsx"),
      readFixture("LS Fronterra_Budget.xlsx"),
      readFixture("_Draw request report_2026-04-27.xlsx"),
      readFixture("Draw Invoice.xlsx"),
    ];
    const preview = buildPreviewPayload({
      spreadsheetId: "staging-fixture",
      parsedWorkbooks: fixtures.map((fixture) => fixture.parsed),
      fileHashes: fixtures.map((fixture) => fixture.hash),
    });

    expect(preview.confirm_allowed).toBe(true);
    expect(preview.source_tables.map((table) => table.source_role).sort()).toEqual([
      "change_order_log",
      "draw_invoice_list",
      "draw_request",
      "final_detail",
      "payable",
      "transfer_log",
      "unit_budget",
    ]);
    expect(preview.source_tables.flatMap((table) => table.blocking_issues)).toEqual([]);
  });

  it("imports only the Draw request report sheet from the draw request workbook", () => {
    const fixture = readFixture("_Draw request report_2026-04-27.xlsx");

    expect(fixture.parsed.tables.map((table) => table.sourceSheetName)).toEqual(["Draw request report"]);
  });

  it("uses semantic zones and never returns spreadsheet coordinates in preview metadata", () => {
    const fixture = readFixture("Payable Report_20260427023857.xlsx");

    expect(fixture.parsed.tables[0].targetZoneKey).toBe("external_import.payable_raw");
    expect(JSON.stringify(fixture.parsed)).not.toMatch(/\b[A-Z]{1,3}\$?[0-9]+\b|![A-Z]{1,3}:|![A-Z]{1,3}\$?\d/);
  });
});
```

- [ ] **Step 2: Run test to verify current blockers**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/external-import-real-fixtures.test.ts
```

Expected: FAIL with:

- `unit_budget` missing.
- Final Detail blocking issue for blank `Posting Date 1`.
- Draw Invoice sheets blocking on required headers.

- [ ] **Step 3: Support real Unit Budget matrix**

In `excel-master-app/src/lib/external-import/source-detection.ts`, replace the `unit_budget` rule with:

```ts
{
  sourceRole: "unit_budget",
  targetZoneKey: "external_import.unit_budget_raw",
  sheetNames: ["Unit Budget", "LS Fronterra"],
  requiredHeaders: ["Total"],
  matrixAmountColumns: true,
},
```

Then update `matchesByHeaders` to recognize `Total(...)` style matrix headers:

```ts
function hasMatrixBudgetHeader(headers: string[]) {
  return headers.some((header) => /^total\s*\(/i.test(String(header ?? "").trim()));
}

function matchesByHeaders(rule: SourceDetectionRule, headersByName: Map<string, string>, headers: string[]): boolean {
  if (rule.matrixAmountColumns) {
    return hasMatrixBudgetHeader(headers);
  }

  if (rule.requiredHeaders.every((header) => findHeader(headersByName, header))) {
    return true;
  }

  const presentCount = rule.requiredHeaders.filter((header) => findHeader(headersByName, header)).length;
  return presentCount >= Math.max(2, rule.requiredHeaders.length - 1);
}
```

Update the caller in `detectSourceForSheet`:

```ts
const matchesHeaders = !rule.exactSheetNames && matchesByHeaders(rule, headersByName, headers);
```

- [ ] **Step 4: Make blank required dates warning-only, while invalid nonblank dates stay blocking**

In `excel-master-app/src/lib/external-import/workbook-parser.ts`, change `requiredValueIssues` date validation to skip blank cells:

```ts
indexesForHeaders(headers, detection.rule.dateHeaders ?? []).forEach((index) => {
  dataRows.forEach((row) => {
    const rawValue = row[index];
    if (String(rawValue ?? "").trim() === "") {
      return;
    }
    if (!isParseableDate(rawValue)) {
      dateIssues.push({ header: headers[index], value: rawValue });
    }
  });
});
```

Add a warning for blank date values:

```ts
function blankRequiredDateWarnings(
  headers: string[],
  dataRows: CellValue[][],
  detection: NonNullable<ReturnType<typeof detectSourceForSheet>>,
): string[] {
  const blankHeaders = indexesForHeaders(headers, detection.rule.dateHeaders ?? []).flatMap((index) =>
    dataRows.some((row) => String(row[index] ?? "").trim() === "") ? [headers[index]] : [],
  );

  return blankHeaders.length ? [`Blank date values present in nullable required date columns: ${blankHeaders.join(", ")}.`] : [];
}
```

When building a parsed table, append this warning:

```ts
warnings: [...buildWarnings(detection), ...blankRequiredDateWarnings(headerRow.headers, dataRows, detection)],
```

- [ ] **Step 5: Support title/preamble rows in Draw Invoice workbook sheets**

Update the draw invoice detection rules in `source-detection.ts` so the real workbook headers are accepted:

```ts
{
  sourceRole: "draw_invoice_list",
  targetZoneKey: "external_import.draw_invoice_list_raw",
  exactSheetNames: ["Draw Invoice List"],
  requiredHeaders: ["Draw Date", "Vendor Name", "Invoice #", "Total"],
  amountHeaders: ["Total"],
  dateHeaders: ["Draw Date", "Invoice Date"],
},
{
  sourceRole: "transfer_log",
  targetZoneKey: "external_import.transfer_log_raw",
  exactSheetNames: ["Transfer Log"],
  requiredHeaders: ["Draw Date", "Description", "Deduct", "Credit", "Total"],
  amountHeaders: ["Total"],
  dateHeaders: ["Draw Date"],
},
{
  sourceRole: "change_order_log",
  targetZoneKey: "external_import.change_order_log_raw",
  exactSheetNames: ["Change Order Log"],
  requiredHeaders: ["Change Order Date Submitted (Draw Date)", "Description", "Approved Change Orders"],
  amountHeaders: ["Approved Change Orders"],
  dateHeaders: ["Change Order Date Submitted (Draw Date)"],
},
```

The existing `findDetectedHeaderRow` already scans past title rows. These rule changes should make it pick row 4 for `Draw Invoice List`, row 2 for `Transfer Log`, and row 2 for `Change Order Log`.

- [ ] **Step 6: Keep synthetic parser tests green**

Update `external-import-parser.test.ts` synthetic Draw Invoice test headers to the accepted real names:

```ts
{
  name: "Draw Invoice List",
  rows: [
    ["Draw Date", "Vendor Name", "Invoice #", "Total"],
    ["2026-04-02", "Apex", "INV-1", 100],
  ],
},
{
  name: "Transfer Log",
  rows: [
    ["Draw Date", "Description", "Deduct", "Credit", "Total"],
    ["2026-04-02", "Move budget", "", "", "$200"],
  ],
},
{
  name: "Change Order Log",
  rows: [
    ["Change Order Date Submitted (Draw Date)", "Description", "Approved Change Orders"],
    ["2026-04-02", "CO work", "$300"],
  ],
},
```

Keep the expected source roles and amount totals unchanged.

- [ ] **Step 7: Verify parser remediation**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/external-import-parser.test.ts \
  src/__tests__/external-import-real-fixtures.test.ts \
  src/__tests__/external-import-api.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit parser remediation**

```bash
git add \
  excel-master-app/src/lib/external-import/source-detection.ts \
  excel-master-app/src/lib/external-import/workbook-parser.ts \
  excel-master-app/src/__tests__/external-import-parser.test.ts \
  excel-master-app/src/__tests__/external-import-real-fixtures.test.ts
git commit -m "fix: accept external import staging workbooks"
```

## Task 3: Role Smoke Evidence

**Files:**
- Modify: `docs/superpowers/evidence/2026-04-27-external-import-staging-acceptance-evidence.md`
- Create: `docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md`

- [ ] **Step 1: Prepare staging accounts and config**

Record these values outside git:

```text
Reader email:
Commenter email:
Collaborator email:
Staging spreadsheet id:
EXTERNAL_IMPORT_WORKER_URL:
EXTERNAL_IMPORT_WORKER_SECRET configured in app env: yes/no
EXTERNAL_IMPORT_WORKER_SECRET configured in worker env: yes/no
```

Do not commit emails if they are private. In evidence, redact them as:

```text
reader:redacted-domain
commenter:redacted-domain
collaborator:redacted-domain
```

- [ ] **Step 2: Run unauthenticated API smoke**

Run:

```bash
export STAGING_SPREADSHEET_ID="actual-staging-spreadsheet-id"

curl -s -o /tmp/external_import_status_unauth.json -w '%{http_code}' \
  "http://localhost:3000/api/external_import/status?spreadsheet_id=${STAGING_SPREADSHEET_ID}"

curl -s -o /tmp/external_import_preview_unauth.json -w '%{http_code}' \
  -X POST "http://localhost:3000/api/external_import/preview" \
  -H "Content-Type: application/json" \
  --data "{\"spreadsheet_id\":\"${STAGING_SPREADSHEET_ID}\",\"files\":[]}"
```

Expected:

```text
401
401
```

- [ ] **Step 3: Run reader/commenter browser smoke**

With reader and commenter sessions in the browser:

```text
1. Open http://localhost:3000/?spreadsheetId=actual-staging-spreadsheet-id
2. Confirm external import status panel is visible.
3. Confirm text is visible: Reader/Commenter 只能查看导入状态，不能上传。
4. Confirm file input "选择外部导入文件" is not visible.
5. Confirm "预览导入" and "确认导入" buttons are not visible.
```

Evidence to capture:

```text
Screenshot: docs/superpowers/evidence/2026-04-27-external-import-reader-smoke.png
Screenshot: docs/superpowers/evidence/2026-04-27-external-import-commenter-smoke.png
```

- [ ] **Step 4: Run collaborator preview/confirm smoke**

With collaborator session:

```text
1. Open http://localhost:3000/?spreadsheetId=actual-staging-spreadsheet-id
2. Select docs/Payable Report_20260427023857.xlsx.
3. Click 预览导入.
4. Confirm preview/status table shows semantic target zone external_import.payable_raw.
5. Confirm no physical coordinate such as L1/N1/S1/H1/G1 appears in the external import panel.
6. Click 确认导入.
7. Poll until status is succeeded or failed.
```

Evidence to capture:

```text
Screenshot before confirm: docs/superpowers/evidence/2026-04-27-external-import-collaborator-preview.png
Screenshot after confirm: docs/superpowers/evidence/2026-04-27-external-import-collaborator-status.png
```

- [ ] **Step 5: Capture durable rows**

Run Supabase queries using service role access and save redacted JSON:

```sql
select id, spreadsheet_id, job_type, operation, status, created_by, created_at, started_at, finished_at, result, error
from public.jobs
where operation = 'external_import'
order by created_at desc
limit 1;

select id, job_id, spreadsheet_id, status, imported_by, imported_at, result_meta, error
from public.external_import_manifests
order by imported_at desc
limit 1;

select manifest_id, source_table, source_file_name, source_sheet_name, row_count, column_count, amount_total,
       target_zone_key, resolved_zone_fingerprint, status, validation_message, schema_drift, error
from public.external_import_manifest_items
where manifest_id = 'actual-manifest-id-from-previous-query'
order by source_table;
```

Save as:

```text
docs/superpowers/evidence/2026-04-27-external-import-staging-durable-rows.json
```

Expected:

```text
jobs.status in ("succeeded", "failed")
external_import_manifests.status in ("validated", "failed")
external_import_manifest_items.target_zone_key contains external_import.*_raw
No sheet-resident manifest evidence.
```

- [ ] **Step 6: Write remediation evidence**

Create `docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md`:

```md
# External Import Staging Remediation Evidence

Date: 2026-04-27
Implementation base: `4af58d0`
Remediation commits:
- `worker-config-commit-sha`
- `parser-remediation-commit-sha`

## Release Gate

Status: NOT READY

## Worker Config

- `EXTERNAL_IMPORT_WORKER_URL`: missing
- `EXTERNAL_IMPORT_WORKER_SECRET` in app env: missing
- `EXTERNAL_IMPORT_WORKER_SECRET` in worker env: missing
- `/api/debug-env` external import readiness: failed

## Real File Parser Remediation

| File | Result |
| --- | --- |
| Payable Report | failed |
| Final Detail | failed |
| Unit Budget | failed |
| Draw request report | failed |
| Draw Invoice | failed |

## Role Smoke

| Role | Status visible | Upload disabled/enabled correctly | Evidence |
| --- | --- | --- | --- |
| Reader | no | no | not captured |
| Commenter | no | no | not captured |
| Collaborator | no | no | not captured |

## Durable Rows

- Job row evidence: `docs/superpowers/evidence/2026-04-27-external-import-staging-durable-rows.json`
- Manifest row present: no
- Manifest items present: no
- Validation result: failed

## Decision

Do not deploy yet
```

Replace every default `missing`, `failed`, `no`, `not captured`, and `Do not deploy yet` value only when the smoke evidence proves a stronger result.

- [ ] **Step 7: Verify and commit role evidence**

Run:

```bash
rg -n '<[^>]+>' docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md
```

Expected: no matches.

Commit:

```bash
git add docs/superpowers/evidence/2026-04-27-external-import-*.png \
  docs/superpowers/evidence/2026-04-27-external-import-staging-durable-rows.json \
  docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md
git commit -m "docs: add external import staging remediation evidence"
```

## Task 4: Final Verification Gate

**Files:**
- No production files unless earlier tasks fail.

- [ ] **Step 1: Run focused frontend/backend tests**

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/external-import-api.test.ts \
  src/__tests__/external-import-parser.test.ts \
  src/__tests__/external-import-real-fixtures.test.ts \
  src/__tests__/import-zone-resolver.test.ts \
  src/__tests__/import-manifest-service.test.ts \
  src/__tests__/job-service.test.ts \
  src/__tests__/workbench-phase1.test.tsx \
  src/__tests__/deployment-config.test.ts
```

Expected: all suites pass.

- [ ] **Step 2: Run worker and audit safety tests**

```bash
python3 -m pytest \
  tests/test_external_import_worker.py \
  tests/test_formula_sync_no_physical_addresses.py \
  tests/test_109_manual_controls.py \
  tests/test_payable_final_detail_classification.py -q
```

Expected: all tests pass.

- [ ] **Step 3: Run TypeScript and audit scans**

```bash
cd excel-master-app
npx tsc --noEmit --pretty false
node scripts/generate_reclass_rules.mjs --check
```

Expected: both commands exit 0.

```bash
rg -n '\b[A-Z]{1,3}\$?[0-9]+\b|![A-Z]{1,3}:|![A-Z]{1,3}\$?\d' \
  excel-master-app/src/lib/external-import \
  excel-master-app/src/pages/api/external_import \
  excel-master-app/api/logic/aiwb_finance/external_import_worker.py \
  --glob '!**/*.test.*'
```

Expected: no output.

```bash
rg -n "AiWB_External_Import_Manifest|hidden Google Sheet|Supabase mirroring|Supabase mirror|mirror later|Sheet[- ]resident.*manifest|Raw write start|target_range|offset ranges" \
  excel-master-app/src \
  excel-master-app/api \
  docs/superpowers/specs/2026-04-27-external-data-import-design.md \
  docs/superpowers/plans/2026-04-27-external-import-permission-durable-jobs.md \
  docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md \
  --glob '!**/*.test.*'
```

Expected: no output.

- [ ] **Step 4: Stop if staging evidence is not green**

If `docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md` says `NOT READY`, do not push, PR, or deploy. Create a follow-up remediation note instead.

- [ ] **Step 5: Commit final verification note only if green**

If staging evidence says `READY FOR PR`, commit any final evidence-only update:

```bash
git add docs/superpowers/evidence/2026-04-27-external-import-staging-remediation-evidence.md
git commit -m "docs: mark external import staging remediation accepted"
```

## Self-Review

- Scope is limited to worker config, real-file parser blockers, and role smoke.
- No task introduces a new architecture layer.
- No task adds a Sheet-resident manifest.
- No task uses hardcoded target coordinates.
- The only deploy decision allowed by this plan is gated by updated staging evidence.
