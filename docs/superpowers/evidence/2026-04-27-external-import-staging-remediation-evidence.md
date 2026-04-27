# External Import Staging Remediation Evidence

Date: 2026-04-27
Branch: `feat-audit-workbench-phase1`
Remediation commits:
- `10022f6 fix: remediate external import staging blockers`
- `597b8cd fix: enable external import worker endpoint`
- `07c582b fix: expose external import worker handler`

## Release Gate

Status: **NOT READY FOR PRODUCTION DEPLOY**

Reason: remediation code, worker endpoint build, and focused automated acceptance are green, and local/Preview worker env keys are now present. The live staging acceptance pass is still blocked before durable persistence:

- Supabase is missing `jobs`, `external_import_manifests`, and `external_import_manifest_items` in the schema cache.
- A previous collaborator confirm attempt failed before job creation because the staging spreadsheet lacks AiWB semantic import zone metadata for source role `payable`.
- A fresh CLI Preview deployment is `READY`, but this environment cannot connect to the `*.vercel.app` preview URL, so fresh live API/browser smoke could not be completed against that deployment.
- The staging Drive permissions inspected for `GOOGLE_SHEET_ID` include writer/organizer/fileOrganizer users only; no reader/commenter accounts are available for live readonly browser smoke.

## Worker Config Readiness

Acceptance pass on 2026-04-27:

| Check | Result |
| --- | --- |
| Local `.env.local` `NEXTAUTH_URL` | present |
| Local `.env.local` `NEXT_PUBLIC_SUPABASE_URL` | present |
| Local `.env.local` `SUPABASE_SERVICE_ROLE_KEY` | present |
| Local `.env.local` `EXTERNAL_IMPORT_WORKER_URL` | present |
| Local `.env.local` `EXTERNAL_IMPORT_WORKER_SECRET` | present |
| Vercel Preview branch env `EXTERNAL_IMPORT_WORKER_URL` | synced for `feat-audit-workbench-phase1` |
| Vercel Preview branch env `EXTERNAL_IMPORT_WORKER_SECRET` | synced for `feat-audit-workbench-phase1` |
| CLI Preview deployment | `READY`: `https://excel-master-fkexvbpcy-frankatvans-projects.vercel.app` |
| Local connectivity to Preview deployment | blocked: curl cannot connect to `*.vercel.app` from this environment |
| Production custom domain `/api/debug-env` | reachable, but still old production deployment without new external import debug fields |

Code remediation:

- Deploy/env-sync required key lists now include `EXTERNAL_IMPORT_WORKER_URL` and `EXTERNAL_IMPORT_WORKER_SECRET`.
- `/api/debug-env` exposes only boolean readiness flags: `hasExternalImportWorkerUrl` and `hasExternalImportWorkerSecret`.
- Preview/status responses include `worker_configured`.
- UI disables `确认导入` when the worker is not configured, while keeping status/preview paths available.

Production fallback:

- If the worker URL/secret are omitted, confirm is unavailable.
- Existing audit, reclassify, formula sync, and status viewing flows do not depend on the external import worker config.

Current acceptance note:

- `.env.local` now contains `EXTERNAL_IMPORT_WORKER_URL` and `EXTERNAL_IMPORT_WORKER_SECRET`.
- Vercel CLI Preview build/deploy succeeded from `excel-master-app`.
- The earlier Git-triggered Preview deploy failed because Vercel used the repository root package/build path; the CLI Preview deploy used the correct app root.

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

Live browser/API evidence from this pass:

| Role | Result | Evidence |
| --- | --- | --- |
| Reader | blocked; no Drive reader permission found for staging spreadsheet | permission scan showed no reader account |
| Commenter | blocked; no Drive commenter permission found for staging spreadsheet | permission scan showed no commenter account |
| Collaborator | passed readonly/write-control visibility; upload, preview, and confirm controls visible for writer session | `docs/superpowers/evidence/2026-04-27-external-import-collaborator-smoke.png` |

Real collaborator API smoke:

| Step | Result |
| --- | --- |
| OTP credential login | HTTP `200`; session authenticated |
| Payable Report preview | HTTP `200`; `status=preview_ready`, `confirm_allowed=true`, `worker_configured=true` |
| Confirm | HTTP `500`; `IMPORT_ZONE_NOT_FOUND:No AiWB semantic import zone metadata found for source role payable.` |

Confirm did not create a job or manifest id. This collaborator smoke was captured before the worker endpoint wrapper fix; it is still useful for the semantic-zone blocker, but it does not prove the latest Preview deployment is browser-accessible from this environment.

## Durable Job And Manifest Coverage

Automated API coverage:

| Gate | Evidence |
| --- | --- |
| Confirm creates durable `external_import` job | `external-import-api.test.ts` |
| Worker result persists manifest and items | `external-import-api.test.ts` |
| Validation failure marks job/manifest/item failed | `external-import-api.test.ts` |
| Failed validation preserves persisted item evidence | `external-import-api.test.ts` |

Live Supabase evidence from this pass:

Evidence artifacts:
- `docs/superpowers/evidence/2026-04-27-external-import-staging-durable-rows.json`
- `docs/superpowers/evidence/2026-04-27-external-import-staging-supabase-current.json`

| Table | Result |
| --- | --- |
| `projects` | previously reachable; 4 rows |
| `email_login_otps` | previously reachable; 2 rows before test OTP reseed |
| `jobs` | missing; Supabase `PGRST205` schema-cache error |
| `external_import_manifests` | missing; Supabase `PGRST205` schema-cache error |
| `external_import_manifest_items` | missing; Supabase `PGRST205` schema-cache error |

Durable row capture remains blocked:

- No `jobs` row was created.
- No `external_import_manifests` row was created.
- No `external_import_manifest_items` rows were created.
- Partial-upload retained-table evidence and intentional validation-failure evidence cannot be run until confirm can create durable rows.

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

Fresh result from this pass: 5 suites / 90 tests passed.

Worker endpoint verification:

```bash
python3 -m pytest tests/test_external_import_worker.py -q
cd excel-master-app
npx --yes vercel@52.0.0 build
```

Result:

- Python worker tests: 11 passed.
- Vercel local build: completed successfully.
- CLI Preview deployment: ready.

## Decision

Do not deploy to production yet.

Next actions before rerun:

1. Apply or repair the staging Supabase durable job/import manifest tables.
2. Backfill AiWB semantic import zone developer metadata on the staging spreadsheet for at least `external_import.payable_raw`.
3. Use an accessible Preview or controlled custom staging domain for fresh live API/browser smoke.
4. Provide or grant reader/commenter staging permissions, then rerun readonly browser smoke.

Architecture upgrade remains explicitly out of scope until this staging remediation gate is accepted.
