import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Add both local compatibility logic and canonical package logic to the Python path.
api_dir = Path(__file__).resolve().parent
workspace_root = api_dir.parent.parent if api_dir.parent.name == "excel-master-app" else api_dir.parent
for logic_dir in [api_dir / "logic", workspace_root / "excel-master-app" / "api" / "logic"]:
    logic_path = str(logic_dir)
    if logic_dir.exists() and logic_path not in sys.path:
        sys.path.insert(0, logic_path)

from aiwb_finance.finance_engine import (
    get_sheets_service,
    load_current_snapshot_formula_plan,
    execute_109_formula_plan,
    validate_snapshot_writeback_consistency,
    SnapshotStaleError,
)
from supabase import create_client, Client


def _merge_writeback_metrics(
    supabase: Client,
    sync_run_id: str,
    writeback_audit: dict,
):
    if not sync_run_id:
        return
    try:
        existing = (
            supabase.table("audit_sync_runs")
            .select("metrics_json")
            .eq("id", sync_run_id)
            .limit(1)
            .execute()
        )
        metrics_json = {}
        if isinstance(existing.data, list) and existing.data:
            raw_metrics = existing.data[0].get("metrics_json")
            if isinstance(raw_metrics, dict):
                metrics_json = dict(raw_metrics)
        metrics_json["writeback"] = writeback_audit
        supabase.table("audit_sync_runs").update({"metrics_json": metrics_json}).eq("id", sync_run_id).execute()
    except Exception:
        # Metrics persistence should never block core writeback.
        return


def _read_rpc_row(response):
    data = getattr(response, "data", None)
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    if isinstance(data, dict):
        return data
    return {}


def _try_acquire_project_run_lock(
    supabase: Client,
    project_id: str,
    operation: str,
    owner: str,
    ttl_seconds: int = 900,
) -> str:
    response = supabase.rpc(
        "try_acquire_audit_project_lock",
        {
            "p_project_id": project_id,
            "p_operation": operation,
            "p_owner": owner,
            "p_ttl_seconds": ttl_seconds,
        },
    ).execute()
    row = _read_rpc_row(response)
    lock_token = str(row.get("lock_token") or "").strip()
    if row.get("acquired") is True and lock_token:
        return lock_token
    active_operation = str(row.get("active_operation") or "other_write_run").strip()
    raise RuntimeError(f"PROJECT_RUN_LOCKED:{active_operation}")


