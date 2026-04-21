import os
import sys
# Add root directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import finance_utils as utils

SPREADSHEET_ID = "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw"

def main():
    service = utils.get_sheets_service()
    resp = service.spreadsheets().values().get(spreadsheetId=SPREADSHEET_ID, range="109!A1:Z200").execute()
    values = resp.get("values", [])
    for i, row in enumerate(values):
        for j, cell in enumerate(row):
            if "Contract price" in str(cell):
                print(f"Row {i+1}, Col {chr(ord('A')+j)}: {cell}")

if __name__ == "__main__":
    main()
