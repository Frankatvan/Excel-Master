# External Data Import Design

Date: 2026-04-27
Status: Superseded for implementation by `docs/superpowers/plans/2026-04-27-external-import-permission-durable-jobs.md`

## Goal

Replace manual copy/paste of external database exports with a controlled import flow inside AiWB. The importer must support repeated partial uploads, write each source table into the correct semantic import zone, and automatically run input validation after each successful write.

## Background

The current workbench already separates internal AiWB calculation/classification columns from externally imported raw data columns. This means imports must not overwrite each sheet from the top-left corner. They must resolve and write to AiWB-managed semantic import zones from spreadsheet developer metadata.

| Source table | Semantic import zone |
| --- | --- |
| Payable | `external_import.payable_raw` |
| Final Detail | `external_import.final_detail_raw` |
| Unit Budget | `external_import.unit_budget_raw` |
| Draw request report | `external_import.draw_request_report_raw` |
| Draw Invoice List | `external_import.draw_invoice_list_raw` |
| Transfer Log | `external_import.transfer_log_raw` |
| Change Order Log | `external_import.change_order_log_raw` |

These managed zones are the main reason copy/paste is error-prone: the target is semantic to the system but easy for humans to misplace manually.

## Source Workbook Discovery

The importer identifies workbook contents by sheet names and required headers, with file names used only as hints.

| Import role | Source matching rule |
| --- | --- |
| Payable | Sheet like `Payable`; headers include `GuId`, `Vendor`, `Invoice No`, `Amount`, `Cost State` |
| Final Detail | Headers include `RowId`, `Final Amount`, `Posting Date 1`, `Unit Code`, `Cost Code`, `Vendor` |
| Unit Budget | A horizontal unit-budget matrix with `Total(...)`, unit-code columns, and cost-code/category rows |
| Draw request report | Exact sheet `Draw request report`; headers include `Sql`, `Draw Invoice`, `Unit Code`, `Invoiced No`, `Vendor`, `Amount` |
| Draw Invoice workbook | Sheets `Draw Invoice List`, `Transfer Log`, and `Change Order Log` |

For `_Draw request report_*.xlsx`, only the `Draw request report` sheet is imported. The `Total`, `Address list`, and individual unit sheets are ignored.

## Import Flow

1. User uploads one or more Excel files from the project page.
2. The backend creates an import job and parses each workbook.
3. The parser detects which import roles are present.
4. The UI shows a preview: source file, detected sheet, target zone, row count, column count, amount total, header signature, and validation warnings.
5. User confirms the import.
6. The backend resolves the semantic target zone from developer metadata and clears only that managed raw-data zone for each detected table.
7. The backend writes the parsed data into the matching semantic zone in Google Sheets.
8. The backend automatically runs the existing `validate_input` operation.
9. The project stage advances only if validation succeeds.

## Partial Upload Behavior

Users can upload any subset of source files. The importer replaces only the tables detected in the current upload and leaves all other external tables unchanged.

Examples:

| Upload contents | Behavior |
| --- | --- |
| Payable only | Replace Payable raw zone, keep Final Detail, Unit Budget, Draw request report as-is, then run full validation |
| Draw request report only | Replace only `Draw request report`, ignoring non-target workbook sheets, then run full validation |
| All five files | Replace every detected external table, then run full validation |

Validation always runs against the full current project state, not just the newly uploaded files. Failure messages must distinguish current-upload failures from existing-table missing, stale, or malformed data.

## Manifest

Each project keeps an external import manifest in Supabase durable job tables. The manifest and durable job record are a single logical truth source; the workbook must not contain a hidden workbook-local manifest, and there is no later secondary copy step.

Manifest fields:

| Field | Meaning |
| --- | --- |
| `project_id` | AiWB project id |
| `source_table` | Import role, such as Payable or Final Detail |
| `source_file_name` | Uploaded workbook name |
| `source_sheet_name` | Source worksheet used |
| `file_hash` | Hash of the uploaded file |
| `header_signature` | Hash or normalized signature of the detected header |
| `imported_at` | Timestamp |
| `imported_by` | User email |
| `row_count` | Imported row count |
| `column_count` | Imported column count |
| `amount_total` | Total of the detected amount column, where applicable |
| `target_zone_key` | Semantic import zone written |
| `resolved_zone_fingerprint` | Fingerprint of the resolved developer-metadata zone |
| `status` | `parsed`, `imported`, `validated`, `failed`, or `stale` |
| `validation_message` | Human-readable validation summary |

The manifest supports partial re-upload by preserving the last known version of every external source table. A successful later upload for the same source table supersedes the previous active manifest item while keeping prior versions auditable as stale/history; a failed later upload does not replace the last validated version.

## Validation Rules

### Pre-write validation

Pre-write validation prevents obvious bad uploads before touching the project workbook:

- Workbook can be parsed.
- At least one known import role is detected.
- Required headers are present.
- Data row count is greater than zero.
- Amount columns parse as numeric where required.
- Date fields are recognizable where required.
- Duplicate file hash is flagged before writing.
- Target semantic zone is known and compatible with the detected table width.

### Post-write validation

After write success, the backend automatically runs the existing `validate_input` operation.

On success:

- Refresh `Unit Master`.
- Clear `external_data_dirty`.
- Mark imported manifest entries as `validated`.
- Advance project stage to `external_data_ready`.

On failure:

- Keep the newly imported data visible for investigation.
- Keep or set `external_data_dirty = TRUE`.
- Do not advance the project stage.
- Mark affected manifest entries as `failed`.
- Return a precise error summary to the UI.

Automatic rollback is intentionally out of scope for the first version. Failed validation often requires users to inspect the newly imported data.

## Job Model

Imports should run as background jobs because source files can contain tens of thousands of rows and Google Sheets writes may exceed normal request timeouts.

Job states:

| State | Meaning |
| --- | --- |
| `uploaded` | Files accepted and stored temporarily |
| `parsing` | Workbook contents are being read |
| `preview_ready` | UI can show detected tables and warnings |
| `confirmed` | User approved the write |
| `writing` | Target ranges are being cleared and updated |
| `validating` | `validate_input` is running |
| `succeeded` | Write and validation completed |
| `failed` | Parse, write, or validation failed |

The UI polls job status and shows progress by file and by table.

## Error Handling

Parse errors do not modify Google Sheets.

Write errors stop the job, preserve the previous manifest status for unaffected tables, and report the failed table and range.

Validation errors keep the newly written data, record failure details in the manifest, and prevent the workflow from advancing.

Partial import errors are table-scoped. A failure importing Payable must not clear or rewrite Final Detail unless Final Detail was also part of the same confirmed write and reached its own write step.

## Security And Permissions

- Only project owners or admins can import external data.
- Uploaded files are temporary and should be deleted after the import job finishes or expires.
- Import jobs must be tied to the authenticated user and project id.
- Writes use existing service-account Google Sheets access.
- The import manifest stores audit metadata, not raw file contents.

## MVP Scope

Included:

- Multi-file upload.
- Partial upload.
- Source detection by headers and sheet names.
- Draw request report single-sheet extraction.
- Preview and user confirmation.
- Semantic-zone writes into existing workbench raw-data zones.
- Automatic `validate_input` after successful write.
- Supabase durable job and import manifest records as the only persisted audit truth.
- User-visible import status and validation result.

Out of scope for MVP:

- Direct WBS API integration.
- Scheduled Drive-folder ingestion.
- Automatic rollback.
- Cell-level merge of old and new data.
- Multi-project import dashboard.

## Acceptance Criteria

- A user can upload only Payable and the system replaces only Payable's raw import zone.
- A user can upload `_Draw request report_*.xlsx` and only the `Draw request report` sheet is imported.
- A user can upload all known files in one job and all detected tables write to the correct semantic zones.
- Every successful write automatically triggers `validate_input`.
- Project stage advances to `external_data_ready` only after validation succeeds.
- Validation failure leaves imported data visible, records failure status, and blocks the next stage.
- The manifest shows the latest file, row count, amount total, status, and timestamp for every imported external table.
