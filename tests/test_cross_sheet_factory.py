import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from finance_formulas import FinanceFormulaGenerator
from finance_mapping import MapperFactory


class CrossSheetFactoryTests(unittest.TestCase):
    def test_budgetco_mapper_reads_labels_from_b_column(self):
        values = [[""] * 4 for _ in range(10)]
        values[3][1] = "Total Savings Identified"

        mapper = MapperFactory.create("BudgetCO", values)

        self.assertEqual(4, mapper.get_row("Total Savings Identified"))
        self.assertEqual("G4", mapper.get_ref("Total Savings Identified", "G"))

    def test_budgetco_generic_formula_uses_g_column_from_config(self):
        values = [[""] * 4 for _ in range(10)]
        values[3][1] = "Total Savings Identified"
        values[4][1] = "Owner Contingency"
        values[5][1] = "Total Budget (EAC)"

        mapper = MapperFactory.create("BudgetCO", values)
        generator = FinanceFormulaGenerator(mapper, config=mapper.config)

        self.assertEqual("=N(G6)", generator.generate_generic_formula("eac_summary", "G"))
