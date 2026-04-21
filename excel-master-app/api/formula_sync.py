import json
import os
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Add the logic directory to the Python path
sys.path.append(str(Path(__file__).parent / "logic"))

from finance_engine import get_sheets_service, generate_109_formula_plan, execute_commit
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
            "type": "formula_sync",
            "status": "running",
            "result_meta": {"spreadsheet_id": spreadsheet_id}
        }
        job_res = supabase.table("jobs").insert(job_data).execute()
        job_id = job_res.data[0]["id"]

        try:
            # 1. Get Sheets Service
            service = get_sheets_service()
            
            # 2. Generate 109 Formula Plan
            plan_109, meta_109 = generate_109_formula_plan(service, spreadsheet_id)
            
            # 3. Execute Commit
            bundle = {
                "updates": plan_109,
                "summary": {"formula_count": len(plan_109)}
            }
            
            commit_res = execute_commit(
                service, 
                spreadsheet_id, 
                bundle, 
                guard_sheet_name="Project Ledger",
                expected_first_cell="Project Ledger"
            )
            
            # 4. Update Job
            final_meta = {
                "spreadsheet_id": spreadsheet_id,
                "formula_meta": meta_109,
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
