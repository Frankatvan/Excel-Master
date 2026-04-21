import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator


class FinanceFormulaGeneratorTests(unittest.TestCase):
    def test_formula_generation_logic(self):
        mock_values = [[""] * 5 for _ in range(70)]
        mock_values[22][2] = "Initial Budget (Original Contract Sum)"
        mock_values[23][2] = "Cumulative Savings (Target vs Actual)"
        mock_values[24][2] = "Owner-unapproved Overrun"
        mock_values[29][2] = "Current Dynamic EAC (Total Cost)"
        mock_values[39][2] = "Confirmed COGS (Current Period)"
        mock_values[11][2] = "Percentage of Completion (POC)"
        mock_values[15][2] = "Total Estimated Revenue"
        mock_values[18][2] = "Revenue Recognized (Current Period)"
        mock_values[20][2] = "Cumulative Revenue Recognized (Prior Period)"
        mock_values[44][2] = "Audit Adjustment (Current Period)"
        mock_values[49][2] = "Cumulative Total Cost (Actual)"
        mock_values[54][2] = "Cumulative Confirmed COGS (Prior Period)"

        mapper = ExcelSemanticMapper()
        mapper.scan_sheet(mock_values)

        generator = FinanceFormulaGenerator(mapper)

        self.assertEqual(
            "=N(F23) - N(F24) + N(F25)",
            generator.get_eac_formula("F"),
        )
        self.assertEqual(
            "=IFERROR(IF(N(G30)=0, 0, N(G40) / N(G30)), 0)",
            generator.get_poc_formula("G"),
        )
        self.assertEqual(
            "=N(H12) * N(H16) - N(H21)",
            generator.get_revenue_formula("H"),
        )
        self.assertEqual(
            "=N(H19) - N(H40)",
            generator.get_roe_formula("H"),
        )

        range_plan = generator.generate_column_range("F", "H")
        self.assertEqual(
            {
                "F": {
                    "EAC": "=N(F23) - N(F24) + N(F25)",
                    "POC": "=IFERROR(IF(N(F30)=0, 0, N(F40) / N(F30)), 0)",
                    "Revenue": "=N(F12) * N(F16) - N(F21)",
                    "ROE": "=N(F19) - N(F40)",
                    "Confirmed_COGS": "=IF(F45<>\"\", F45, N(F50) - N(F55))",
                },
                "G": {
                    "EAC": "=N(G23) - N(G24) + N(G25)",
                    "POC": "=IFERROR(IF(N(G30)=0, 0, N(G40) / N(G30)), 0)",
                    "Revenue": "=N(G12) * N(G16) - N(G21)",
                    "ROE": "=N(G19) - N(G40)",
                    "Confirmed_COGS": "=IF(G45<>\"\", G45, N(G50) - N(G55))",
                },
                "H": {
                    "EAC": "=N(H23) - N(H24) + N(H25)",
                    "POC": "=IFERROR(IF(N(H30)=0, 0, N(H40) / N(H30)), 0)",
                    "Revenue": "=N(H12) * N(H16) - N(H21)",
                    "ROE": "=N(H19) - N(H40)",
                    "Confirmed_COGS": "=IF(H45<>\"\", H45, N(H50) - N(H55))",
                },
            },
            range_plan,
        )
