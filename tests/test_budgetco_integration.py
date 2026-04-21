import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import check_finance as cf
from finance_mapping import MapperFactory


class BudgetCOIntegrationTest(unittest.TestCase):
    def test_budgetco_row_discovery(self):
        mock_values = [[""] * 5 for _ in range(100)]
        mock_values[34][1] = "Total Savings Identified"
        mock_values[39][1] = "Owner Contingency"

        mapper = MapperFactory.create("BudgetCO", mock_values)

        self.assertEqual(35, mapper.get_row("Total Savings Identified"))
        self.assertEqual(40, mapper.get_row("Owner Contingency"))

    def test_budgetco_semantic_summary_context_uses_b_column_mapping(self):
        mock_values = [[""] * 5 for _ in range(100)]
        mock_values[34][1] = "Total Savings Identified"
        mock_values[39][1] = "Owner Contingency"
        mock_values[44][1] = "Total Budget (EAC)"

        context = cf.build_budgetco_semantic_summary_context(mock_values, start_col="G")

        self.assertEqual(35, context["row_savings"])
        self.assertEqual(40, context["row_contingency"])
        self.assertEqual(45, context["row_total_eac"])
        self.assertEqual("G35", context["savings_ref"])
        self.assertEqual("G40", context["contingency_ref"])
        self.assertEqual("=N(G45)", context["eac_formula"])
