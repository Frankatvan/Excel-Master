# Audit Sync Long Task Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make audit sync resilient to timeout, stale lock, and stale run failures while enforcing two architecture boundaries: validation is read-only, and formula-sync business logic is not tied to fixed physical cell addresses.

**Architecture:** Split audit sync into explicit phases: `ensure_final_gmp_schema` may mutate sheet structure, `validate_only` is pure validation and must not write, and snapshot sync runs asynchronously through a persisted run record. Formula-sync remediation treats hardcoded business row/column references as architecture failures; Google Sheets A1 ranges are allowed only as generated output from semantic discovery or API transport formatting.

**Tech Stack:** Next.js Pages API, React workbench page, Supabase RPC/tables, Vercel serverless functions, Python workers, Google Sheets API, Jest/ts-jest, pytest.

---

## Review Incorporation

The 2026-04-27 audit review rejected the previous plan for two valid reasons:

- `validate_only` in `excel-master-app/api/internal/reclassify_job.py` currently calls `ensure_scoping_final_gmp_before_reclassification(...)` before returning validation. That means a route named validation can insert or rewrite the Final GMP column.
- The formula-sync section treated `excel-master-app/api/formula_sync.py` as a job-status wrapper problem only. The real physical-address dependency lives mostly below it, especially in `excel-master-app/api/logic/aiwb_finance/finance_engine.py`.

This revised plan changes the implementation order so those two boundaries are pinned by tests before timeout and resilience work lands.

## Permission Integration Addendum

The Drive Sheet permission model implementation is now present in the workspace and is the baseline for this repair plan.

Verified status on 2026-04-27:

- `excel-master-app/src/lib/project-access.ts` exists and exposes `requireProjectAccess`, `requireProjectCollaborator`, and `requireDriveOwner`.
- Write routes already call collaborator/owner guards before worker execution.
- `excel-master-app/src/lib/trusted-worker-url.ts` exists and removes request-header-derived worker origins.
- Focused Jest permission and route tests passed for project access, project state/action, reclassify, formula sync, and audit routes.
- Worker auth tests passed for reclassification and formula sync.

Integration rules for this plan:

- Keep Drive permission guards as the first project-scoped gate in every API route.
- Preserve this order in write routes: session auth, `spreadsheet_id` validation, Drive permission guard, worker configuration check, then worker or audit-service execution.
- Do not convert `ProjectAccessError` into worker errors. Permission failures stay `403` or `404`.
- Do not convert worker lock conflicts into generic `502`. `PROJECT_RUN_LOCKED` must stay `409`.
- Do not convert worker auth/config failures into generic workflow messages. Missing worker URL/secret should stay explicit deployment/config errors.
- `resolveTrustedWorkerUrl(...)` is the approved fallback URL builder for internal worker calls.
- `AIWB_WORKER_SECRET` is the preferred shared deployment secret; per-worker secrets are optional overrides. Verification must check that the same secret is visible to both Next API routes and Python workers.

New risks discovered after permission integration:

- `excel-master-app/src/pages/api/reclassify.ts` still maps every non-2xx worker response to `{ error: "重分类服务异常" }` with status `502`.
- `excel-master-app/src/pages/api/formula_sync_run.ts` still maps worker `409` conflicts to route `502`.
- `excel-master-app/src/pages/api/audit_sync.ts` has permission guard and trusted worker URL, but still calls `validate_only: true` and foreground `syncAuditSummary(...)`.
- `excel-master-app/api/internal/reclassify_job.py` still runs `ensure_scoping_final_gmp_before_reclassification(...)` before the `validate_only` branch.
- Local env files checked during evaluation did not define `AIWB_WORKER_SECRET` or `RECLASSIFY_WORKER_SECRET`; deployment verification must include this.

Production schema prerequisite:

- Online Supabase `projects` must include `sheet_109_title` and `project_sequence` before new-project flows are used.
- This workspace has no `SUPABASE_DB_URL`, so do not assume local automation can apply the DDL.
- Before production smoke testing, manually run `excel-master-app/supabase/migrations/20260522002000_add_project_serial_metadata.sql` in Supabase SQL Editor.
- Verify the two columns and indexes exist before testing project creation or 109 sheet title routing.

## File Structure

- Modify: `excel-master-app/api/internal/reclassify_job.py`
  - Add explicit worker operation `ensure_final_gmp_schema`.
  - Keep `validate_only` and `operation: "validate"` read-only.
  - Return a clear validation error if Final GMP structure is missing and the caller asked only to validate.
- Modify: `tests/test_reclassify_job.py`
  - Assert `validate_only` does not call `spreadsheets().batchUpdate(...)`.
  - Assert `operation: "ensure_final_gmp_schema"` is the only path that may call Final GMP schema migration.
- Modify: `excel-master-app/src/pages/api/audit_sync.ts`
  - Run explicit schema migration before validation.
  - Return `202 accepted` after creating the background sync run.
  - Preserve 409 lock errors instead of flattening them into 500.
  - Preserve existing `requireProjectCollaborator(...)` guard before schema migration or validation.
  - Use `resolveTrustedWorkerUrl(...)` for worker calls.
- Modify: `excel-master-app/src/lib/audit-service.ts`
  - Add `startAuditSummarySync(...)` and stale-run helpers.
  - Keep `syncAuditSummary(...)` available for internal direct use and existing tests.
- Modify: `excel-master-app/src/pages/api/audit_sync_status.ts`
  - Return `stale` for old `running` rows.
