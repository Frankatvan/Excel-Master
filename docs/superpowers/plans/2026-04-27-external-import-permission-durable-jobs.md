# External Import, Permission, And Durable Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship external database import safely by building on the completed Drive/Sheet permission refactor and the durable-job upgrade path.

**Architecture:** Treat Drive permissions as the only project ACL, use Supabase `projects` as the project directory, and put every write-heavy workflow behind collaborator guards plus project run locks. External import becomes the next durable job type (`external_import`), but it must write through semantic import zones rather than hardcoded spreadsheet coordinates. Supabase is the single source of truth for job and import manifest state.

**Tech Stack:** Next.js Pages API, React workbench page, NextAuth, Supabase service-role client, Google Drive/Sheets APIs, `xlsx`, Python workers where existing sheet operations already live, Jest/ts-jest, pytest, Supabase durable jobs and import manifest tables.

---

## Current Evidence

Permission refactor appears broadly complete for the existing app surface:

- `excel-master-app/src/lib/project-access.ts` exists with `getProjectAccess`, `requireProjectAccess`, `requireProjectCollaborator`, and `requireDriveOwner`.
- Login now uses registered project Sheet permissions through `verifyAnyProjectAccess`.
- Project list filters Supabase `projects` rows through Drive permissions.
- Existing read APIs call `requireProjectAccess`.
- Existing write/workflow APIs call `requireProjectCollaborator`, except unlock uses `requireDriveOwner`.
- Focused verification passed: `npm test -- --runInBand --runTestsByPath src/__tests__/project-access.test.ts src/__tests__/projects-list-api.test.ts src/__tests__/projects-state-api.test.ts src/__tests__/projects-action-api.test.ts src/__tests__/audit-api-routes.test.ts src/__tests__/formula-live-api.test.ts src/__tests__/reclassify-api.test.ts`
- Result: 7 suites passed, 89 tests passed.

External workbook parser evidence:

- Node `xlsx` successfully reads the five real source workbooks.
- `Payable Report_20260427023857.xlsx`: one `Payable` sheet with 15,512 rows and 38 columns.
- `LS Fronterra_Budget.xlsx`: one budget matrix sheet with 111 rows and 206 columns.
- `LS Fronterra - Final Detail - 20260427.xlsx`: one final-detail sheet with 31,554 rows and 22 columns.
- `_Draw request report_2026-04-27.xlsx`: 206 sheets; only the exact `Draw request report` sheet is eligible for import.
- `Draw Invoice.xlsx`: `Draw Invoice List`, `Transfer Log`, `Change Order Log`.

## Integrated Scope Decision

The import feature should not be built as a one-off upload endpoint. It should be the first practical consumer of the durable-job foundation because it is large, write-heavy, user-visible, and needs parse/write/validate progress.

## Evaluator Remediation Matrix

This plan incorporates the 2026-04-27 external import audit findings as blocking governance requirements.

| Audit finding | Plan correction | Verification hook |
| --- | --- | --- |
| Physical address dependency | Import targets are semantic zones, resolved at runtime from metadata and returned as structured ranges. Business logic must not contain literal spreadsheet coordinates for import target writes. | Parser and worker tests fail if production import modules contain literal spreadsheet coordinates for target writes. |
| Split source of truth for import state | Supabase durable jobs and import manifest tables are the only source of truth. Google Sheet status views are out of MVP and may only be read-only projections rebuilt from Supabase. | Job-service and manifest tests assert job/manifest linkage in Supabase; docs state Supabase as source of truth. |
| Reclassification rule double source | Python and TypeScript rule registries are generated from one canonical YAML before import implementation begins. | Phase 1 drift tests must pass before Phase 2 begins. |

## Governance Contracts

### Semantic Import Zone Contract

Import code addresses workbook destinations by logical zone keys. The zone resolver is the only module that may translate a logical zone key into Google Sheets API grid coordinates, and those coordinates must come from workbook metadata, not hardcoded source constants.

Required zone metadata fields:

