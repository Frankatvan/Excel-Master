
import sys
from pathlib import Path

# Add root to sys.path
sys.path.append(str(Path(__file__).parent.parent))

from finance_engine import _build_109_formula_plan_from_grid, update_109_semantic_logic, _merge_formula_plan_with_semantic_updates
import pandas as pd

def test_shadow_integration():
    # 1. Create a mock 109 grid with labels in Column C (idx 2)
    rows = [[""] * 18 for _ in range(50)]
    
    # Year header row (Row 10)
    rows[9][5] = "2021"
    rows[9][6] = "2022"
    rows[9][7] = "2023"
    rows[9][8] = "2024"
    rows[9][9] = "2025"
    rows[9][10] = "2026"
    
    # Contract Price Day 1
    rows[15][3] = "contract price (day1):"
    rows[15][4] = "1000000"

    # Material Margin
    rows[47][2] = "material margin"
    rows[48][2] = "material margin"

    # Define labels (using preferred semantic labels where possible)
    labels = {
        13: "Contract Amount",
        14: "Budget Surplus",
        16: "Contract Change Amount",
        22: "Day 1 Budget",
        24: "Owner-unapproved Overrun",
        25: "Current Dynamic EAC (Total Cost)", # Preferred label for EAC
        26: "Cumulative Direct Cost",
        27: "Cost of Goods Sold-Company",
        28: "Audit Adjustment (Current Period)", # Used by generator for confirmed cogs
        29: "Confirmed COGS (Current Period)",   # Preferred label for Confirmed COGS
        32: "Total ROE Cost",
        33: "ROE Cost - WB Home",
        34: "ROE Cost - WPRED",
        35: "Accrued Expenses",
        36: "Reversed Accrued Expenses",
        11: "Percentage of Completion (POC)",   # Preferred label for POC
        12: "Completion Rate for the Period",
        17: "General Conditions fee-Company",
        18: "General Conditions fee-Audited",
        19: "General Conditions fee",
        20: "Gross Profit-Company",
        21: "Gross Profit",
        30: "Accounts Receivable-Incurred",
        31: "Accounts Receivable-Audited",
        37: "Accounts Receivable-Company",
        38: "Accounts Receivable",
        39: "WB Home Income",
        40: "WB Home COGS",
        41: "WB Home Inventory Income",
        42: "WB Home Inventory",
        43: "WB Home Inventory Income-Reverse",
        44: "WB Home Inventory-Reverse",
        45: "WB. Home Material Margin Total",
        46: "Total Income Cost",
    }

    # Generator also needs some specific labels for its formulas
    labels[23] = "Cumulative Savings Target vs Actual"
    labels[14] = "Cumulative Savings Target vs Actual" # Reuse for Savings logic
    # Actually EAC = Initial Budget - Savings + Overrun
    # In check_finance, surplus is used as savings.
    
    # Let's add labels required by FinanceFormulaGenerator
    labels[22] = "Initial Budget (Original Contract Sum)"
    labels[24] = "Owner-unapproved Overrun"
    labels[15] = "Total Estimated Revenue"
    labels[18] = "Revenue Recognized (Current Period)"
    labels[20] = "Cumulative Revenue Recognized (Prior Period)"
    labels[26] = "Cumulative Total Cost (Actual)"
    labels[30] = "Cumulative Confirmed COGS (Prior Period)"

    for row_idx, label in labels.items():
        rows[row_idx][2] = label # Column C

    def get_merged_plan(grid_rows):
        plan, _ = _build_109_formula_plan_from_grid(grid_rows)
        semantic_updates = update_109_semantic_logic(grid_rows)
        return _merge_formula_plan_with_semantic_updates(plan, semantic_updates)

    # 2. Run formula generation on original grid
    plan_orig = get_merged_plan(rows)
    
    # 3. Create a shifted grid (add 5 empty rows at top)
    shifted_rows = [[""] * 18 for _ in range(5)] + rows
    
    # 4. Run formula generation on shifted grid
    plan_shifted = get_merged_plan(shifted_rows)
    
    def get_formula(plan, cell):
        for item in plan:
            if item['cell'] == cell:
                return item['formula']
        return None

    # Check EAC (Row 26 original, 31 shifted)
    orig_eac_f = get_formula(plan_orig, "F26")
    shifted_eac_f = get_formula(plan_shifted, "F31")
    
    print(f"Original F26 EAC Formula: {orig_eac_f}")
    print(f"Shifted F31 EAC Formula: {shifted_eac_f}")

    # Check POC (Row 12 original, 17 shifted)
    orig_poc_f = get_formula(plan_orig, "F12")
    shifted_poc_f = get_formula(plan_shifted, "F17")
    print(f"Original F12 POC Formula: {orig_poc_f}")
    print(f"Shifted F17 POC Formula: {shifted_poc_f}")

    # Check Confirmed COGS (Row 30 original, 35 shifted)
    orig_cogs_f = get_formula(plan_orig, "F30")
    shifted_cogs_f = get_formula(plan_shifted, "F35")
    print(f"Original F30 Confirmed COGS Formula: {orig_cogs_f}")
    print(f"Shifted F35 Confirmed COGS Formula: {shifted_cogs_f}")

    # Assertions for EAC
    # EAC Formula from Generator: =N(ref_initial) - N(ref_savings) + N(ref_overrun)
    # Original: ref_initial=F23, ref_savings=F15, ref_overrun=F25
    # Expected: =N(F23) - N(F15) + N(F25)
    assert orig_eac_f == "=N(F23) - N(F15) + N(F25)"
    assert shifted_eac_f == "=N(F28) - N(F20) + N(F30)"

    # Assertions for POC
    # POC Formula from Generator: =IFERROR(IF(N(ref_eac)=0, 0, N(ref_cogs) / N(ref_eac)), 0)
    # Original: ref_eac=F26, ref_cogs=F30
    assert orig_poc_f == "=IFERROR(IF(N(F26)=0, 0, N(F30) / N(F26)), 0)"
    assert shifted_poc_f == "=IFERROR(IF(N(F31)=0, 0, N(F35) / N(F31)), 0)"

    print("\nShadow Integration Verification PASSED!")

if __name__ == "__main__":
    test_shadow_integration()