- Modify: `excel-master-app/src/pages/index.tsx`
  - Treat `202 accepted` as normal.
  - Poll until `succeeded`, `failed`, or `stale`.
  - Replace copy that says sync only refreshes frontend display.
- Modify: `excel-master-app/src/pages/api/reclassify.ts`
  - Preserve worker `PROJECT_RUN_LOCKED` details and return 409.
  - Keep `requireProjectCollaborator(...)` before cooldown and worker execution.
  - Preserve worker auth/config messages separately from worker processing failures.
- Modify: `excel-master-app/src/pages/api/formula_sync_run.ts`
  - Preserve worker `PROJECT_RUN_LOCKED` details and return 409.
  - Keep `requireProjectCollaborator(...)` before worker execution.
  - Preserve `SNAPSHOT_STALE_ERROR` as 409.
- Modify: `excel-master-app/src/lib/trusted-worker-url.ts`
  - Reuse the permission implementation's trusted worker URL resolver.
  - Do not reintroduce request-header-derived worker origin fallback.
- Modify: `excel-master-app/api/formula_sync.py`
  - Keep jobs-table writes behind a small adapter that tolerates a missing table until migration is deployed.
  - Do not add formula-address logic here.
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_engine.py`
  - Replace formula-sync business formulas and writable ranges that are hardcoded to fixed row/column addresses with semantic references.
- Modify: `docs/AiWB_公式字典_109_v1.yaml`
  - Add semantic formula tokens and source-field references for 109 formula sync.
- Create: `tests/test_formula_sync_no_physical_addresses.py`
  - Fail when formula-sync business functions contain new fixed business addresses.
- Create: `excel-master-app/supabase/migrations/20260427060000_create_jobs_table_if_missing.sql`
  - Production-safe `jobs` table migration using `gen_random_uuid()`.
- Modify tests:
  - `excel-master-app/src/__tests__/audit-api-routes.test.ts`
  - `excel-master-app/src/__tests__/audit-sync-final-gmp.test.ts`
  - `excel-master-app/src/__tests__/audit-service.test.ts`
  - `excel-master-app/src/__tests__/workbench-phase1.test.tsx`
  - `excel-master-app/src/__tests__/reclassify-api.test.ts`
  - `excel-master-app/src/__tests__/formula-live-api.test.ts`
  - `excel-master-app/src/__tests__/deployment-config.test.ts`
- Optional docs update:
  - `docs/AiWB_Final_GMP_单包重构与发版记录_2026-04-27.md`

## Task 1: Pin The Validation Contract As Read-Only

**Files:**
- Modify: `tests/test_reclassify_job.py`

- [x] **Step 1: Add handler test helpers**

Add these helpers near the top of `tests/test_reclassify_job.py`, below `load_worker_module()`:

```python
class DummyWriter:
    def __init__(self):
        self.body = ""

    def write(self, data):
        self.body = data.decode("utf-8")


def invoke_worker_post(worker, body, service=None, sheet_map=None, compute_results=None):
    request_body = json.dumps(body).encode("utf-8")
    writer = DummyWriter()
    handler = worker.handler.__new__(worker.handler)
    handler.headers = {"Content-Length": str(len(request_body))}
    handler.rfile = SimpleNamespace(read=Mock(return_value=request_body))
    handler.wfile = writer
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/internal/reclassify_job HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/internal/reclassify_job"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()

    if service is None:
        service = Mock()
    if sheet_map is None:
        sheet_map = {"Payable": object(), "Final Detail": object(), "Scoping": [["GMP"]]}

    worker._load_worker_dependencies = Mock(return_value={"get_sheets_service": Mock(return_value=service)})
    worker.load_reclassify_sheet_map = Mock(return_value=sheet_map)
    if compute_results is None:
        compute_results = {
            "payable_decisions": [SimpleNamespace(category="ROE", rule_id="R107")],
            "final_detail_decisions": [SimpleNamespace(category="ACC", rule_id="R201")],
        }
    if isinstance(compute_results, Exception):
        worker.compute_reclassification_results = Mock(side_effect=compute_results)
    else:
        worker.compute_reclassification_results = Mock(return_value=compute_results)
    service.spreadsheets.return_value.values.return_value.batchGet.return_value.execute.return_value = {
        "valueRanges": [
            {"values": [["ROE", "R107"]]},
            {"values": [["ACC", "R201"]]},
        ]
    }

    worker.handler.do_POST(handler)
    return handler.send_response.call_args.args[0], json.loads(writer.body), service
```

- [x] **Step 2: Add a failing test for pure `validate_only`**

Append this test to `tests/test_reclassify_job.py` near the existing validate-only tests:

```python
def test_validate_only_does_not_run_final_gmp_schema_migration(monkeypatch):
    worker = load_worker_module()
    worker.ensure_scoping_final_gmp_before_reclassification = Mock(return_value={"inserted": True})

    status_code, payload, service = invoke_worker_post(
        worker,
        {
            "spreadsheet_id": "sheet-123",
            "validate_only": True,
        },
    )

    assert status_code == 200
    assert payload["ok"] is True
    assert payload["validation"]["status"] == "ok"
    worker.ensure_scoping_final_gmp_before_reclassification.assert_not_called()
    service.spreadsheets.return_value.batchUpdate.assert_not_called()
    service.spreadsheets.return_value.values.return_value.batchUpdate.assert_not_called()
