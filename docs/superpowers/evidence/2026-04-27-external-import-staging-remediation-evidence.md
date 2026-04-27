# External Import Staging Remediation Evidence

Date: 2026-04-27
Branch: `feat-audit-workbench-phase1`
Remediation commit: `10022f6 fix: remediate external import staging blockers`

## Release Gate

Status: **NOT READY FOR PRODUCTION DEPLOY**

Reason: remediation code and focused automated acceptance are green, but the local/staging environment still lacks `EXTERNAL_IMPORT_WORKER_URL` and `EXTERNAL_IMPORT_WORKER_SECRET`. Live collaborator confirm, durable Supabase row capture, and authenticated reader/commenter browser screenshots remain pending until worker config and staging sessions are available.

## Worker Config Readiness

Local `.env.local` presence check:

| Variable | Result |
| --- | --- |
| `NEXTAUTH_URL` | present |
| `NEXT_PUBLIC_SUPABASE_URL` | present |
| `SUPABASE_SERVICE_ROLE_KEY` | present |
| `EXTERNAL_IMPORT_WORKER_URL` | missing |
| `EXTERNAL_IMPORT_WORKER_SECRET` | missing |

Code remediation:

- Deploy/env-sync required key lists now include `EXTERNAL_IMPORT_WORKER_URL` and `EXTERNAL_IMPORT_WORKER_SECRET`.
- `/api/debug-env` exposes only boolean readiness flags: `hasExternalImportWorkerUrl` and `hasExternalImportWorkerSecret`.
- Preview/status responses include `worker_configured`.
- UI disables `确认导入` when the worker is not configured, while keeping status/preview paths available.

Production fallback:

- If the worker URL/secret are omitted, confirm is unavailable.
- Existing audit, reclassify, formula sync, and status viewing flows do not depend on the external import worker config.

## Real File Parser Remediation

Focused test:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/external-import-parser.test.ts \
  src/__tests__/external-import-real-fixtures.test.ts
```

Result: 2 suites / 20 tests passed.

Real file acceptance:

| File | Result |
| --- | --- |
| Payable Report | passed |
| Final Detail | passed; blank `Posting Date 1` is warning-only |
| Unit Budget | passed; `LS Fronterra` budget matrix detected |
| Draw request report | passed; only `Draw request report` sheet imported |
| Draw Invoice | passed; three real sheets detected |

Parser policy confirmed:

- Extra or missing non-critical columns are warning-only.
- Blank nullable date/amount cells are warning-only.
- Invalid nonblank dates/amounts remain blocking.
- Preview metadata uses semantic zone keys such as `external_import.payable_raw`.
- No physical write coordinates are used for external import preview metadata.

## Role Smoke Coverage

Automated UI/API coverage:

| Gate | Evidence |
| --- | --- |
| Reader/commenter can view status but not upload | `workbench-phase1.test.tsx` readonly external import test |
| Collaborator can preview and confirm when configured | `workbench-phase1.test.tsx` writable collaborator test |
| Worker not configured disables confirm | `workbench-phase1.test.tsx` worker fallback test |
| Preview/status API require auth | `external-import-api.test.ts` |
| Preview/confirm require collaborator access | `external-import-api.test.ts` |

Live browser evidence pending:

- Reader screenshot
- Commenter screenshot
- Collaborator preview screenshot
- Collaborator status-after-confirm screenshot

## Durable Job And Manifest Coverage

Automated API coverage:

| Gate | Evidence |
| --- | --- |
| Confirm creates durable `external_import` job | `external-import-api.test.ts` |
| Worker result persists manifest and items | `external-import-api.test.ts` |
| Validation failure marks job/manifest/item failed | `external-import-api.test.ts` |
| Failed validation preserves persisted item evidence | `external-import-api.test.ts` |

Live Supabase evidence pending:

- `jobs` row
- `external_import_manifests` row
- `external_import_manifest_items` rows
- validation result JSON
- partial-upload retained-table evidence
- intentional validation-failure evidence

## Verification

Focused remediation verification:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/deployment-config.test.ts \
  src/__tests__/external-import-parser.test.ts \
  src/__tests__/external-import-real-fixtures.test.ts \
  src/__tests__/external-import-api.test.ts \
  src/__tests__/workbench-phase1.test.tsx
```

Result: 5 suites / 90 tests passed.

## Decision

Do not deploy to production yet.

Next action: configure staging `EXTERNAL_IMPORT_WORKER_URL` and `EXTERNAL_IMPORT_WORKER_SECRET`, then rerun live role smoke and durable-row capture. Architecture upgrade remains explicitly out of scope until this staging remediation gate is accepted.
