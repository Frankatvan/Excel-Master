import unittest
import pandas as pd
import finance_classification as fc
from unittest.mock import MagicMock

class TestFinanceLogicRisks(unittest.TestCase):
    def setUp(self):
        # Mock dependencies for finance_classification
        deps = {
            "_build_unit_budget_schedule_map": MagicMock(),
            "_contains_general_condition": lambda x: "GENERAL CONDITION" in str(x).upper(),
            "_ensure_column_count": lambda df, n: df,
            "_extract_tail_int": lambda x, n: int(str(x)[-n:]) if str(x)[-n:].isdigit() else None,
            "_find_col_in_headers": MagicMock(),
            "_find_col_in_row": MagicMock(),
            "_get_cell": MagicMock(),
            "_has_digits": lambda x: any(c.isdigit() for c in str(x)),
            "_load_default_unit_budget_schedule_overrides": MagicMock(return_value={}),
            "_normalize_amount_key": lambda x: round(float(x), 2),
            "_normalize_date_value": lambda x: pd.to_datetime(x) if x else None,
            "_normalize_text_key": lambda x: str(x).strip().upper(),
            "_safe_string": lambda x: str(x) if x is not None else "",
            "_sheet_key": lambda m, k: k,
            "_to_float": lambda x: float(x) if x is not None else None,
        }
        fc.configure_classification_dependencies(**deps)

    def test_racc_matching_fails_with_opposite_signs(self):
        # High Risk 1: ACC/RACC matching fails if signs are opposite
        # Final Detail row 1: ACC (Positive amount)
        # Final Detail row 2: RACC (Negative amount)
        
        vendor = "Test Vendor"
        activity_no = "ACT001"
        cost_code = "CC101"
        amount_acc = 100.0
        amount_racc = -100.0
        
        # Current implementation of key making
        key_acc = fc._make_final_detail_pair_key(vendor, activity_no, amount_acc, cost_code)
        key_racc = fc._make_final_detail_pair_key(vendor, activity_no, amount_racc, cost_code)
        
        self.assertNotEqual(key_acc, key_racc, "Keys should not match with opposite signs in current implementation")
        
        # If they don't match, RACC will not be identified correctly.

    def test_extract_tail_int_fails_on_short_code(self):
        # Medium Risk 2: Cost Code extraction vulnerability
        # _extract_tail_int(cost_code, 3)
        
        # If cost code is "50"
        cost_code = "50"
        result = fc._extract_tail_int(cost_code, 3)
        # In the summary it says it returns None if it's short
        self.assertIsNone(result, "Should return None for short cost code in current implementation")

if __name__ == "__main__":
    unittest.main()