| Field | Meaning |
| --- | --- |
| `zone_key` | Logical key such as `external_import.payable_raw` |
| `sheet_role` | Logical sheet role such as `Payable` or `Final Detail` |
| `source_role` | Import source role that is allowed to write into the zone |
| `managed_by` | Must be `AiWB` |
| `schema_version` | Metadata schema version |
| `capacity_policy` | How the zone handles source width drift |
| `header_signature_policy` | Required semantic header behavior for the zone |
| `grid_fingerprint` | Hash of resolved sheet id and zone boundaries, used only for audit comparison |

Allowed capacity policies:

| Policy | Behavior |
| --- | --- |
| `expand_within_managed_sheet` | Additional non-key columns can expand the managed zone if the sheet has capacity and no protected/system region is crossed |
| `fixed_capacity` | Additional columns block confirm with a capacity error |
| `metadata_backfill_required` | Existing workbook has no trustworthy zone metadata and must be backfilled before import |

### Supabase Import Manifest Contract

Import state belongs to Supabase. The job row describes execution state, while manifest rows describe imported source versions and validation outcomes.

Required manifest entities:

| Entity | Responsibility |
| --- | --- |
| `jobs` | Durable execution state for `external_import` |
| `external_import_manifests` | One import attempt, linked to one job |
| `external_import_manifest_items` | One detected source role within that import attempt |

Required item status values:

```text
parsed
warning
imported
validated
failed
stale
```

The UI must read latest import status from Supabase. It must not infer status from any Sheet-resident status table.

### Source Schema Drift Contract

Import preview must compare source workbooks by semantic fields, not by absolute column position or total column count.

Each source role has a schema contract with these field classes:

| Field class | Meaning | Drift behavior |
| --- | --- | --- |
| `required_semantic_fields` | Fields needed to identify the source role, preserve row identity, calculate totals, write raw data, or run validation | Missing, ambiguous, or low-confidence matches block confirm |
| `optional_known_fields` | Fields the workbench recognizes but can safely import without | Missing fields create a warning only |
| `passthrough_fields` | Extra source columns that are not part of the canonical contract | Preserved in raw import output when the semantic zone capacity policy permits expansion |
| `ignored_fields` | Fields intentionally excluded from import | Reported in preview only when useful for diagnostics |

Preview outcomes:

| Source drift | Preview status | Confirm allowed? | Write behavior |
| --- | --- | --- | --- |
| Extra non-key column | `warning` | Yes, if the zone can expand safely | Write the source header and values into the managed raw zone |
| Missing non-key column | `warning` | Yes | Write remaining source columns; manifest records missing optional field |
| Column order changed | `warning` or clean | Yes | Reorder by detected header semantics before write if the target schema requires canonical order |
| Required field renamed with known alias | `warning` | Yes | Normalize to canonical semantic field id |
| Required field missing | `blocking` | No | No Sheet write |
| Required amount/date field unparsable | `blocking` | No | No Sheet write |
| Ambiguous source role or duplicate required headers | `blocking` | No | No Sheet write |
| Extra column exceeds zone capacity | `blocking` | No | No Sheet write; operator sees capacity/backfill message |

Manifest item rows must persist schema drift diagnostics in `result_meta` or an adjacent `schema_drift` JSON field so a later operator can tell whether an import succeeded cleanly or with tolerated source changes.

### CI Audit Scans

Add automated scans that fail the build if the import implementation violates governance:

```bash
rg -n "\\b[A-Z]{1,3}\\$?[0-9]+\\b|![A-Z]{1,3}:|![A-Z]{1,3}\\$?\\d" \
  excel-master-app/src/lib/external-import \
  excel-master-app/src/pages/api/external_import \
  excel-master-app/api/logic/aiwb_finance/external_import_worker.py \
  --glob '!**/*.test.*'
```

Expected: no matches in external import production code for hardcoded spreadsheet target coordinates.

```bash
FORBIDDEN_IMPORT_STATE_PATTERN="AiWB_External_Import_"'Manifest|Sheet[- ]resident.*manifest|Supabase.*mirror'
rg -n "$FORBIDDEN_IMPORT_STATE_PATTERN" \
  excel-master-app/src \
  excel-master-app/api \
  --glob '!**/*.test.*'
```