```

- [x] **Step 3: Add a failing test for the explicit migration operation**

Append this second test:

```python
def test_ensure_final_gmp_schema_operation_is_the_only_schema_mutation_path(monkeypatch):
    worker = load_worker_module()
    worker.ensure_scoping_final_gmp_before_reclassification = Mock(
        return_value={"inserted": True, "final_gmp_col_1based": 6}
    )

    status_code, payload, service = invoke_worker_post(
        worker,
        {
            "spreadsheet_id": "sheet-123",
            "operation": "ensure_final_gmp_schema",
        }
    )

    assert status_code == 200
    assert payload["ok"] is True
    assert payload["operation"] == "ensure_final_gmp_schema"
    assert payload["final_gmp"]["inserted"] is True
    worker.ensure_scoping_final_gmp_before_reclassification.assert_called_once()
    service.spreadsheets.return_value.values.return_value.batchUpdate.assert_not_called()
```

- [x] **Step 4: Run the two tests and verify they fail**

Run:

```bash
pytest tests/test_reclassify_job.py::test_validate_only_does_not_run_final_gmp_schema_migration tests/test_reclassify_job.py::test_ensure_final_gmp_schema_operation_is_the_only_schema_mutation_path -v
```

Expected: the first test fails because current `validate_only` calls Final GMP schema migration; the second fails because `operation: "ensure_final_gmp_schema"` is not implemented.

- [ ] **Step 5: Commit failing tests**

```bash
git add tests/test_reclassify_job.py
git commit -m "test: pin read-only reclassification validation"
```

## Task 2: Implement Explicit Final GMP Schema Migration

**Files:**
- Modify: `excel-master-app/api/internal/reclassify_job.py`
- Modify: `tests/test_reclassify_job.py`

- [x] **Step 1: Add operation parsing**

In `excel-master-app/api/internal/reclassify_job.py`, add this helper near `_read_validate_only`:

```python
def _read_operation(data: Mapping[str, Any]) -> str:
    raw = data.get("operation")
    if raw in (None, ""):
        return "reclassify"
    if not isinstance(raw, str):
        raise ValueError("operation must be a string")
    operation = raw.strip()
    allowed = {"reclassify", "validate", "ensure_final_gmp_schema"}
    if operation not in allowed:
        raise ValueError(f"unsupported operation: {operation}")
    return operation
```

- [x] **Step 2: Branch schema migration before validation**

In the handler body where `validate_only` is read, replace the unconditional call to `ensure_scoping_final_gmp_before_reclassification(...)` with this shape:

```python
operation = _read_operation(data)
validate_only = _read_validate_only(data) or operation == "validate"

deps = _load_worker_dependencies()
service = deps["get_sheets_service"]()
sheet_map = load_reclassify_sheet_map(service, spreadsheet_id)

if operation == "ensure_final_gmp_schema":
    final_gmp_meta = ensure_scoping_final_gmp_before_reclassification(
        service,
        spreadsheet_id,
        sheet_map,
        deps=deps,
    )
    return self._send_json(
        200,
        {
            "ok": True,
            "message": "Final GMP schema migration completed.",
            "operation": "ensure_final_gmp_schema",
            "spreadsheet_id": spreadsheet_id,
            "final_gmp": final_gmp_meta,
        },
    )

results = compute_reclassification_results(sheet_map)

if validate_only:
    validation = build_validation_payload(service, spreadsheet_id, results)
    return self._send_json(
        200,
        {
            "ok": True,
            "message": "Reclassification validation completed.",
            "operation": "validate",
            "spreadsheet_id": spreadsheet_id,
            "validation": validation,
        },
    )

final_gmp_meta = ensure_scoping_final_gmp_before_reclassification(
    service,
    spreadsheet_id,
    sheet_map,
    deps=deps,
)
if final_gmp_meta.get("inserted"):
    sheet_map = load_reclassify_sheet_map(service, spreadsheet_id)
    results = compute_reclassification_results(sheet_map)
```

Add this `except` branch before the existing generic `except Exception` block:

```python
except RuntimeError as exc:
    message = str(exc)
    if "FINAL_GMP_SCHEMA_MISSING" in message:
        return self._send_error(422, message, spreadsheet_id=spreadsheet_id or None)
    return self._send_error(500, f"Reclassification worker failed: {exc}", spreadsheet_id=spreadsheet_id or None)
```

- [x] **Step 3: Add a missing-schema validation assertion**

Add this test to `tests/test_reclassify_job.py`:

```python
def test_validate_only_reports_missing_final_gmp_without_mutating(monkeypatch):
    worker = load_worker_module()
    worker.ensure_scoping_final_gmp_before_reclassification = Mock(return_value={"inserted": True})
    worker.compute_reclassification_results = Mock(side_effect=RuntimeError("FINAL_GMP_SCHEMA_MISSING"))

    status_code, payload, service = invoke_worker_post(
        worker,
        {
            "spreadsheet_id": "sheet-123",
            "operation": "validate",
        },
        sheet_map={"Payable": object(), "Final Detail": object(), "Scoping": [["GMP"]]},
        compute_results=RuntimeError("FINAL_GMP_SCHEMA_MISSING"),
    )

    assert status_code == 422
    assert payload["ok"] is False
    assert "FINAL_GMP_SCHEMA_MISSING" in payload["message"]
    worker.ensure_scoping_final_gmp_before_reclassification.assert_not_called()
    service.spreadsheets.return_value.batchUpdate.assert_not_called()
