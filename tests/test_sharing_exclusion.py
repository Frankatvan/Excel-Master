import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import unittest
import pandas as pd
import finance_classification as fc
import check_finance as cf
from unittest.mock import MagicMock

class TestSharingExclusion(unittest.TestCase):
    def setUp(self):
        # Configure common dependencies
        self.mock_build_unit_budget_schedule_map = MagicMock()
        self.mock_load_default_unit_budget_schedule_overrides = MagicMock(return_value={})
        self.common_deps = {
            "build_unit_budget_schedule_map": self.mock_build_unit_budget_schedule_map,
            "contains_general_condition": cf._contains_general_condition,
            "ensure_column_count": cf._ensure_column_count,
            "extract_tail_int": cf._extract_tail_int,
            "find_col_in_headers": cf._find_col_in_headers,
            "find_col_in_row": cf._find_col_in_row,
            "get_cell": cf._get_cell,
            "has_digits": cf._has_digits,
            "load_default_unit_budget_schedule_overrides": self.mock_load_default_unit_budget_schedule_overrides,
            "normalize_amount_key": cf._normalize_amount_key,
            "normalize_date_value": cf._normalize_date_value,
            "normalize_text_key": cf._normalize_text_key,
            "safe_string": cf._safe_string,
            "sheet_key": cf._sheet_key,
            "to_float": cf._to_float,
        }
        self.empty_sheet_map = {
            "Payable": pd.DataFrame(),
            "Scoping": pd.DataFrame(),
            "Final Detail": pd.DataFrame(),
            "Unit Budget": pd.DataFrame(),
        }

    def test_classify_final_detail_record_excludes_sharing_type(self):
        # Setup mocks specific to this test
        self.mock_build_unit_budget_schedule_map.return_value = {} # Not strictly needed for this test's path but good practice

        # Instantiate service with configured mocks
        service = fc.ClassificationService(self.empty_sheet_map, self.common_deps)

        # R001: Type='Sharing' should be excluded
        decision = service._classify_final_detail_record(
            unit_code="14403DD",
            vendor="Test Vendor",
            amount=100.0,
            cost_code="50123",
            activity_no="ACT001",
            incurred_date=None,
            final_date="2026-04-19",
            statuses={1}, # Usually ACC
            actual_settlement_date="2025-01-01",
            tbd_acceptance_date=None,
            paired_racc_keys=set(),
            record_type="Sharing"
        )
        
        self.assertEqual("R001", decision.rule_id)
        self.assertEqual("Excluded", decision.category)
        self.assertEqual("Sharing", decision.evidence["type"])

    def test_sharing_rows_ignored_in_index_building(self):
        # Create a DataFrame with one Sharing row and one normal ACC candidate
        df = pd.DataFrame([
            ["14403DD", "ACT1", "Vendor A", 100, "50123", None, "2026-04-19", "Sharing"],
            ["14407DD", "ACT2", "Vendor B", 200, "50123", None, "2026-04-19", "Regular"]
        ], columns=["Unit Code", "Activity No.", "Vendor", "Amount", "Cost Code", "Incurred Date", "Final Date", "Type"])
        
        # Mock status map and schedule map to pass filters
        status_map = {123: {1}}
        unit_schedule_map_data = {
            "14403DD": {"actual_settlement_date": pd.Timestamp("2025-01-01")},
            "14407DD": {"actual_settlement_date": pd.Timestamp("2025-01-01")}
        }
        
        # Configure the mock before instantiating the service
        self.mock_build_unit_budget_schedule_map.return_value = unit_schedule_map_data

        # We need a service instance with a real sheet map to test this
        sheet_map = {
            "Payable": pd.DataFrame(),
            "Scoping": pd.DataFrame(),
            "Final Detail": df,
            "Unit Budget": pd.DataFrame(),
        }
        
        service = fc.ClassificationService(sheet_map, self.common_deps)
        
        with unittest.mock.patch.object(service, '_build_scoping_status_map', return_value=status_map):
            index = service._build_final_detail_classification_index(df, status_map, service.unit_schedule_map)
        
        # Only the Regular row should contribute to acc_pair_keys
        self.assertEqual(1, index["acc_pair_key_count"])
        # The Sharing row (ACT1) should not be in paired_racc_keys
        pair_keys = index["paired_racc_keys"]
        self.assertFalse(any("ACT1" in str(k) for k in pair_keys))

if __name__ == "__main__":
    unittest.main()
