
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# --- Copied from fetch_109_formulas.py for self-containment ---

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
]
DEFAULT_SERVICE_ACCOUNT_FILE = "credentials.json"

def _get_secret(secrets: dict, name: str, default: Any = None) -> Any:
    if name in secrets:
        return secrets[name]
    if "app" in secrets and name in secrets["app"]:
        return secrets["app"][name]
    return default

def _get_service_account_info() -> Dict[str, Any]:
    secrets = {}
    secrets_path = Path(".streamlit/secrets.toml")
    if secrets_path.exists():
        import toml
        secrets = toml.load(secrets_path)

    if "gcp_service_account" in secrets:
        return dict(secrets["gcp_service_account"])

    keys = [
        "type", "project_id", "private_key_id", "private_key", "client_email",
        "client_id", "auth_uri", "token_uri", "auth_provider_x509_cert_url",
        "client_x509_cert_url", "universe_domain",
    ]
    if all(key in secrets for key in keys[:10]):
        return {key: _get_secret(secrets, key) for key in keys if key in secrets}

    fallback_file = str(
        _get_secret(
            secrets, "SERVICE_ACCOUNT_FILE",
            os.getenv("GOOGLE_APPLICATION_CREDENTIALS", DEFAULT_SERVICE_ACCOUNT_FILE),
        )
    ).strip()
    file_path = Path(fallback_file)
    if file_path.exists():
        return json.loads(file_path.read_text(encoding="utf-8"))

    raise RuntimeError(
        "未找到 Service Account 凭证。请配置 .streamlit/secrets.toml 的 [gcp_service_account] "
        f"或提供 {DEFAULT_SERVICE_ACCOUNT_FILE}。"
    )

def get_sheets_service():
    creds = Credentials.from_service_account_info(_get_service_account_info(), scopes=SCOPES)
    return build("sheets", "v4", credentials=creds, cache_discovery=False)

def get_spreadsheet_id():
    secrets = {}
    secrets_path = Path(".streamlit/secrets.toml")
    if secrets_path.exists():
        import toml
        secrets = toml.load(secrets_path)
    
    return str(_get_secret(secrets, "SPREADSHEET_ID", os.getenv("SPREADSHEET_ID", ""))).strip()

def col_int_to_str(n):
    """Converts a 0-indexed column integer to a column letter string."""
    s = ""
    n += 1
    while n > 0:
        n, remainder = divmod(n - 1, 26)
        s = chr(65 + remainder) + s
    return s

def fetch_formulas_with_retry(service, spreadsheet_id, sheet_name, range_to_fetch, max_retries=5, backoff_factor=2):
    """Fetches formulas from a given range with retry and backoff logic."""
    for attempt in range(max_retries):
        try:
            result = service.spreadsheets().values().get(
                spreadsheetId=spreadsheet_id,
                range=range_to_fetch,
                valueRenderOption='FORMULA'
            ).execute()
            return result
        except HttpError as e:
            if e.resp.status in [429, 500, 503]:
                wait_time = backoff_factor ** attempt
                print(f"API Error ({e.resp.status}), retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                raise e
    raise Exception(f"Failed to fetch data after {max_retries} retries.")


def main():
    service = get_sheets_service()
    spreadsheet_id = get_spreadsheet_id()
    
    if not spreadsheet_id:
        print("SPREADSHEET_ID not found.")
        return

    sheet_name = '109'
    start_col_char = 'E'
    end_col_char = 'R'
    
    start_col_int = ord(start_col_char) - ord('A')
    end_col_int = ord(end_col_char) - ord('A')

    print(f"Starting deep scan of Google Sheet '{sheet_name}'...")

    try:
        sheet_metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id, fields='sheets(properties(title,gridProperties(rowCount)))').execute()
        sheets = sheet_metadata.get('sheets', [])
        target_sheet = next((s for s in sheets if s.get("properties", {}).get("title") == sheet_name), None)

        if not target_sheet:
            print(f"Sheet '{sheet_name}' not found in the spreadsheet.")
            return

        rowCount = target_sheet.get("properties", {}).get("gridProperties", {}).get("rowCount")
        print(f"Sheet '{sheet_name}' has {rowCount} rows.")

        all_formulas = []
        chunk_size = 500 # Read in chunks of 500 rows

        for start_row in range(1, rowCount + 1, chunk_size):
            end_row = min(start_row + chunk_size - 1, rowCount)
            range_to_fetch = f"'{sheet_name}'!{start_col_char}{start_row}:{end_col_char}{end_row}"
            print(f"Fetching range: {range_to_fetch}")

            try:
                result = fetch_formulas_with_retry(service, spreadsheet_id, sheet_name, range_to_fetch)
            except Exception as e:
                print(f"Error fetching range {range_to_fetch}. Trying smaller chunks.")
                # Fallback to smaller chunks if the large chunk fails
                for sub_start_row in range(start_row, end_row + 1, 100):
                    sub_end_row = min(sub_start_row + 99, end_row)
                    small_range = f"'{sheet_name}'!{start_col_char}{sub_start_row}:{end_col_char}{sub_end_row}"
                    print(f"  Fetching smaller range: {small_range}")
                    try:
                        result = fetch_formulas_with_retry(service, spreadsheet_id, sheet_name, small_range)
                        # process result
                        values = result.get('values', [])
                        for r_idx, row in enumerate(values):
                            for c_idx, cell_value in enumerate(row):
                                if isinstance(cell_value, str) and cell_value.startswith('='):
                                    cell_col_str = col_int_to_str(start_col_int + c_idx)
                                    cell_row_int = sub_start_row + r_idx
                                    cell_coord = f"{cell_col_str}{cell_row_int}"
                                    all_formulas.append({"cell": cell_coord, "formula": cell_value})
                    except Exception as final_e:
                        print(f"    Failed to fetch smaller range {small_range}: {final_e}. Skipping.")
                        continue # Move to next smaller chunk
                continue # Move to next larger chunk
            
            values = result.get('values', [])
            for r_idx, row in enumerate(values):
                for c_idx, cell_value in enumerate(row):
                    if isinstance(cell_value, str) and cell_value.startswith('='):
                        cell_col_str = col_int_to_str(start_col_int + c_idx)
                        cell_row_int = start_row + r_idx
                        cell_coord = f"{cell_col_str}{cell_row_int}"
                        all_formulas.append({"cell": cell_coord, "formula": cell_value})


        output_path = Path('.aiwb_local/golden_formulas.json')
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(all_formulas, f, indent=2, ensure_ascii=False)

        print(f"Successfully extracted {len(all_formulas)} formulas.")
        print(f"Results saved to {output_path}")

    except HttpError as error:
        print(f"An API error occurred: {error}")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == '__main__':
    main()