```

- [x] **Step 4: Run validation contract tests**

Run:

```bash
pytest tests/test_reclassify_job.py::test_validate_only_does_not_run_final_gmp_schema_migration tests/test_reclassify_job.py::test_ensure_final_gmp_schema_operation_is_the_only_schema_mutation_path tests/test_reclassify_job.py::test_validate_only_reports_missing_final_gmp_without_mutating -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add excel-master-app/api/internal/reclassify_job.py tests/test_reclassify_job.py
git commit -m "fix: separate final gmp schema migration from validation"
```

## Task 3: Pin The Audit Sync Route Contract

**Files:**
- Modify: `excel-master-app/src/__tests__/audit-api-routes.test.ts`
- Modify: `excel-master-app/src/__tests__/audit-sync-final-gmp.test.ts`

- [x] **Step 1: Update audit sync route test to expect schema migration, validation, then async sync**

Use this test body in `excel-master-app/src/__tests__/audit-api-routes.test.ts`:

```ts
it("runs explicit schema migration and validation before accepting audit sync", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "tester@example.com" },
  } as never);
  mockStartAuditSummarySync.mockResolvedValue({
    spreadsheetId: "sheet-123",
    sync_run_id: "run-123",
    run: jest.fn().mockResolvedValue(undefined),
  } as never);

  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        operation: "ensure_final_gmp_schema",
        final_gmp: { inserted: false },
      }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "ok",
        operation: "validate",
        validation: { status: "ok", message: "重分类校验通过" },
      }),
    } as Response);

  const req = {
    method: "POST",
    body: { spreadsheet_id: "sheet-123" },
    headers: {},
    socket: {},
  } as NextApiRequest;
  const res = createMockRes();

  await auditSyncHandler(req, res);

  expect(mockFetch).toHaveBeenNthCalledWith(
    1,
    "https://worker.example.com/api/internal/reclassify_job",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        spreadsheet_id: "sheet-123",
        operation: "ensure_final_gmp_schema",
      }),
    }),
  );
  expect(mockFetch).toHaveBeenNthCalledWith(
    2,
    "https://worker.example.com/api/internal/reclassify_job",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        spreadsheet_id: "sheet-123",
        operation: "validate",
      }),
    }),
  );
  expect(mockStartAuditSummarySync).toHaveBeenCalledWith("sheet-123");
  expect(mockSyncAuditSummary).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(202);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "accepted",
      mode: "async",
      spreadsheet_id: "sheet-123",
      sync_run_id: "run-123",
      schema_migration: expect.objectContaining({ status: "ok" }),
      validation: expect.objectContaining({ status: "ok" }),
    }),
  );
});
```

- [x] **Step 2: Run route tests and verify they fail before implementation**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/audit-api-routes.test.ts src/__tests__/audit-sync-final-gmp.test.ts
```

Expected: FAIL because `/api/audit_sync` still performs the old foreground work.

- [ ] **Step 3: Commit failing tests**

```bash
git add src/__tests__/audit-api-routes.test.ts src/__tests__/audit-sync-final-gmp.test.ts
git commit -m "test: pin explicit audit sync phases"
```

## Task 4: Restore Async Audit Sync Without `next/server.after`

**Files:**
- Modify: `excel-master-app/src/pages/api/audit_sync.ts`
- Modify: `excel-master-app/src/lib/audit-service.ts`

- [x] **Step 1: Add async starter in `audit-service`**

In `excel-master-app/src/lib/audit-service.ts`, add:

```ts
export async function startAuditSummarySync(spreadsheetId: string): Promise<{
  spreadsheetId: string;
  sync_run_id: string;
  run: () => Promise<AuditSnapshotSummary>;
}> {
  const run = await createAuditSyncRun(spreadsheetId);
  return {
    spreadsheetId,
    sync_run_id: run.id,
    run: async () => syncAuditSummary(spreadsheetId, { syncRunId: run.id }),
  };
}
```

Use the existing run-creation function name if it differs; keep the return shape above so the route tests have a stable contract.

- [x] **Step 2: Add fire-and-log helper in route**

In `excel-master-app/src/pages/api/audit_sync.ts`, add:

```ts
function runAuditSyncInBackground(run: () => Promise<unknown>, syncRunId: string | null) {
  void run().catch((error) => {
    console.error("[Audit] background audit_sync failed", {
      sync_run_id: syncRunId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}
```

- [x] **Step 3: Implement explicit phases in route**

Replace the foreground sync block with:

```ts
const schemaMigration = await callReclassifyWorker({
  spreadsheet_id: spreadsheetId,
  operation: "ensure_final_gmp_schema",
});

const validation = await callReclassifyWorker({
  spreadsheet_id: spreadsheetId,
  operation: "validate",
});

const started = await startAuditSummarySync(spreadsheetId);
runAuditSyncInBackground(started.run, started.sync_run_id);

return res.status(202).json({
  status: "accepted",
  mode: "async",
  spreadsheet_id: spreadsheetId,
  sync_run_id: started.sync_run_id,
  schema_migration: schemaMigration,
  validation,
  message: "同步已开始，后台完成后会刷新快照",
});
```

- [x] **Step 4: Preserve service errors**

In the `catch` block, add this before the generic 500 response:

```ts
if (error instanceof AuditSnapshotServiceError) {
  return res.status(error.statusCode).json({
    error: error.code,
    message: error.message,
    details: error.details ?? null,
  });
}
```

