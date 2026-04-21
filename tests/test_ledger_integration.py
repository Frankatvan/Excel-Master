import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import check_finance as cf
from finance_mapping import MapperFactory


def build_project_ledger_grid():
    rows = [[""] * 4 for _ in range(40)]
    rows[18][0] = "Total Actual Expenditure"
    rows[19][0] = "Accrual Adjustments"
    return rows


def build_109_semantic_grid_for_ledger():
    rows = [["", "", ""] for _ in range(60)]
    rows[49][2] = "Cumulative Total Cost (Actual)"
    return rows


class LedgerIntegrationTests(unittest.TestCase):
    def test_project_ledger_mapper_reads_labels_from_a_column(self):
        mapper = MapperFactory.create("Project Ledger", build_project_ledger_grid())

        self.assertEqual(19, mapper.get_row("Total Actual Expenditure"))
        self.assertEqual(20, mapper.get_row("Accrual Adjustments"))
        self.assertEqual("H19", mapper.get_ref("Total Actual Expenditure", "H"))

    def test_project_ledger_semantic_context_builds_shadow_reconcile_formula(self):
        context = cf.build_project_ledger_semantic_context(
            build_project_ledger_grid(),
            build_109_semantic_grid_for_ledger(),
            ledger_col="H",
            cost_col_109="F",
        )

        self.assertEqual(19, context["row_total_actuals"])
        self.assertEqual(20, context["row_accrual_adj"])
        self.assertEqual(50, context["row_109_cumulative_cost"])
        self.assertEqual("H19", context["total_actuals_ref"])
        self.assertEqual("H20", context["accrual_adj_ref"])
        self.assertEqual("F50", context["cumulative_cost_109_ref"])
        self.assertEqual("=N(H19) + N(H20)", context["ledger_total_formula"])
        self.assertEqual("=N(H19) + N(H20) = N(F50)", context["shadow_reconcile_formula"])


if __name__ == "__main__":
    unittest.main()
