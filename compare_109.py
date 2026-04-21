import json

def compare_sheets(baseline_path, current_path):
    with open(baseline_path, 'r') as f:
        baseline = json.load(f)
    with open(current_path, 'r') as f:
        current = json.load(f)

    baseline_rows = baseline['rows']
    current_rows = current['rows']

    print(f"Baseline rows: {len(baseline_rows)}")
    print(f"Current rows: {len(current_rows)}")

    # 1. Label changes in Column D (index 3)
    print("\n--- Column D (Labels) Changes ---")
    max_rows = max(len(baseline_rows), len(current_rows))
    for i in range(min(100, max_rows)):
        b_label = ""
        if i < len(baseline_rows) and len(baseline_rows[i]) > 3:
            b_label = baseline_rows[i][3].get('v', '')
        
        c_label = ""
        if i < len(current_rows) and len(current_rows[i]) > 3:
            c_label = current_rows[i][3].get('v', '')
            
        if b_label != c_label:
            print(f"Row {i+1}: '{b_label}' -> '{c_label}'")

    # 2. Identify new rows
    # Since current has 64 and baseline has 61, let's look for where they diverge.
    print("\n--- New Rows Detection ---")
    # Simple heuristic: compare rows one by one. If they don't match, one might be inserted.
    # But since it's just 3 rows, maybe they are at the end or inserted in the middle.
    
    # Let's try to align them by some unique identifier if possible, but we don't have one other than content.
    # Let's just print the 3 extra rows if it's a simple append, or find insertions.
    
    # Actually, the user says "识别新增的三行及其公式".
    # Let's look at the content of the extra rows.
    
    # Better approach: find rows in 'current' that are not in 'baseline' (by content)
    # or just show rows where the count changed significantly.
    
    # 3. Row 37 check
    print("\n--- Row 37 Check ---")
    if len(current_rows) >= 37:
        r37 = current_rows[36]
        print(f"Row 37 total columns: {len(r37)}")
        for j, cell in enumerate(r37):
            if cell.get('f') or cell.get('v'):
                col_letter = chr(ord('A') + j) if j < 26 else f"A{chr(ord('A') + j - 26)}"
                print(f"Col {col_letter}: v='{cell.get('v')}', f='{cell.get('f', 'N/A')}'")

    # 4. Column R (index 17) changes
    print("\n--- Column R Formulas ---")
    for i in range(min(100, max_rows)):
        b_formula = ""
        if i < len(baseline_rows) and len(baseline_rows[i]) > 17:
            b_formula = baseline_rows[i][17].get('f', '')
        
        c_formula = ""
        if i < len(current_rows) and len(current_rows[i]) > 17:
            c_formula = current_rows[i][17].get('f', '')
            
        if b_formula != c_formula:
            print(f"Row {i+1} R Formula: '{b_formula}' -> '{c_formula}'")

if __name__ == "__main__":
    compare_sheets('.aiwb_local/109_reverse_baseline.json', '.aiwb_local/109_current.json')
