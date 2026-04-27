import sys
import os
import importlib.util
from pathlib import Path

api_path = str(Path(__file__).parent)
if api_path not in sys.path:
    sys.path.insert(0, api_path)

# Add both local compatibility logic and canonical package logic to the Python path.
api_dir = Path(__file__).resolve().parent
workspace_root = api_dir.parent.parent if api_dir.parent.name == "excel-master-app" else api_dir.parent
for logic_dir in [api_dir / "logic", workspace_root / "excel-master-app" / "api" / "logic"]:
    logic_path = str(logic_dir)
    if logic_dir.exists() and logic_path not in sys.path:
        sys.path.insert(0, logic_path)

def verify_imports():
    print("Verifying imports...")
    try:
        import pandas as pd
        import googleapiclient
        import supabase
        import aiwb_finance.finance_engine
        import aiwb_finance.finance_utils
        import aiwb_finance.finance_services
        print("✅ Core logic imports successful.")
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        sys.exit(1)

def verify_handlers():
    print("Verifying API handlers...")
    try:
        reclassify_job_candidates = [
            Path(__file__).parent / "internal" / "reclassify_job.py",
            Path(__file__).parents[1] / "excel-master-app" / "api" / "internal" / "reclassify_job.py",
        ]
        reclassify_job_path = next((path for path in reclassify_job_candidates if path.exists()), reclassify_job_candidates[0])
        spec = importlib.util.spec_from_file_location("reclassify_job", reclassify_job_path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Unable to load {reclassify_job_path}")
        reclassify_job = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reclassify_job)
        reclassify_handler = reclassify_job.handler
        from formula_sync import handler as formula_sync_handler
        print("✅ API handlers loaded successful.")
    except Exception as e:
        print(f"❌ Handler loading failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    # Mock some env vars for import test
    os.environ["GOOGLE_CREDENTIALS_JSON"] = "{}"
    os.environ["SUPABASE_URL"] = "https://example.supabase.co"
    os.environ["SUPABASE_SERVICE_ROLE_KEY"] = "dummy"
    
    verify_imports()
    verify_handlers()
    print("All good!")
