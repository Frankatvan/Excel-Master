import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator, FormulaTemplateResolver, MappingIncompleteError
import finance_engine as fe

FORMULA_MAPPINGS = {"Payable": {"amount": 21, "cost_code": 1, "year": 10}}


def build_live_like_109_grid():
    rows = [[""] * 18 for _ in range(75)]
    for idx, year in enumerate(["2021", "2022", "2023", "2024", "2025", "2026"], start=5):
        rows[9][idx] = year
        rows[9][idx + 7] = year

    labels = {
        12: "Percentage of Completion",
        17: "General Conditions fee-Company",
        18: "General Conditions fee-Audited",
        19: "General Conditions fee",
        23: "Day 1 Budget",
        24: "Budget Surplus",
        25: "Owner-unapproved Overrun",
        26: "Dynamic Budget (EAC)",
        27: "Cumulative Direct Cost",
        28: "Cost of Goods Sold-Company",
        29: "Cost of Goods Sold-Audited",
        30: "Cost of Goods Sold",
        31: "Total ROE Cost",
        32: "ROE Cost - WB Home",
        33: "ROE Cost - WPRED",
        34: "Total Income Cost",
        35: "GC Income",
        36: "GC Cost",
        37: "Accrued Expenses",
        39: "Accrued Warranty Expenses",
        40: "Actual Warranty Expenses (Reversed)",
        41: "WB Home Income",
        42: "WB Home COGS",
        51: "Gross Profit-Company",
        52: "Gross Profit-Audit",
        53: "Gross Profit",
    }
    for row_idx, label in labels.items():
        rows[row_idx - 1][2] = label
    return rows


class FinanceFormulaGeneratorTests(unittest.TestCase):
    def test_formula_template_resolves_semantic_columns_from_headers(self):
        rows = {
            "Unit Budget": [
                ["Unit Code", "Year", "Contract Price"],
                ["U-001", "1", "100"],
            ],
            "Payable": [
                ["Cost State", "Incurred Date", "Amount"],
                ["ROE", "2026-01-31", "10"],
            ],
        }

        resolver = fe.FormulaSemanticResolver(rows)

        self.assertEqual("'Unit Budget'!$A$2:$A", resolver.column_range("Unit Budget", "Unit Code"))
        self.assertEqual("'Unit Budget'!$C$2:$C", resolver.column_range("Unit Budget", "Contract Price"))
        self.assertEqual("'Payable'!$B$2:$B", resolver.column_range("Payable", "Incurred Date"))

    def test_generator_matches_current_109_formula_families(self):
        mapper = ExcelSemanticMapper()
        mapper.scan_sheet(build_live_like_109_grid())
        generator = FinanceFormulaGenerator(
            mapper,
            config={"formula_mappings": FORMULA_MAPPINGS},
        )

        self.assertEqual("=N(F23) - N(F24) + N(F25)", generator.get_eac_formula("F"))
        self.assertEqual("=N(G23) - N(G24) + N(G25)+F26", generator.get_eac_formula("G"))
        self.assertEqual("=F31+F37", generator.get_cumulative_direct_cost_formula("F"))
        self.assertEqual('=IFERROR(F31-F32-F33-F35+F36+F39+F42,"")', generator.get_cogs_company_formula("F"))
        self.assertEqual("=IFERROR(IF(N(G26)=0, 0, N(G27) / N(G26)), 0)", generator.get_poc_formula("G"))
        self.assertEqual(
            '=IF(H$10<Year($K$2),"",IF(OR(H18<>"",H18<>0),IFERROR(H18,""),IFERROR(SUM($F17:H17)-SUM($F19:G19),"")))',
            generator.get_revenue_formula("H"),
        )
        self.assertEqual(
            '=IF(N$10<Year($K$2),"",IF(OR(N29<>"",N29<>0),IFERROR(N29,""),IFERROR(SUM($M28:N28)-SUM($M30:M30),"")))',
            generator.get_confirmed_cogs_formula("N"),
        )
        self.assertEqual('=IFERROR(F17+F28,"")', generator.get_gross_profit_company_formula("F"))
        self.assertEqual(
            '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "RACC2", Payable!$J:$J, F$10)',
            generator.get_actual_warranty_formula("F", "F$10"),
        )
        self.assertEqual(
            '=IF(M$10<Year($K$2),"",IF(OR(M18<>"",M18<>0),IFERROR(M52,""),IFERROR(M51,"")))',
            generator.get_gross_profit_formula("M"),
        )

    def test_formula_template_resolver_builds_sumifs_ranges_from_mapping(self):
        resolver = FormulaTemplateResolver()
        mappings = {"Payable": {"amount": 21, "cost_code": 1}}

        formula = resolver.resolve_formula(
            '=SUMIFS(Payable!${Payable.amount}, Payable!${Payable.cost_code}, "GC")',
            mappings,
        )

        self.assertEqual('=SUMIFS(Payable!$U:$U, Payable!$A:$A, "GC")', formula)

    def test_formula_template_resolver_raises_when_mapping_missing(self):
        resolver = FormulaTemplateResolver()
        with self.assertRaises(MappingIncompleteError):
            resolver.resolve_formula(
                '=SUMIFS(Payable!${Payable.amount}, Payable!${Payable.cost_code}, "GC")',
                {"Payable": {"amount": 21}},
            )

    def test_formula_template_resolver_supports_self_placeholders(self):
        resolver = FormulaTemplateResolver()
        formula = resolver.resolve_formula(
            '=IF(${SELF_COL}${SELF_ROW}=0,0,${SELF_COL}${SELF_ROW})',
            {},
            context={"self_col": "F", "self_row": 12},
        )
        self.assertEqual("=IF($F12=0,0,$F12)", formula)

    def test_payable_formula_quotes_sheet_name_with_spaces(self):
        mapper = ExcelSemanticMapper()
        mapper.scan_sheet(build_live_like_109_grid())
        generator = FinanceFormulaGenerator(
            mapper,
            config={
                "formula_mappings": FORMULA_MAPPINGS,
                "formula_sheet_titles": {"Payable": "Payable Ledger"},
            },
        )
        self.assertEqual(
            '=SUMIFS(\'Payable Ledger\'!$U:$U, \'Payable Ledger\'!$A:$A, "RACC2", \'Payable Ledger\'!$J:$J, F$10)',
            generator.get_actual_warranty_formula("F", "F$10"),
        )


if __name__ == "__main__":
    unittest.main()
