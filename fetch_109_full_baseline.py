import os
import sys
import json
from datetime import datetime

# Add root directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '.')))

import finance_utils as utils

SPREADSHEET_ID = "1g17SLJDKIT9rM5Vi4xQoD_pa4byvDPE6gJvRwi5bQDw"
SHEET_NAME = "109"
OUTPUT_FILE = ".aiwb_local/109_reverse_baseline.json"

def main():
    print(f"Fetching full state of sheet '{SHEET_NAME}' from spreadsheet {SPREADSHEET_ID}...")
    service = utils.get_sheets_service()
    
    # Use spreadsheets().get to fetch grid data including formulas and formatted values
    # We use fields to minimize payload size
    fields = "sheets(properties(title),data(rowData(values(userEnteredValue,formattedValue))))"
    
    try:
        resp = service.spreadsheets().get(
            spreadsheetId=SPREADSHEET_ID,
            ranges=[SHEET_NAME],
            includeGridData=True,
            fields=fields
        ).execute()
        
        sheet = resp['sheets'][0]
        data = sheet['data'][0]
        row_data = data.get('rowData', [])
        
        baseline = {
            "spreadsheet_id": SPREADSHEET_ID,
            "sheet_name": SHEET_NAME,
            "fetched_at": datetime.now().isoformat(),
            "rows": []
        }
        
        labels_map = {} # label (Col D) -> row_number (1-based)
        
        for i, row in enumerate(row_data):
            row_number = i + 1
            cells = row.get('values', [])
            row_baseline = []
            
            for j, cell in enumerate(cells):
                cell_data = {
                    "v": cell.get('formattedValue', ""),
                }
                # Check for formula
                user_val = cell.get('userEnteredValue', {})
                if 'formulaValue' in user_val:
                    cell_data['f'] = user_val['formulaValue']
                
                row_baseline.append(cell_data)
                
                # Column D is index 3
                if j == 3:
                    label = cell.get('formattedValue', "").strip()
                    if label:
                        labels_map[label] = row_number
            
            baseline["rows"].append(row_baseline)
        
        baseline["labels_map"] = labels_map
        
        # Save to file
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump(baseline, f, ensure_ascii=False, indent=2)
            
        print(f"Successfully saved baseline to {OUTPUT_FILE}")
        print(f"Total rows: {len(baseline['rows'])}")
        print(f"Total labels recorded: {len(labels_map)}")
        
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
