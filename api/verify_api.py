import sys
import os
from pathlib import Path

# Add logic directory to path
sys.path.append(str(Path(__file__).parent / "logic"))

def verify_imports():
    print("Verifying imports...")
    try:
        import pandas as pd
        import googleapiclient
        import supabase
        import finance_engine
        import finance_utils
        import finance_services
        print("✅ Core logic imports successful.")
    except ImportError as e:
        print(f"❌ Import failed: {e}")
        sys.exit(1)

def verify_handlers():
    print("Verifying API handlers...")
    try:
        from reclassify import handler as reclassify_handler
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