def _release_project_run_lock(supabase: Client, project_id: str, lock_token: str):
    if not project_id or not lock_token:
        return
    try:
        supabase.rpc(
            "release_audit_project_lock",
            {
                "p_project_id": project_id,
                "p_lock_token": lock_token,
            },
        ).execute()
    except Exception:
        return


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        
        try:
            data = json.loads(post_data)
        except Exception as e:
            self._send_error(400, f"Invalid JSON: {e}")
            return

        spreadsheet_id = data.get("spreadsheet_id")
        project_id = data.get("project_id")
        sheet_109_title = data.get("sheet_109_title") if isinstance(data.get("sheet_109_title"), str) else None
        if isinstance(sheet_109_title, str):
            sheet_109_title = sheet_109_title.strip() or None
        
        if not spreadsheet_id or not project_id:
            self._send_error(400, "Missing spreadsheet_id or project_id")
            return

        # Initialize Supabase
        supabase_url = os.environ.get("SUPABASE_URL")
        supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not supabase_url or not supabase_key:
            self._send_error(500, "Supabase environment variables not configured")
            return
        
        supabase: Client = create_client(supabase_url, supabase_key)
        
        lock_token = ""
        job_id = None

        try:
            lock_token = _try_acquire_project_run_lock(
                supabase,
                project_id,
                "formula_sync",
                "formula_sync_worker",
            )

            # Create job entry
            job_data = {
                "project_id": project_id,
                "type": "formula_sync",
                "status": "running",
                "result_meta": {"spreadsheet_id": spreadsheet_id, "sheet_109_title": sheet_109_title or ""}
            }
            job_res = supabase.table("jobs").insert(job_data).execute()
            job_id = job_res.data[0]["id"]

            # 1. Get Sheets Service
            service = get_sheets_service()
            
            # 2. Render main-sheet formula plan from current snapshot templates
            plan_109, meta_109 = load_current_snapshot_formula_plan(
                project_id=project_id,
                spreadsheet_id=spreadsheet_id,
                sheet_109_title=sheet_109_title,
                service=service,
            )
            resolved_sheet_109_title = str(meta_109.get("sheet") or sheet_109_title or "")

            # 2.5 Last-1ms consistency gate before physical writeback.
            consistency_gate = validate_snapshot_writeback_consistency(
                service=service,
                spreadsheet_id=spreadsheet_id,
                project_id=project_id,
                snapshot_meta=meta_109,
                plan=plan_109,
            )
            
            # 3. Execute Full Formula Sync
            sync_res = execute_109_formula_plan(
                service,
                spreadsheet_id,
                plan_109,
                meta_109,
                sheet_109_title=resolved_sheet_109_title,
            )
            expected_plan_count = len(plan_109)
            updated_ranges = int(sync_res.get("updated_ranges", 0) or 0)
            writeback_warnings = []
            if updated_ranges != expected_plan_count:
                writeback_warnings.append("WRITEBACK_RANGE_COUNT_MISMATCH")

            writeback_audit = {
                "snapshot_id": meta_109.get("snapshot_id"),
                "sync_run_id": meta_109.get("sync_run_id"),
                "plan_count": expected_plan_count,
                "updated_ranges": updated_ranges,
                "write_retry_count": int(sync_res.get("write_throttle", {}).get("retry_count", 0) or 0),
                "write_throttled_chunk_count": int(sync_res.get("write_throttle", {}).get("throttled_chunk_count", 0) or 0),
                "formula_lock_range_count": int(sync_res.get("formula_locks", {}).get("formula_lock_range_count", 0) or 0),
                "formula_lock_ranges": list(sync_res.get("formula_locks", {}).get("formula_lock_ranges", []) or []),
                "warnings": writeback_warnings,
            }
            _merge_writeback_metrics(supabase, str(meta_109.get("sync_run_id") or ""), writeback_audit)
            
            # 4. Update Job
            final_meta = {
                "spreadsheet_id": spreadsheet_id,
                "sheet_109_title": resolved_sheet_109_title,
                "formula_meta": meta_109,
                "consistency_gate": consistency_gate,
                "sync_summary": {
                    "formula_count": len(plan_109),
                    "updated_ranges": sync_res.get("updated_ranges", 0),
                    "write_retry_count": int(sync_res.get("write_throttle", {}).get("retry_count", 0) or 0),
                    "write_throttled_chunk_count": int(sync_res.get("write_throttle", {}).get("throttled_chunk_count", 0) or 0),
                    "formula_lock_range_count": int(sync_res.get("formula_locks", {}).get("formula_lock_range_count", 0) or 0),
                    "warnings": writeback_warnings,
                },
                "writeback_audit": writeback_audit,
                "sync_details": sync_res,
            }
            supabase.table("jobs").update({"status": "completed", "result_meta": final_meta}).eq("id", job_id).execute()

            self._send_json(
                200,
                {
                    "status": "success",
                    "job_id": job_id,
                    "message": "主表与保护规则已同步",
                    "spreadsheet_id": spreadsheet_id,
                    "summary": final_meta["sync_summary"],
                    "verify": sync_res.get("verify"),
                    "consistency_gate": consistency_gate,
                },
            )

        except SnapshotStaleError as e:
            if job_id:
                supabase.table("jobs").update({
                    "status": "failed",
                    "result_meta": {
                        "error_code": "SNAPSHOT_STALE_ERROR",
                        "error": str(e),
                        "spreadsheet_id": spreadsheet_id,
                        "snapshot_id": data.get("snapshot_id"),
                    }
                }).eq("id", job_id).execute()
            self._send_error(409, f"SNAPSHOT_STALE_ERROR: {e}")
        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            if str(e).startswith("PROJECT_RUN_LOCKED:"):
                self._send_error(409, str(e))
            else:
                if job_id:
                    supabase.table("jobs").update({
                        "status": "failed",
                        "result_meta": {
                            "error": str(e),
                            "traceback": error_trace
                        }
                    }).eq("id", job_id).execute()
                self._send_error(500, f"Processing failed: {e}")
        finally:
            if lock_token:
                _release_project_run_lock(supabase, project_id, lock_token)

    def _send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def _send_error(self, status_code, message):
        self._send_json(status_code, {"status": "error", "message": message})
