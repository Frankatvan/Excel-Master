import os
import sys
import json

# Add root directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '.')))

import finance_utils as utils

SPREADSHEET_ID = "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw"

def main():
    service = utils.get_sheets_service()
    range_name = "'109'!A62:C150"
    resp = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID,
        range=range_name,
        valueRenderOption="FORMATTED_VALUE"
    ).execute()
    
    values = resp.get("values", [])
    for i, row in enumerate(values):
        col_a = row[0] if len(row) > 0 else ""
        col_c = row[2] if len(row) > 2 else ""
        if col_a or col_c:
            print(f"Row {i+62}: A='{col_a}', C='{col_c}'")

if __name__ == "__main__":
    main()