Expected: no matches in production code. Documentation reviews still check that Supabase remains the only authoritative store, but this production scan must not self-match against its own audit pattern.

```bash
cd excel-master-app
node scripts/generate_reclass_rules.mjs --check
```

Expected: generated Python and TypeScript rule registries are current.

Implementation order:

1. Finish permission acceptance and small gaps.
2. Eliminate the Python/TypeScript reclassification rule double source before adding another multi-table workflow.
3. Normalize the durable `jobs` table and add Supabase import manifest tables for `external_import`.
4. Add a semantic import-zone resolver and parser preview without writing Sheets.
5. Build confirmed import write through resolved semantic zones plus automatic `validate_input`.
6. Add UI entry points and manifest display.
7. After import stabilizes, continue the post-resilience plan for `audit_sync`, `formula_sync`, and `reclassify` durable cutovers.

## Files And Responsibilities

- Modify: `excel-master-app/src/lib/project-access.ts`
  - Add lightweight TTL cache only if test evidence shows Drive lookups are too expensive; keep current helper as ACL source.
- Modify: `excel-master-app/src/__tests__/project-access.test.ts`
  - Add cache and stale-permission tests if caching is introduced.
- Modify: `excel-master-app/supabase/migrations/20260427060000_create_jobs_table_if_missing.sql`
  - Extend the durable job shape to support `external_import`, heartbeat, created_by, operation, lock token, payload, result, and error.
- Modify: `excel-master-app/supabase/init_db.sql`
  - Align the baseline jobs shape with the current migration so fresh local environments do not get the older thin schema.
- Create: `excel-master-app/src/lib/job-service.ts`
  - Owns durable job creation, status updates, heartbeat, stale classification, and direct-path fallback flags.
- Create: `excel-master-app/src/__tests__/job-service.test.ts`
  - Tests job lifecycle, stale classification, missing-table tolerance during the transitional window, and rollback flag behavior.
- Create: `excel-master-app/contracts/reclass_rules.v1.yaml`
  - Canonical reclassification rule source.
- Create: `excel-master-app/scripts/generate_reclass_rules.mjs`
  - Generates Python and TypeScript rule registries from the canonical YAML.
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_services.py`
  - Consume generated Python rule registry.
- Modify: `excel-master-app/src/lib/reclass-rules.ts`
  - Consume generated TypeScript rule registry.
- Create: `excel-master-app/src/lib/external-import/source-detection.ts`
  - Detects source roles from workbook sheet names and headers.
- Create: `excel-master-app/src/lib/external-import/workbook-parser.ts`
  - Reads uploaded `.xlsx` buffers with `xlsx`, extracts the detected source ranges, normalizes values, computes row/column counts and amount totals.
- Create: `excel-master-app/src/lib/external-import/import-zone-resolver.ts`
  - Resolves logical source roles to semantic workbench import zones using template metadata, sheet role, header signatures, and protected-range metadata. Business logic must not contain literal spreadsheet coordinates.
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_engine.py`
  - During workbook bootstrap/layout control, attach semantic import-zone metadata to external import regions using developer metadata, named ranges, or managed protected-range descriptions.
- Create: `excel-master-app/api/logic/aiwb_finance/external_import_worker.py`
  - Owns import clear/write/manifest/validation sequencing for confirmed jobs and is the only Python module that writes external import data.
- Create: `excel-master-app/src/lib/external-import/import-manifest-service.ts`
  - Reads and writes Supabase import manifest rows keyed by durable job id and source table.
- Create: `excel-master-app/src/__tests__/external-import-parser.test.ts`
  - Tests source detection and semantic import-zone resolution with synthetic workbooks.
- Create: `excel-master-app/src/pages/api/external_import/preview.ts`
  - Authenticated collaborator-only endpoint that parses uploaded files and returns preview data without writing Google Sheets.
- Create: `excel-master-app/src/pages/api/external_import/confirm.ts`
  - Authenticated collaborator-only endpoint that confirms a preview and starts an `external_import` durable job.
- Create: `excel-master-app/src/pages/api/external_import/status.ts`
  - Authenticated project-access endpoint that returns job and manifest status.
