import os
import sys
import unittest
import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import finance_classification as fc
import check_finance as cf
from unittest.mock import MagicMock

class TestFinanceLogicFixes(unittest.TestCase):
    def setUp(self):
        # Mock dependencies for finance_classification
        self.deps = {
            "build_unit_budget_schedule_map": MagicMock(),
            "contains_general_condition": lambda x: "GENERAL CONDITION" in str(x).upper(),
            "ensure_column_count": lambda df, n: df,
            "extract_tail_int": cf._extract_tail_int,
            "find_col_in_headers": MagicMock(),
            "find_col_in_row": MagicMock(),
            "get_cell": MagicMock(),
            "has_digits": lambda x: any(c.isdigit() for c in str(x)),
            "load_default_unit_budget_schedule_overrides": MagicMock(return_value={}),
            "normalize_amount_key": cf._normalize_amount_key,
            "normalize_date_value": cf._normalize_date_value,
            "normalize_text_key": cf._normalize_text_key,
            "safe_string": cf._safe_string,
            "sheet_key": lambda m, k: k,
            "to_float": cf._to_float,
        }
        self.sheet_map = {
            "Payable": pd.DataFrame(),
            "Scoping": pd.DataFrame(),
            "Final Detail": pd.DataFrame(),
            "Unit Budget": pd.DataFrame(),
        }
        self.service = fc.ClassificationService(self.sheet_map, self.deps)

    def test_racc_matching_succeeds_with_opposite_signs(self):
        # High Risk 1 Fix: ACC/RACC matching should succeed if signs are opposite
        vendor = "Test Vendor"
        activity_no = "ACT001"
        cost_code = "CC101"
        amount_acc = 100.0
        amount_racc = -100.0
        
        key_acc = self.service._make_final_detail_pair_key(vendor, activity_no, amount_acc, cost_code)
        key_racc = self.service._make_final_detail_pair_key(vendor, activity_no, amount_racc, cost_code)
        
        self.assertEqual(key_acc, key_racc, "Keys should match with opposite signs after fix")

    def test_extract_tail_int_succeeds_on_short_code(self):
        # Medium Risk 2 Fix: Cost Code extraction should handle short numeric codes
        cost_code = "50"
        result = cf._extract_tail_int(cost_code, 3)
        self.assertEqual(50, result, "Should return 50 for short cost code '50' after fix")

    def test_derive_unit_budget_actual_settlement_fields_prioritizes_co_date(self):
        # Risk 3 Fix: Prioritize co_date derived year over existing column
        # Unit row, existing year 2025, co_date derived year 2026
        # actual_date for "2025-12-01" is "2026-01-31"
        actual_date, actual_year = cf._derive_unit_budget_actual_settlement_fields(
            "14403DD", 2025, "2025-12-01", None
        )
        self.assertEqual("2026-01-31", actual_date)
        self.assertEqual(2026, actual_year, "Should pick 2026 (from co_date) even if 2025 is in the column")

if __name__ == "__main__":
    unittest.main()