- [x] **Step 5: Run tests**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/audit-api-routes.test.ts src/__tests__/audit-sync-final-gmp.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/api/audit_sync.ts src/lib/audit-service.ts src/__tests__/audit-api-routes.test.ts src/__tests__/audit-sync-final-gmp.test.ts
git commit -m "fix: run audit sync as explicit async phases"
```

## Task 5: Add Stale Run Detection And Status Surfacing

**Files:**
- Modify: `excel-master-app/src/lib/audit-service.ts`
- Modify: `excel-master-app/src/pages/api/audit_sync_status.ts`
- Modify: `excel-master-app/src/__tests__/audit-service.test.ts`
- Modify: `excel-master-app/src/__tests__/audit-api-routes.test.ts`

- [x] **Step 1: Add stale helper tests**

Add to `excel-master-app/src/__tests__/audit-service.test.ts`:

```ts
it("marks old running audit sync rows as stale", () => {
  jest.setSystemTime(new Date("2026-04-27T12:10:00.000Z"));
  expect(
    classifyAuditSyncRun({
      status: "running",
      started_at: "2026-04-27T12:00:00.000Z",
      finished_at: null,
    }),
  ).toEqual("stale");
});
```

- [x] **Step 2: Implement stale helper**

Add to `excel-master-app/src/lib/audit-service.ts`:

```ts
export const AUDIT_SYNC_STALE_AFTER_MS = 5 * 60 * 1000;

export function classifyAuditSyncRun(run: {
  status: string;
  started_at: string | null;
  finished_at?: string | null;
}): "running" | "stale" | "succeeded" | "failed" {
  if (run.status === "succeeded") return "succeeded";
  if (run.status === "failed") return "failed";
  if (run.status === "running" && run.started_at) {
    const ageMs = Date.now() - new Date(run.started_at).getTime();
    if (ageMs > AUDIT_SYNC_STALE_AFTER_MS) return "stale";
  }
  return "running";
}
```

- [x] **Step 3: Use it in status route**

In `excel-master-app/src/pages/api/audit_sync_status.ts`, map the latest run before response:

```ts
const effectiveStatus = classifyAuditSyncRun(latestRun);
return res.status(200).json({
  status: effectiveStatus,
  run: {
    ...latestRun,
    status: effectiveStatus,
  },
});
```

- [x] **Step 4: Run tests**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/audit-service.test.ts src/__tests__/audit-api-routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit-service.ts src/pages/api/audit_sync_status.ts src/__tests__/audit-service.test.ts src/__tests__/audit-api-routes.test.ts
git commit -m "fix: surface stale audit sync runs"
```

## Task 6: Fix Frontend Sync Messages And Polling

**Files:**
- Modify: `excel-master-app/src/pages/index.tsx`
- Modify: `excel-master-app/src/__tests__/workbench-phase1.test.tsx`

- [x] **Step 1: Pin user-visible copy**

In `excel-master-app/src/__tests__/workbench-phase1.test.tsx`, assert the sync helper text uses this wording:

```ts
expect(screen.getByText("同步会先检查工作表结构，再校验并刷新审计快照。")).toBeInTheDocument();
```

- [x] **Step 2: Pin stale status UI**

Add:

```ts
expect(await screen.findByText("同步任务可能已超时，请稍后重试或联系管理员清理运行锁。")).toBeInTheDocument();
```

Use the existing polling mock in this test file and return:

```ts
{
  status: "stale",
  run: {
    id: "run-123",
    status: "stale",
    started_at: "2026-04-27T12:00:00.000Z",
  },
}
```

- [x] **Step 3: Update copy and status handling**

In `excel-master-app/src/pages/index.tsx`, replace the old helper text with:

```tsx
同步会先检查工作表结构，再校验并刷新审计快照。
```

Handle status:

```ts
if (payload.status === "stale") {
  setSyncStatus("failed");
  setSyncMessage("同步任务可能已超时，请稍后重试或联系管理员清理运行锁。");
  return;
}
```