- Create: `excel-master-app/src/__tests__/external-import-api.test.ts`
  - Tests ACLs, preview behavior, confirm behavior, and status behavior.
- Modify: `excel-master-app/api/project_bootstrap.py`
  - Reuse existing `validate_input` worker operation after import write success.
- Modify: `api/project_bootstrap.py`
  - Keep the root worker copy aligned if this deployment path is still active.
- Modify: `excel-master-app/src/pages/index.tsx`
  - Add upload/preview/confirm/status UI in the external data section.
- Modify: `excel-master-app/src/__tests__/workbench-phase1.test.tsx`
  - Add UI tests for import buttons, preview, partial upload, and reader-disabled write controls.
- Modify: `docs/auth-protocol.md`
  - Add external import as a collaborator-only write workflow.
- Create: `docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md`
  - Operator checklist for staging/prod import rollout.

## Phase 0: Permission Refactor Acceptance Gate

Objective: confirm the already-developed permission refactor is complete enough to support import.

- [ ] Run the focused permission test suite.

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/project-access.test.ts \
  src/__tests__/projects-list-api.test.ts \
  src/__tests__/projects-state-api.test.ts \
  src/__tests__/projects-action-api.test.ts \
  src/__tests__/audit-api-routes.test.ts \
  src/__tests__/formula-live-api.test.ts \
  src/__tests__/reclassify-api.test.ts
