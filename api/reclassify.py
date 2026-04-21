import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Add the logic directory to the Python path
sys.path.append(str(Path(__file__).parent / "logic"))

import pandas as pd
from finance_engine import get_sheets_service, run_apps_shadow_pipeline, execute_commit, build_commit_bundle
from finance_utils import get_sheets_service
from supabase import create_client, Client

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
        
        # Create job entry
        job_data = {
            "project_id": project_id,
            "type": "reclassify",
            "status": "running",
            "result_meta": {"spreadsheet_id": spreadsheet_id}
        }
        job_res = supabase.table("jobs").insert(job_data).execute()
        job_id = job_res.data[0]["id"]

        try:
            # 1. Get Sheets Service
            service = get_sheets_service()
            
            # 2. Fetch all needed sheets
            target_sheets = ["Payable", "Scoping", "Final Detail", "Unit Budget", "Unit Master"]
            sheet_map = {}
            spreadsheet = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
            
            for s in spreadsheet.get("sheets", []):
                title = s["properties"]["title"]
                if title in target_sheets:
                    res = service.spreadsheets().values().get(
                        spreadsheetId=spreadsheet_id, 
                        range=f"{title}!A:AZ",
                        valueRenderOption="UNFORMATTED_VALUE"
                    ).execute()
                    values = res.get("values", [])
                    if values:
                        headers = values[0]
                        # Handle duplicate headers or empty headers if necessary, but simple for now
                        df = pd.DataFrame(values[1:], columns=headers[:len(values[1][0])] if values[1:] else headers)
                        # Re-normalize if needed, but for logic we use values directly sometimes
                        # Better use values_to_dataframe from utils
                        from finance_utils import _values_to_dataframe
                        sheet_map[title] = _values_to_dataframe(values)

            # 3. Run Pipeline
            uid_column = "AiWB_UID"
            shadow_cfg = {
                "revenue_col": "Revenue Recognized (Current Period)",
                "cost_col": "Cumulative Total Cost (Actual)",
                "profit_col": "ROE (Current Period)",
                "tax_rate_col": "Corporate Tax Rate",
                "tax_col": "Corporate Tax",
                "tolerance": 0.01
            }
            
            working_map, reports, audit_lines = run_apps_shadow_pipeline(
                sheet_map, 
                uid_column=uid_column,
                shadow_cfg=shadow_cfg
            )
            
            # 4. Build Commit Bundle
            bundle = build_commit_bundle(
                original_map=sheet_map,
                edited_map=working_map,
                target_sheets=["Payable", "Final Detail", "Unit Budget"],
                uid_column=uid_column,
                amount_column="Amount",
                entity_column="WBH"
            )
            
            # 5. Execute Commit
            commit_res = execute_commit(
                service, 
                spreadsheet_id, 
                bundle, 
                guard_sheet_name="Project Ledger",
                expected_first_cell="Project Ledger"
            )
            
            # 6. Update Job
            final_meta = {
                "spreadsheet_id": spreadsheet_id,
                "reports": reports,
                "commit_summary": bundle["summary"],
                "commit_details": commit_res
            }
            supabase.table("jobs").update({"status": "completed", "result_meta": final_meta}).eq("id", job_id).execute()

            self._send_json(200, {"status": "success", "job_id": job_id, "summary": bundle["summary"]})

        except Exception as e:
            import traceback
            error_trace = traceback.format_exc()
            supabase.table("jobs").update({
                "status": "failed", 
                "result_meta": {
                    "error": str(e),
                    "traceback": error_trace
                }
            }).eq("id", job_id).execute()
            self._send_error(500, f"Processing failed: {e}")

    def _send_json(self, status_code, data):
        self.send_response(status_code)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def _send_error(self, status_code, message):
        self._send_json(status_code, {"status": "error", "message": message})