- [x] **Step 4: Run tests**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/workbench-phase1.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/index.tsx src/__tests__/workbench-phase1.test.tsx
git commit -m "fix: clarify audit sync polling states"
```

## Task 7: Preserve Project Lock Errors Across Routes

**Files:**
- Modify: `excel-master-app/src/pages/api/reclassify.ts`
- Modify: `excel-master-app/src/pages/api/formula_sync_run.ts`
- Modify: `excel-master-app/src/__tests__/reclassify-api.test.ts`
- Modify: `excel-master-app/src/__tests__/formula-live-api.test.ts`

- [x] **Step 1: Add route tests for 409 lock propagation after permission guard**

In `excel-master-app/src/__tests__/reclassify-api.test.ts`, add:

```ts
it("preserves project run lock conflicts from the reclassification worker", async () => {
  mockGetServerSession.mockResolvedValue({
    user: { email: "tester@example.com" },
  } as never);
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({
      status: "error",
      message: "PROJECT_RUN_LOCKED:audit_sync",
    }),
  }) as never;

  const req = {
    method: "POST",
    body: { spreadsheet_id: "sheet-123" },
    headers: {},
  } as unknown as NextApiRequest;
  const res = createMockRes();

  await handler(req, res);

  expect(mockRequireProjectCollaborator).toHaveBeenCalledWith("sheet-123", "tester@example.com");
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({
      error: "PROJECT_RUN_LOCKED",
      message: expect.stringContaining("audit_sync"),
      details: expect.objectContaining({
        active_operation: "audit_sync",
      }),
    }),
  );
});
```

In `excel-master-app/src/__tests__/formula-live-api.test.ts`, add the same worker response shape for `formulaSyncRunHandler` and assert:

```ts
expect(res.status).toHaveBeenCalledWith(409);
expect(res.json).toHaveBeenCalledWith(
  expect.objectContaining({
    error: "PROJECT_RUN_LOCKED",
    message: expect.stringContaining("audit_sync"),
    details: expect.objectContaining({
      active_operation: "audit_sync",
    }),
  }),
);
```

- [x] **Step 2: Add worker response normalization helper to each route**

In both routes, add a local helper or shared helper with this behavior:

```ts
function normalizeWorkerError(status: number, body: Record<string, unknown> | null) {
  const rawMessage = typeof body?.message === "string" ? body.message : "";
  const rawError = typeof body?.error === "string" ? body.error : "";
  const rawCode = typeof body?.code === "string" ? body.code : "";
  const combined = rawCode || rawError || rawMessage;

  if (status === 409 && combined.startsWith("PROJECT_RUN_LOCKED")) {
    const [, activeOperation = "other_write_run"] = combined.split(":", 2);
    return {
      status: 409,
      body: {
        error: "PROJECT_RUN_LOCKED",
        message: `已有任务运行中：${activeOperation}`,
        details: { active_operation: activeOperation },
      },
    };
  }

  if (status === 409 && rawMessage.startsWith("SNAPSHOT_STALE_ERROR")) {
    return {
      status: 409,
      body: {
        error: "SNAPSHOT_STALE_ERROR",
        message: rawMessage,
      },
    };
  }

  if (status === 401) {
    return {
      status: 502,
      body: {
        error: "WORKER_UNAUTHORIZED",
        message: "Worker authorization failed.",
      },
    };
  }

  if (rawMessage === "Worker secret is not configured.") {
    return {
      status: 500,
      body: {
        error: "WORKER_SECRET_MISSING",
        message: rawMessage,
      },
    };
  }

  return {
    status: 502,
    body: {
      error: "WORKER_FAILED",
      message: rawMessage || "Worker request failed.",
    },
  };
}
```

Replace the current generic `return res.status(502).json({ error: "重分类服务异常" })` and formula-sync generic 502 mapping with `normalizeWorkerError(...)`.

- [x] **Step 3: Preserve permission errors before worker errors**

Keep this branch in both routes:

```ts
if (error instanceof ProjectAccessError) {
  return res.status(error.statusCode).json({ error: error.message, code: error.code });
}
```

Do not wrap `ProjectAccessError` with `normalizeWorkerError(...)`.

- [x] **Step 4: Run tests**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/reclassify-api.test.ts src/__tests__/formula-live-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/api/reclassify.ts src/pages/api/formula_sync_run.ts src/__tests__/reclassify-api.test.ts src/__tests__/formula-live-api.test.ts
git commit -m "fix: preserve project lock conflicts"
```

## Task 8: Pin Formula-Sync Physical Address Governance

**Files:**
- Create: `tests/test_formula_sync_no_physical_addresses.py`

- [x] **Step 1: Add a targeted address-governance test**

Create `tests/test_formula_sync_no_physical_addresses.py`:

```python
import ast
import re
from pathlib import Path


ENGINE = Path("excel-master-app/api/logic/aiwb_finance/finance_engine.py")

FORMULA_SYNC_FUNCTIONS = {
    "_build_109_manual_input_ranges",
    "_build_109_units_count_formula",
    "_build_109_date_array_formula",
    "_build_109_formula_plan_from_grid",
    "_ensure_109_labels",
    "execute_109_formula_plan",
    "load_current_snapshot_formula_plan",
}

FORBIDDEN_FIXED_ADDRESS = re.compile(
    r"(?<![A-Za-z0-9_])(?:'[^']+'!|[A-Za-z0-9_ ]+!)?"
    r"(?:\\$?[A-Z]{1,3}\\$?[0-9]{1,5}|\\$?[A-Z]{1,3}:\\$?[A-Z]{1,3}|[A-Z]{1,3}[0-9]{1,5}:[A-Z]{1,3}[0-9]{1,5})"
)

ALLOWED_TRANSPORT_HELPERS = {
    "_a1_range_for_grid_write",
    "_quote_sheet_name",
}


def _function_name_stack(tree):
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _enclosing_function(node, parents):
    current = node
    while current in parents:
        current = parents[current]
        if isinstance(current, ast.FunctionDef):
            return current.name
    return None


def test_formula_sync_business_logic_has_no_fixed_physical_addresses():
    tree = ast.parse(ENGINE.read_text(encoding="utf-8"))
    parents = _function_name_stack(tree)
    violations = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        function_name = _enclosing_function(node, parents)
        if function_name not in FORMULA_SYNC_FUNCTIONS:
            continue
        if function_name in ALLOWED_TRANSPORT_HELPERS:
            continue
        if FORBIDDEN_FIXED_ADDRESS.search(node.value):
            violations.append((function_name, node.lineno, node.value))

    assert violations == []
```

This test intentionally fails on current code. It is the guardrail that forces business formulas and ranges to be derived from semantic mapping instead of fixed cells like `C2:E2`, `109!A1:D100`, or `Payable!$T:$T`.

- [x] **Step 2: Run and capture failing inventory**

Run:

```bash
pytest tests/test_formula_sync_no_physical_addresses.py -v
```

Expected: FAIL with violations in formula-sync path functions.

- [ ] **Step 3: Commit failing governance test**

```bash
git add tests/test_formula_sync_no_physical_addresses.py
git commit -m "test: pin formula sync address governance"
```

## Task 9: Replace Formula-Sync Business Addresses With Semantic References