```

Expected: all suites pass.

- [ ] Manually review every route under `excel-master-app/src/pages/api` that accepts `spreadsheet_id`.

Required classification:

| Route class | Guard |
| --- | --- |
| Read/status/detail routes | `requireProjectAccess` |
| Write/workflow routes | `requireProjectCollaborator` |
| Unlock route | `requireDriveOwner` |
| Project creation/init route | authenticated user plus project registration rules |

- [ ] Add an explicit test for the new external import endpoints before those endpoints exist.

Expected initial result: failing tests because `/api/external_import/*` does not exist.

- [ ] Confirm `docs/auth-protocol.md` says external import is collaborator-only.

Expected: docs mention readers/commenters cannot trigger import.

Exit criteria:

- Existing permission tests pass.
- No project write route bypasses `requireProjectCollaborator`.
- New import API plan uses collaborator-only guards from the first test.

## Phase 1: Reclassification Rule Single Source Gate

Objective: remove rule-source drift before adding another workflow that depends on the same cross-table semantics.

- [ ] Write failing drift tests for the current Python and TypeScript rule registries.

Required assertions:

- Every rule id present in Python exists in TypeScript.
- Every rule id present in TypeScript exists in Python.
- Category, sheet scope, and operator-facing reason text are generated from one canonical source.
- Generated files are current.

- [ ] Create `excel-master-app/contracts/reclass_rules.v1.yaml`.

Required YAML fields per rule:

```yaml
id: R000
category: Excluded
sheet_scope:
  - Final Detail
reason_zh: Type 为 Sharing 的记录（仅限 Final Detail）排除在成本重分类之外
reason_en: Rows with Type='Sharing' (Final Detail only) are excluded from cost reclassification
```

- [ ] Create `excel-master-app/scripts/generate_reclass_rules.mjs`.

Expected generated outputs:

```text
excel-master-app/api/logic/aiwb_finance/generated_reclass_rules.py
excel-master-app/src/lib/generated-reclass-rules.ts
```

- [ ] Update Python and TypeScript consumers to import generated registries.

Required consumers:

```text
excel-master-app/api/logic/aiwb_finance/finance_services.py
excel-master-app/src/lib/reclass-rules.ts
```

- [ ] Run rule governance tests.

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/reclass-rules.test.ts
cd ..
python3 -m pytest tests/test_payable_final_detail_classification.py -q
```

Expected: generated rule registries are current and existing classification tests pass.

Exit criteria:

- Rule id, category, scope, and displayed reason have one authoritative source.
- Import work does not expand the system while rule semantics are still double-maintained.
- Phase 2 must not begin until this gate passes. If rule generation is deferred, this plan is not approved for import implementation.

## Phase 2: Durable Job Schema And Import Manifest Foundation

Objective: make the `jobs` contract strong enough for external import before migrating existing long tasks.

- [ ] Update `excel-master-app/supabase/migrations/20260427060000_create_jobs_table_if_missing.sql`.

Required canonical columns:

| Column | Type |
| --- | --- |
| `id` | `uuid primary key default gen_random_uuid()` |
| `project_id` | `uuid` |
| `spreadsheet_id` | `text` |
| `job_type` | `text` |
| `operation` | `text` |
| `status` | `text` |
| `lock_token` | `uuid` |
| `created_by` | `text` |
| `created_at` | `timestamptz` |
| `started_at` | `timestamptz` |
| `heartbeat_at` | `timestamptz` |
| `finished_at` | `timestamptz` |
| `progress` | `integer` |
| `payload` | `jsonb` |
| `result` | `jsonb` |
| `result_meta` | `jsonb` |
| `error` | `jsonb` |

Allowed statuses: `queued`, `running`, `succeeded`, `failed`, `stale`, `cancelled`.

- [ ] Add Supabase import manifest tables in the same migration or a later adjacent migration.

Required tables:

```sql
public.external_import_manifests
public.external_import_manifest_items
```

Required design:

- `external_import_manifests.job_id` references `public.jobs(id)`.
- `external_import_manifests.project_id` and `spreadsheet_id` match the durable job.
- `external_import_manifest_items.manifest_id` references `external_import_manifests(id)`.
- One item row represents one imported source role.
- Latest per-table status is queried from Supabase, not any Sheet-resident status table.

- [ ] Align `excel-master-app/supabase/init_db.sql` with the same job shape.

Expected: fresh local setup and production migrations no longer create incompatible jobs or manifest tables.

- [ ] Write failing tests in `excel-master-app/src/__tests__/job-service.test.ts` for:

Expected covered cases:

- `createJob` inserts `queued` job with `job_type: "external_import"`.
- `markJobRunning` sets `running`, `started_at`, and `heartbeat_at`.
- `heartbeatJob` updates `heartbeat_at` and `progress`.
- `markJobSucceeded` sets `succeeded`, `finished_at`, and result payload.
- `markJobFailed` stores structured error.
- stale classifier returns `stale` when `heartbeat_at` is older than the configured threshold.
- manifest creation links one import manifest to one durable job.
- manifest items are updated from `parsed` to `imported`, `validated`, or `failed` inside Supabase.
- `AIWB_DURABLE_JOBS_FORCE_DIRECT=1` disables new durable route behavior for existing routes, but not for MVP import once product requires import durability.

- [ ] Implement `excel-master-app/src/lib/job-service.ts`.

Expected public functions:

```ts
createJob(input)
markJobRunning(input)
heartbeatJob(input)
markJobSucceeded(input)
markJobFailed(input)
markJobCancelled(input)
classifyStaleJobs(input)
```

- [ ] Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/job-service.test.ts
```

Expected: pass.

Exit criteria:

- `external_import` has a durable job home.
- Existing post-resilience plan can reuse the same service for audit/formula/reclassify later.

## Phase 3: External Import Parser, Semantic Zones, And Preview

Objective: parse source workbooks safely and produce preview data without writing Sheets.

- [ ] Create synthetic workbook fixtures inside tests using `xlsx.utils.book_new()`.

Synthetic fixture coverage:

- Payable sheet with `GuId`, `Vendor`, `Invoice No`, `Amount`, `Cost State`.
- Final Detail sheet with `RowId`, `Final Amount`, `Posting Date 1`, `Unit Code`, `Cost Code`, `Vendor`.
- Unit Budget horizontal matrix.
- Draw request workbook with `Total`, `Address list`, `Draw request report`, and one unit sheet.
- Draw Invoice workbook with the three draw invoice sheets.

- [ ] Write failing parser tests.

Expected assertions:

- Payable resolves to the logical `external_import.payable_raw` zone.
- Final Detail resolves to the logical `external_import.final_detail_raw` zone.
- Unit Budget resolves to the logical `external_import.unit_budget_raw` zone.
- Draw request report resolves to the logical `external_import.draw_request_raw` zone and ignores all sheets except exact `Draw request report`.
- Draw Invoice List resolves to the logical `external_import.draw_invoice_list_raw` zone.
- Transfer Log resolves to the logical `external_import.transfer_log_raw` zone.
- Change Order Log resolves to the logical `external_import.change_order_log_raw` zone.
- Draw Invoice workbook exposes `Draw Invoice List`, `Transfer Log`, and `Change Order Log`.
- Amount totals ignore commas, currency symbols, and blank rows.
- Empty detected data rejects preview.
- Non-critical schema drift is warning-only: extra non-key columns, missing non-key columns, and column order changes do not block import when required semantic fields are still resolved with sufficient confidence.
- Critical semantic field drift is blocking: missing required fields, ambiguous source roles, low-confidence required field matches, or unparsable required amount/date fields disallow confirm.
- Tests fail if any production import module contains literal spreadsheet coordinates for target writes.

- [ ] Implement:

```text
excel-master-app/src/lib/external-import/source-detection.ts
excel-master-app/src/lib/external-import/workbook-parser.ts
excel-master-app/src/lib/external-import/import-zone-resolver.ts
```

- [ ] Implement semantic import-zone resolution.

Resolver requirements:

- Input is a source role and spreadsheet metadata.
- Output is a Google Sheets `GridRange` or equivalent structured range object, not a literal cell address string.
- The resolver may use sheet title, sheet role metadata, protected-range description, header signature, developer metadata, or named range metadata.
- The preferred source is explicit AiWB-managed zone metadata created during workbook bootstrap or layout control. Existing templates without metadata may be supported only by a migration/backfill step that writes metadata before import is enabled.
- Business logic must not embed fixed column letters or row numbers.
- If a zone cannot be resolved with high confidence, preview returns a blocking warning and confirm is disallowed.
- Resolved zones must support source-width drift. If a source workbook has additional non-key columns, the resolver either expands the structured write range safely or returns a blocking capacity error. It must not reject solely because the source column count differs from a previous import.

- [ ] Add semantic import-zone metadata during project bootstrap/layout control.

Required zone keys:

```text
external_import.payable_raw
external_import.final_detail_raw
external_import.unit_budget_raw
external_import.draw_request_raw
external_import.draw_invoice_list_raw
external_import.transfer_log_raw
external_import.change_order_log_raw
```

Expected behavior:

- New project workbooks get all import-zone metadata automatically.
- Existing project workbooks can be backfilled by a collaborator/owner-triggered maintenance action before import is enabled.
- Import preview blocks if required zone metadata is missing.

- [ ] Run synthetic parser tests.

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/external-import-parser.test.ts
```

Expected: pass.

- [ ] Add a local, non-CI parser evidence script or test command that can be run against the five real sample files under `docs/`.

Expected evidence:

- The script prints detected role, source sheet, row count, column count, amount total, and logical target zone.
- It must not write any workbook or Google Sheet.

Exit criteria:

- Parser works on synthetic fixtures and real sample files.
- Preview data has all fields required by the approved import design.

## Phase 4: Import Preview And Confirm APIs

Objective: add collaborator-gated API endpoints for upload preview, confirmation, and status.

- [ ] Write API tests in `excel-master-app/src/__tests__/external-import-api.test.ts`.

Required tests:

- Unauthenticated preview returns `401`.
- Reader/commenter preview returns `403 PROJECT_WRITE_FORBIDDEN`.
- Collaborator preview parses files and returns `preview_ready`.
- Preview does not call Google Sheets write APIs.
- Confirm requires a valid preview token or preview payload hash.
- Confirm creates `external_import` job.
- Status requires `requireProjectAccess`.
- A user without project access cannot poll an import job.
- Preview response contains logical target zone ids, not literal spreadsheet addresses.

- [ ] Implement `excel-master-app/src/pages/api/external_import/preview.ts`.

Behavior:

- Disable default body parser for multipart uploads.
- Extract `spreadsheet_id`.
- Call `requireProjectCollaborator(spreadsheet_id, actorEmail)`.
- Parse uploaded files.
- Return previews with source role, source sheet, row count, column count, amount total, header signature, file hash, semantic target zone id, and warnings.
- Mark non-critical schema drift as `warning` in preview and critical semantic drift as `blocking`.

- [ ] Implement `excel-master-app/src/pages/api/external_import/confirm.ts`.

Behavior:

- Call `requireProjectCollaborator`.
- Verify the preview hash.
- Create `external_import` durable job.
- Return `202` with `job_id` and status polling URL.

- [ ] Implement `excel-master-app/src/pages/api/external_import/status.ts`.

Behavior:

- Call `requireProjectAccess`.
- Return job status, progress, latest Supabase manifest entries, result, and error.

- [ ] Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/external-import-api.test.ts
```

Expected: pass.

Exit criteria:

- Import API cannot be used as an ACL bypass.
- Preview and confirm are separate steps.
- Confirm is durable and async.

## Phase 5: Import Worker, Sheet Write, Manifest, And Auto Validation

Objective: execute confirmed import jobs end to end.

- [ ] Add worker-side tests for clear/write/validate sequencing.

Required assertions:

- Only uploaded/detected tables are cleared.
- Non-uploaded external tables are untouched.
- Writes use resolved semantic import zones.
- Extra non-key source columns are written as part of the preserved raw source table when the semantic zone can safely contain them.
- Missing non-key source columns do not fail the job.
- Tests fail if worker write logic contains literal spreadsheet coordinates for import targets.
- `validate_input` runs after successful writes.
- Validation success marks manifest rows `validated` and clears `external_data_dirty`.
- Validation failure keeps imported data, marks manifest rows `failed`, and does not advance the stage.

- [ ] Implement import job execution using existing Google Sheets service-account writes.

Write rules:

- Clear the resolved semantic import zone for each imported table before writing.
- Write header and data as values.
- Use batch updates where possible.
- Preserve protected range structure.
- Do not write formulas.
- Do not compose spreadsheet address strings from literals in import business logic.

- [ ] Implement Supabase import manifest writer.

Required columns:

```text
manifest_id
job_id
project_id
spreadsheet_id
source_table
source_file_name
source_sheet_name
file_hash
header_signature
imported_at
imported_by
row_count
column_count
amount_total
target_zone_key
resolved_zone_fingerprint
status
validation_message
schema_drift
```

The Google Sheet must not be the authoritative store for import status. A generated Sheet-side status view can be added later only if it is rebuilt from Supabase.

- [ ] Reuse existing `validate_input` operation after successful sheet write.

Expected behavior:

- Successful write followed by successful validation returns `succeeded`.
- Successful write followed by validation failure returns `failed` with validation details.

- [ ] Add lock behavior.

Decision for import MVP:

- Acquire project lock when confirmed job starts running, not at preview time.
- Lock operation name: `external_import`.
- Concurrent import/reclassify/formula/audit write actions should return `409 PROJECT_RUN_LOCKED`.

- [ ] Run focused worker/API tests.

Expected: all import parser/API/worker tests pass.

Exit criteria:

- External import is safe for partial uploads.
- Validation is automatic after import.
- Import state is auditable through Supabase manifest and job rows.

## Phase 6: Workbench UI

Objective: expose the import flow without confusing it with manual Google Sheet editing.

- [ ] Add UI tests to `excel-master-app/src/__tests__/workbench-phase1.test.tsx`.

Required UI states:

- Reader/commenter can see import status but cannot upload.
- Collaborator can choose files.
- Preview shows detected table, file name, source sheet, row count, amount total, semantic target zone, and warnings.
- Confirm starts an import job.
- Polling shows parsing, writing, validating, succeeded, and failed states.
- Partial upload leaves other table statuses visible from the Supabase manifest.

- [ ] Implement UI in `excel-master-app/src/pages/index.tsx`.

Placement:

- Put import controls near the external data/workbench action area.
- Keep Google Sheet open button available.
- Keep current `validate_input` button, but after import success it should normally be redundant.

- [ ] Add concise copy.

Required copy:

- "只会替换本次识别到的外部表。未上传的表保留当前版本。"
- "导入成功后会自动验证录入数据。"
- "Reader/Commenter 只能查看导入状态，不能上传。"

- [ ] Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/workbench-phase1.test.tsx
```

Expected: pass.

Exit criteria:

- The UI makes partial upload and automatic validation explicit.
- Readers cannot trigger writes through the UI.

## Phase 7: Documentation And Rollout

Objective: make the feature operable in staging and production.

- [ ] Update `docs/auth-protocol.md`.

Required content:

- External import is a collaborator-only write workflow.
- Import status can be viewed by all project-access users.
- Drive owner is not required for import.
- Import status source of truth is Supabase durable job plus import manifest tables.

- [ ] Create `docs/superpowers/plans/2026-04-27-external-import-rollout-checklist.md`.

Checklist must include:

- Environment variables.
- Supabase migrations.
- Google service account permissions.
- Five real-file dry run.
- One partial-upload smoke test.
- One validation-failure smoke test.
- Rollback behavior.

- [ ] Run focused verification:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/project-access.test.ts \
  src/__tests__/external-import-parser.test.ts \
  src/__tests__/external-import-api.test.ts \
  src/__tests__/job-service.test.ts \
  src/__tests__/workbench-phase1.test.tsx
```

Expected: pass.

- [ ] Run broad verification:

```bash
cd excel-master-app
npm test -- --runInBand
npm run lint
npm run build
```

Expected: pass before production rollout.

Exit criteria:

- Staging operator can import all five files.
- Staging operator can import only Payable.
- Import success triggers validation automatically.
- Import validation failure blocks next-stage workflow.

## Phase 8: Continue Post-Resilience Durable Cutovers

Objective: resume the previous post-resilience plan after external import proves the durable job foundation.

Order:

1. Keep `external_import` as the first durable-only workflow.
2. Enable `AIWB_DURABLE_JOBS_SHADOW=1` for `audit_sync`, `formula_sync`, and `reclassify`.
3. Migrate `audit_sync` to durable jobs first.
4. Migrate `formula_sync` second.
5. Migrate `reclassify` last.
6. Add contract governance in warn-only mode.
7. Move contract governance to strict mode.
8. Keep generated reclassification rule registries under CI drift checks while durable cutovers proceed.

Carry-forward constraints from the post-resilience plan:

- Feature flags default off for existing flows.
- Direct-path rollback remains available.
- Permission errors stay `401`, `403`, or `404`.
- Project lock conflicts stay `409 PROJECT_RUN_LOCKED`.
- Worker errors do not hide access failures.

## Open Implementation Decisions

These decisions should be made before coding Phase 2:

1. Should uploaded import files be stored temporarily in memory, local `/tmp`, or Supabase Storage before confirmation?
   - Recommendation: local `/tmp` for MVP preview, with short expiration and preview hash. Avoid durable file storage until direct WBS/API integration is needed.
2. Should import preview reserve a project lock?
   - Recommendation: no. Preview is read-only. Confirmed write job acquires the lock when running.
3. Should duplicate file hash block import or warn?
   - Recommendation: warn by default, allow confirm with explicit user action.
4. Should import status have a Sheet-side read-only view for operator convenience?
   - Recommendation: not in MVP. Supabase durable job and import manifest tables are the only source of truth. A Sheet-side view can be generated later only as a read-only projection rebuilt from Supabase.

## Acceptance Checklist

- [ ] Permission refactor acceptance suite passes.
- [ ] Python and TypeScript reclassification rules are generated from one canonical source.
- [ ] Jobs schema is canonical and no longer split between thin and durable variants.
- [ ] Import parser handles synthetic fixtures and the five real source workbook shapes.
- [ ] Non-critical schema drift warns but does not block import.
- [ ] Critical semantic field drift blocks confirm.
- [ ] Import preview is collaborator-only and write-free.
- [ ] Import confirm creates an `external_import` job and returns `202`.
- [ ] Import worker writes only detected tables through resolved semantic import zones.
- [ ] Import success automatically runs `validate_input`.
- [ ] Validation success advances to `external_data_ready`.
- [ ] Validation failure preserves imported data but blocks next stage.
- [ ] Supabase manifest records latest version for each external table.
- [ ] Reader/commenter cannot upload or confirm imports.
- [ ] Durable job foundation remains reusable for audit/formula/reclassify cutovers.
