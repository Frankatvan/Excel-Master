# External Import Staging Acceptance Evidence

Date: 2026-04-27
Branch: `feat-audit-workbench-phase1`
Implementation commit: `4af58d0 feat: implement durable external import flow`

## Release Gate

Status: **NOT READY FOR PRODUCTION DEPLOY**

Reason: code verification passed, but staging acceptance is blocked by missing worker configuration and real-file pre-write blockers. The current evidence supports keeping the feature behind the release gate until a staging dry run produces durable `jobs`, `external_import_manifests`, `external_import_manifest_items`, and validation results.

## Scope Isolation

`4af58d0` is the durable external import implementation commit. It contains the external import preview/confirm/status API, preview store, workbook parser row capture, durable job/manifest persistence helpers, worker skeleton, UI import panel, tests, and rollout documentation.

Evidence command:

```bash
git show --stat --oneline --name-status 4af58d0
```

Scope observation:

- The implementation commit is external-import focused and does not require bundling the dirty workspace into another commit.
- The broader branch also contains earlier foundation commits for import auth, durable jobs, semantic zones, and generated reclass rule governance.
- The current workspace still has unrelated pre-existing uncommitted changes; these must remain out of any release evidence or deployment commit.

## Local Browser / API Smoke

Local app:

- URL: `http://localhost:3000`
- Result: HTTP `200 OK`
- Screenshot: `docs/superpowers/evidence/2026-04-27-external-import-local-login.png`

Observed UI state:

- Unauthenticated browser lands on the login page.
- External import panel is behind authenticated project access and cannot be smoke-tested through UI without reader/commenter/collaborator staging accounts.

API auth smoke:

| Endpoint | Request | Result |
| --- | --- | --- |
| `/api/external_import/status` | unauthenticated GET | `401 {"error":"未登录"}` |
| `/api/external_import/preview` | unauthenticated POST | `401 {"error":"未登录"}` |

Conclusion:

- Unauthenticated access is blocked.
- Role-specific browser checks remain pending until staging accounts are available.

## Real-File Preview Dry Run

Input files:

- `docs/Payable Report_20260427023857.xlsx`
- `docs/LS Fronterra - Final Detail - 20260427.xlsx`
- `docs/LS Fronterra_Budget.xlsx`
- `docs/_Draw request report_2026-04-27.xlsx`
- `docs/Draw Invoice.xlsx`

Evidence artifacts:

- Full parser evidence: `docs/superpowers/evidence/2026-04-27-external-import-real-file-preview.json`
- Summary evidence: `docs/superpowers/evidence/2026-04-27-external-import-real-file-preview-summary.json`

Summary:

| File | Detected role(s) | Result |
| --- | --- | --- |
| Payable Report | `payable` | Detected, no blocking issues |
| Final Detail | `final_detail` | Detected, blocked by invalid blank `Posting Date 1` values |
| Unit Budget | none | **Blocked: not detected** |
| Draw request report | `draw_request` | Detected, no blocking issues; only target sheet imported |
| Draw Invoice | `draw_invoice_list`, `transfer_log`, `change_order_log` | Detected, blocked by missing required columns |

Preview conclusion:

- `confirm_allowed=false`
- Detected roles: `payable`, `final_detail`, `draw_request`, `draw_invoice_list`, `transfer_log`, `change_order_log`
- Missing expected role: `unit_budget`
- Logical target zones are used, for example `external_import.payable_raw`, `external_import.final_detail_raw`, and `external_import.draw_request_raw`.
- No physical spreadsheet coordinates are present in preview evidence.

## Staging Environment Readiness

Evidence artifact:

- `docs/superpowers/evidence/2026-04-27-external-import-env-and-db-check.json`

Observed:

| Check | Result |
| --- | --- |
| Supabase URL | present |
| Supabase service role key | present |
| Google Sheet ID | present |
| Google client email | present |
| `EXTERNAL_IMPORT_WORKER_URL` | **missing** |
| `EXTERNAL_IMPORT_WORKER_SECRET` | **missing** |
| `jobs` table | reachable |
| `external_import_manifests` table | reachable |
| `external_import_manifest_items` table | reachable |
| `projects` table | reachable |

Conclusion:

- Database foundation is reachable.
- Confirm path cannot complete staging worker dispatch until worker URL and secret are configured.

## Verification Already Passed

Code-level verification on merged branch:

```bash
npm test -- --runInBand --runTestsByPath \
  src/__tests__/external-import-api.test.ts \
  src/__tests__/external-import-parser.test.ts \
  src/__tests__/import-zone-resolver.test.ts \
  src/__tests__/import-manifest-service.test.ts \
  src/__tests__/job-service.test.ts \
  src/__tests__/workbench-phase1.test.tsx \
  src/__tests__/deployment-config.test.ts \
  src/__tests__/reclass-rules-governance.test.ts
```

Result: 8 suites / 98 tests passed.

```bash
python3 -m pytest \
  tests/test_external_import_worker.py \
  tests/test_formula_sync_no_physical_addresses.py \
  tests/test_109_manual_controls.py \
  tests/test_payable_final_detail_classification.py -q
```

Result: 30 passed.

Additional checks:

- `npx tsc --noEmit --pretty false`: passed
- `git diff --check`: passed
- `node scripts/generate_reclass_rules.mjs --check`: passed
- external import physical-coordinate scan: no production hits
- hidden workbook manifest / mirror-language scan: no production hits

## Pending Acceptance Items

Required before PR/deploy:

1. Provide authenticated staging accounts or sessions for:
   - Reader
   - Commenter
   - Collaborator / writer
2. Configure:
   - `EXTERNAL_IMPORT_WORKER_URL`
   - `EXTERNAL_IMPORT_WORKER_SECRET`
3. Fix or explicitly waive real-file pre-write blockers:
   - Unit Budget workbook is not detected.
   - Final Detail has blank/invalid `Posting Date 1` values under current required-date rules.
   - Draw Invoice workbook tables are detected but fail required-column checks.
4. Run staging confirm path and capture:
   - `jobs` row
   - `external_import_manifests` row
   - `external_import_manifest_items` rows
   - validation result
   - partial-upload retained-table behavior
5. Run an intentional validation failure and capture:
   - job status `failed`
   - manifest item status/error
   - retained imported data
   - no next-stage advancement

## Recommendation

Do not deploy yet. Treat this evidence as the release gate record for the current implementation. The next engineering move should be a staging acceptance pass after worker configuration and real-file parser/blocking issues are addressed or formally waived.