**Files:**
- Modify: `docs/AiWB_公式字典_109_v1.yaml`
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_engine.py`
- Modify: `tests/test_formula_generator.py`
- Modify: `tests/test_109_formula_patterns_v2.py`
- Modify: `tests/test_snapshot_formula_writeback.py`
- Modify: `tests/test_formula_sync_no_physical_addresses.py`

- [x] **Step 1: Extend the formula dictionary**

Add semantic entries to `docs/AiWB_公式字典_109_v1.yaml`:

```yaml
semantic_sources:
  unit_master:
    unit_code: "Unit Code"
    budget_surplus: "Budget Surplus"
    final_date: "Final Date"
  unit_budget:
    unit_code: "Unit Code"
    contract_price_day1: "Contract Price"
    general_conditions_fee: "General Conditions Fee"
    year: "Year"
  payable:
    cost_state: "Cost State"
    incurred_date: "Incurred Date"
    amount: "Amount"
    post_date: "Posting Date"
    settlement_date: "Settlement Date"

formula_templates:
  units_count:
    target_label: "Units count"
    formula: '=IFERROR(COUNTA(FILTER({unit_budget.unit_code},REGEXMATCH({unit_budget.unit_code},"[0-9]"))),0)'
  contract_price_day1:
    target_label: "Contract price (Day1)"
    formula: '=SUMIFS({unit_budget.contract_price_day1},{unit_budget.year},1)'
  payable_date_array:
    target_label: "Payable date array"
    formula: '=IFERROR(FILTER({payable.incurred_date},{payable.incurred_date}<>""),"")'
```

- [x] **Step 2: Add semantic range resolver tests**

Add to `tests/test_formula_generator.py`:

```python
def test_formula_template_resolves_semantic_columns_from_headers():
    rows = {
        "Unit Budget": [
            ["Unit Code", "Year", "Contract Price"],
            ["U-001", "1", "100"],
        ],
        "Payable": [
            ["Cost State", "Incurred Date", "Amount"],
            ["ROE", "2026-01-31", "10"],
        ],
    }

    resolver = fe.FormulaSemanticResolver(rows)

    assert resolver.column_range("Unit Budget", "Unit Code") == "'Unit Budget'!$A$2:$A"
    assert resolver.column_range("Unit Budget", "Contract Price") == "'Unit Budget'!$C$2:$C"
    assert resolver.column_range("Payable", "Incurred Date") == "'Payable'!$B$2:$B"
```

- [x] **Step 3: Implement semantic resolver**

In `excel-master-app/api/logic/aiwb_finance/finance_engine.py`, add:

```python
class FormulaSemanticResolver:
    def __init__(self, sheet_rows: Mapping[str, Sequence[Sequence[Any]]]):
        self._sheet_rows = sheet_rows

    def column_range(self, sheet_name: str, header_label: str, start_row: int = 2) -> str:
        rows = self._sheet_rows.get(sheet_name) or []
        if not rows:
            raise ValueError(f"Missing sheet rows for {sheet_name}")
        headers = [str(value).strip() for value in rows[0]]
        try:
            index = headers.index(header_label)
        except ValueError as exc:
            raise ValueError(f"Missing header {header_label} in {sheet_name}") from exc
        column = _column_letter(index + 1)
        return f"{_quote_sheet_name(sheet_name)}!${column}${start_row}:${column}"
```

- [x] **Step 4: Replace known hardcoded formula builders**

Replace these current hotspots with resolver-backed expressions:

```python
def _build_109_units_count_formula(resolver: FormulaSemanticResolver) -> str:
    unit_code = resolver.column_range("Unit Budget", "Unit Code")
    return f'=IFERROR(COUNTA(FILTER({unit_code},REGEXMATCH({unit_code},"[0-9]"))),0)'


def _build_109_date_array_formula(resolver: FormulaSemanticResolver) -> str:
    incurred_date = resolver.column_range("Payable", "Incurred Date")
    return f'=IFERROR(FILTER({incurred_date},{incurred_date}<>""),"")'
```

For label placement, resolve target rows by label search instead of `109!A1:D100`:

```python
def _find_109_label_row(rows_109: Sequence[Sequence[Any]], label: str) -> int:
    normalized = label.strip().lower()
    for row_index, row in enumerate(rows_109, start=1):
        if any(str(cell).strip().lower() == normalized for cell in row):
            return row_index
    raise ValueError(f"Missing 109 label: {label}")
```

- [x] **Step 5: Keep A1 output only at transport boundary**

Generated writeback requests may still contain A1 ranges because Google Sheets requires them. The code that formats final API ranges must be isolated in helper functions named like:

```python
def _a1_range_for_grid_write(sheet_name: str, start_row: int, start_col: int, end_row: int, end_col: int) -> str:
    start = f"{_column_letter(start_col)}{start_row}"
    end = f"{_column_letter(end_col)}{end_row}"
    return f"{_quote_sheet_name(sheet_name)}!{start}:{end}"
```

Do not encode business meaning in this helper. Inputs must come from semantic label or header discovery.

- [x] **Step 6: Run formula tests**

Run:

```bash
pytest tests/test_formula_generator.py tests/test_109_formula_patterns_v2.py tests/test_snapshot_formula_writeback.py tests/test_formula_sync_no_physical_addresses.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/AiWB_公式字典_109_v1.yaml excel-master-app/api/logic/aiwb_finance/finance_engine.py tests/test_formula_generator.py tests/test_109_formula_patterns_v2.py tests/test_snapshot_formula_writeback.py tests/test_formula_sync_no_physical_addresses.py
git commit -m "fix: derive formula sync addresses from semantic mapping"
```

## Task 10: Add Jobs Table Migration And Missing-Table Tolerance

**Files:**
- Create: `excel-master-app/supabase/migrations/20260427060000_create_jobs_table_if_missing.sql`
- Modify: `excel-master-app/api/formula_sync.py`
- Modify: `excel-master-app/src/__tests__/deployment-config.test.ts`

- [x] **Step 1: Add production-safe migration**

Create `excel-master-app/supabase/migrations/20260427060000_create_jobs_table_if_missing.sql`:

```sql
create extension if not exists pgcrypto;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  spreadsheet_id text,
  job_type text not null,
  status text not null default 'queued',
  progress integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists jobs_spreadsheet_id_created_at_idx
  on public.jobs (spreadsheet_id, created_at desc);

