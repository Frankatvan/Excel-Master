# External Import Rollout Checklist

Date: 2026-04-27

## Preflight
- [ ] Confirm env vars are present in production and worker environments:
  - [ ] `SUPABASE_URL`
  - [ ] `SUPABASE_SERVICE_ROLE_KEY`
  - [ ] `GOOGLE_SERVICE_ACCOUNT_EMAIL`
  - [ ] `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
  - [ ] `EXTERNAL_IMPORT_WORKER_SECRET`
  - [ ] External import storage/bucket settings if durable file storage is enabled beyond the MVP JSON/base64 preview path.
- [ ] Apply Supabase migrations for durable import jobs, manifests, table statuses, warnings, blocking items, and audit log linkage.
- [ ] Verify Google service account permissions on the target Drive folders and project spreadsheets.
- [ ] Confirm Drive owner is not required for collaborator write flows; writer/collaborator access is enough.

## Dry Runs
- [ ] Run five real-file dry runs against staging projects:
  - [ ] Payable
  - [ ] Final Detail
  - [ ] Draw Request report
  - [ ] Unit Budget
  - [ ] Mixed/partial upload set
- [ ] Verify each dry run writes a Supabase durable job and manifest.
- [ ] Verify manifest/status remains visible to Reader and Commenter accounts.
- [ ] Verify Collaborator can upload and confirm without Drive owner permissions.

## Smoke Tests
- [ ] Partial-upload smoke: upload one detected table and confirm other table statuses remain listed as retained/current.
- [ ] Validation-failure smoke: force a post-import validation failure and confirm warnings/blocking are visible in status.
- [ ] Status polling smoke: confirm `/api/external_import/status` reflects queued/running/succeeded/failed/partial transitions.
- [ ] Confirm successful imports automatically trigger validation of manual input data.

## Rollback
- [ ] Confirm rollback behavior for failed imports: previous table versions remain active for tables not successfully replaced.
- [ ] Confirm partial imports only replace detected uploaded tables and retain non-uploaded tables.
- [ ] Confirm failed durable jobs remain inspectable in Supabase manifests and do not erase previous status.
- [ ] Prepare rollback communication for finance users, including expected retained-table behavior and retry steps.
