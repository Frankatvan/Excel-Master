
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# --- Re-implemented utility functions from finance_utils.py ---

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
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
        "type",
        "project_id",
        "private_key_id",
        "private_key",
        "client_email",
        "client_id",
        "auth_uri",
        "token_uri",
        "auth_provider_x509_cert_url",
        "client_x509_cert_url",
        "universe_domain",
    ]
    if all(key in secrets for key in keys[:10]):
        return {key: _get_secret(secrets, key) for key in keys if key in secrets}

    fallback_file = str(
        _get_secret(
            secrets,
            "SERVICE_ACCOUNT_FILE",
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


def main():
    service = get_sheets_service()
    spreadsheet_id = get_spreadsheet_id()
    
    if not spreadsheet_id:
        print("SPREADSHEET_ID not found.")
        return

    sheet_name = '109'

    # 1. Get Formulas
    formula_ranges = [
        f"{sheet_name}!F19", f"{sheet_name}!G19", f"{sheet_name}!R19",
        f"{sheet_name}!F30", f"{sheet_name}!G30", f"{sheet_name}!R30",
        f"{sheet_name}!F52", f"{sheet_name}!G52", f"{sheet_name}!R52",
    ]
    
    result = service.spreadsheets().values().batchGet(
        spreadsheetId=spreadsheet_id,
        ranges=formula_ranges,
        valueRenderOption='FORMULA'
    ).execute()
    
    print("--- Formulas ---")
    for value_range in result.get('valueRanges', []):
        range_name = value_range.get('range')
        formula = value_range.get('values', [['']])[0][0]
        print(f"Cell: {range_name}, Formula: {formula}")

    # 2. Get Labels and Colors for rows 27, 29, 37
    # We need to get the whole row to get the label from column A or D
    # and the background color of the specific cells.
    # Let's read columns A-R for these rows.
    label_ranges = [
        f"{sheet_name}!A27:R27",
        f"{sheet_name}!A29:R29",
        f"{sheet_name}!A37:R37",
    ]
    
    sheet_metadata = service.spreadsheets().get(
        spreadsheetId=spreadsheet_id,
        ranges=label_ranges,
        fields="sheets(data(rowData(values(formattedValue,userEnteredFormat(backgroundColor)))))"
    ).execute()

    print("\n--- Labels and Colors ---")
    
    data = sheet_metadata['sheets'][0]['data']
    for i, row_data in enumerate(data):
        row_num = [27, 29, 37][i]
        
        row_values = row_data.get('rowData', [{}])[0].get('values', [])
        
        # Try to find a label in column A, C, or D
        label = ""
        # index 0 is column A, 2 is C, 3 is D
        for col_idx in [0, 2, 3]:
            if col_idx < len(row_values) and 'formattedValue' in row_values[col_idx] and row_values[col_idx].get('formattedValue'):
                label = row_values[col_idx].get('formattedValue')
                if label:
                    break
        if not label and len(row_values)>0 and 'formattedValue' in row_values[0]:
            label = row_values[0].get('formattedValue', f'Row {row_num} (No Label)')


        print(f"Row: {row_num}, Label: '{label}'")

        # Column F is index 5, G is 6, R is 17
        for col_name, col_idx in [('F', 5), ('G', 6), ('R', 17)]:
            color = "N/A"
            if col_idx < len(row_values):
                cell_format = row_values[col_idx].get('userEnteredFormat', {})
                if 'backgroundColor' in cell_format:
                    color = cell_format['backgroundColor']
            print(f"  - Column {col_name}: Background Color = {color}")


if __name__ == '__main__':
    main()