create index if not exists jobs_job_type_status_created_at_idx
  on public.jobs (job_type, status, created_at desc);
```

- [x] **Step 2: Pin migration ordering test**

Add to `excel-master-app/src/__tests__/deployment-config.test.ts`:

```ts
it("ships a current jobs table migration for formula sync", () => {
  const projectRoot = path.resolve(__dirname, "../..");
  const migrationsDir = path.join(projectRoot, "supabase/migrations");
  const migrationNames = fs.readdirSync(migrationsDir);

  expect(migrationNames).toContain("20260427060000_create_jobs_table_if_missing.sql");
});
```

- [x] **Step 3: Add formula sync missing-table tolerance**

In `excel-master-app/api/formula_sync.py`, wrap jobs writes:

```python
def _safe_job_update(supabase, job_id: str | None, payload: Mapping[str, Any]) -> None:
    if not supabase or not job_id:
        return
    try:
        supabase.table("jobs").update(dict(payload)).eq("id", job_id).execute()
    except Exception as exc:
        message = str(exc)
        if "PGRST205" in message or "Could not find the table" in message:
            print("[formula_sync] jobs table missing; continuing without job persistence")
            return
        raise
```

Use `_safe_job_update(...)` for formula-sync job status writes. This is transitional tolerance; the migration is still required before release.

- [x] **Step 4: Run tests**

Run:

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath src/__tests__/deployment-config.test.ts
cd ..
pytest tests/test_snapshot_formula_writeback.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add excel-master-app/supabase/migrations/20260427060000_create_jobs_table_if_missing.sql excel-master-app/api/formula_sync.py excel-master-app/src/__tests__/deployment-config.test.ts
git commit -m "fix: make formula sync job persistence deployable"
```

 Final Verification And Production Remediation

**Files:**
- Modify only if needed after verification:
  - `docs/AiWB_Final_GMP_单包重构与发版记录_2026-04-27.md`

- [x] **Step 1: Run focused frontend tests**

```bash
cd excel-master-app
npm test -- --runInBand --runTestsByPath \
  src/__tests__/audit-api-routes.test.ts \
  src/__tests__/audit-sync-final-gmp.test.ts \
  src/__tests__/audit-service.test.ts \
  src/__tests__/workbench-phase1.test.tsx \
  src/__tests__/reclassify-api.test.ts \
  src/__tests__/formula-live-api.test.ts \
  src/__tests__/deployment-config.test.ts
```

Expected: PASS.

- [x] **Step 2: Run focused Python tests**

```bash
pytest \
  tests/test_reclassify_job.py \
  tests/test_formula_generator.py \
  tests/test_109_formula_patterns_v2.py \
  tests/test_snapshot_formula_writeback.py \
  tests/test_formula_sync_no_physical_addresses.py \
  -v
```

Expected: PASS.

- [x] **Step 3: Run lint/build**

```bash
cd excel-master-app
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 4: Production database remediation after deploy**

Run only after the migration is applied:

```sql
update audit_sync_runs
set status = 'failed',
    finished_at = now(),
    error = jsonb_build_object(
      'code', 'STALE_RUN_CLEANED',
      'message', 'Cleaned after audit_sync async resilience deployment'
    )
where status = 'running'
  and started_at < now() - interval '5 minutes';

delete from audit_project_run_locks
where operation = 'audit_sync'
  and expires_at < now();
```

- [ ] **Step 5: Smoke test the user path**

Manual checks:

```text
1. Open the workbench.
2. Click 同步数据.
3. Confirm the route returns 202 with schema_migration, validation, and sync_run_id.
4. Confirm status polling reaches succeeded or failed.
5. Confirm validate-only worker logs do not include spreadsheets.batchUpdate.
6. Confirm formula sync succeeds when jobs table exists.
7. Temporarily simulate jobs table PGRST205 in a local mock and confirm formula sync continues without job persistence.
```

- [ ] **Step 6: Commit docs if updated**

```bash
git add docs/AiWB_Final_GMP_单包重构与发版记录_2026-04-27.md
git commit -m "docs: record audit sync resilience release notes"
```

## Self-Review Checklist

- [x] Validation has a single meaning: read-only checks. The only schema mutation path is `operation: "ensure_final_gmp_schema"`.
- [x] Audit sync still performs Final GMP schema preparation, but it does so under an explicit mutation phase before validation.
- [x] Formula-sync physical-address governance targets the real implementation layer: `finance_engine.py`, not only `formula_sync.py`.
- [x] A1 notation is allowed only at API transport boundaries and only when derived from semantic discovery.
- [x] Stale `audit_sync_runs` and stale project locks are visible and recoverable.
- [x] `jobs` table creation is included as a deployable migration with transitional missing-table tolerance.
- [x] The frontend copy no longer claims sync is display-only.
- [x] Verification includes both Jest and pytest paths that cover the regression surface.
