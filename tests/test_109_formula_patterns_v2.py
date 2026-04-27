import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import finance_engine as fe
from finance_mapping import ExcelSemanticMapper
from finance_formulas import FinanceFormulaGenerator

FORMULA_MAPPINGS = {"Payable": {"amount": 21, "cost_code": 1, "year": 10}}


def build_live_like_109_grid():
    rows = [[""] * 18 for _ in range(75)]

    year_headers = ["2021", "2022", "2023", "2024", "2025", "2026"]
    for idx, year in enumerate(year_headers, start=5):
        rows[9][idx] = year
        rows[9][idx + 7] = year

    labels = {
        3: "Contract price (Day1):",
        12: "Percentage of Completion",
        13: "Completion Rate for the Period",
        14: "Contract Amount",
        15: "Budget Surplus",
        16: "Contract Change Amount",
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
        38: "Reversed Accrued Expenses",
        39: "Accrued Warranty Expenses",
        40: "Actual Warranty Expenses (Reversed)",
        54: "Accounts Receivable-Incurred",
        55: "Accounts Receivable-Audited",
        56: "Accounts Receivable-Company",
        57: "Accounts Receivable",
        41: "WB Home Income",
        42: "WB Home COGS",
        43: "Material Margin",
        44: "WB Home Inventory Income",
        45: "WB Home Inventory",
        46: "Material Margin",
        47: "WB Home Inventory Income-Reverse",
        48: "WB Home Inventory-Reverse",
        49: "WB. Home Material Margin Total",
        51: "Gross Profit-Company",
        52: "Gross Profit-Audit",
        53: "Gross Profit",
        61: "ROE (Current Period)",
        62: "Corporate Tax Rate",
        63: "Retention Percentage",
    }
    for row_idx, label in labels.items():
        if row_idx == 3:
            rows[row_idx - 1][3] = label
            rows[row_idx - 1][4] = "1"
        else:
            rows[row_idx - 1][2] = label

    return rows


class FormulaPatternV2Tests(unittest.TestCase):
    def test_semantic_updates_expand_to_shifted_multi_year_columns(self):
        rows = build_live_like_109_grid()
        for row in rows:
            while len(row) < 30:
                row.append("")

        # 将年度轴整体右移：Company J:O，Audit Q:V
        rows[9] = [""] * 30
        for offset, year in enumerate(["2024", "2025", "2026", "2027", "2028", "2029"]):
            rows[9][9 + offset] = year
            rows[9][16 + offset] = year

        updates = fe.update_109_semantic_logic(
            rows,
            sheet_109_title="110",
            formula_mappings=FORMULA_MAPPINGS,
        )
        by_cell = {item["cell"]: item["formula"] for item in updates}

        self.assertEqual(
            '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "Income", Payable!$J:$J, J$10)',
            by_cell["J34"],
        )
        self.assertEqual(
            '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "Income", Payable!$J:$J, O$10)',
            by_cell["O34"],
        )
        self.assertEqual(
            '=IF(Q$10<Year($O$2),"",IF(OR(Q18<>"",Q18<>0),IFERROR(Q18,""),IFERROR(Q17,"")))',
            by_cell["Q19"],
        )
        self.assertEqual(
            '=IF(V$10<Year($O$2),"",IF(OR(V18<>"",V18<>0),IFERROR(V52,""),IFERROR(SUM($Q51:V51)-SUM($Q53:U53),"")))',
            by_cell["V53"],
        )
        self.assertNotIn("F34", by_cell)

    def test_formula_plan_uses_dynamic_start_year_anchor_for_shifted_year_block(self):
        rows = build_live_like_109_grid()
        for row in rows:
            while len(row) < 30:
                row.append("")

        rows[9] = [""] * 30
        for offset, year in enumerate(["2024", "2025", "2026", "2027", "2028", "2029"]):
            rows[9][9 + offset] = year
            rows[9][16 + offset] = year

        plan, _meta = fe._build_109_formula_plan_from_grid(
            rows,
            config=None,
            sheet_109_title="110",
            formula_mappings=FORMULA_MAPPINGS,
        )
        by_cell = {item["cell"]: item["formula"] for item in plan}

        self.assertIn("O2", by_cell)
        self.assertIn("O3", by_cell)
        self.assertEqual(fe._build_109_date_array_formula("MIN"), by_cell["O2"])
        self.assertEqual(fe._build_109_date_array_formula("MAX"), by_cell["O3"])
        self.assertEqual('=IF(J$10=Year($O$2),-$E$3,0)', by_cell["J14"])

    def test_generator_matches_primary_formula_families(self):
        mapper = ExcelSemanticMapper()
        mapper.scan_sheet(build_live_like_109_grid())
        generator = FinanceFormulaGenerator(
            mapper,
            config={"formula_mappings": FORMULA_MAPPINGS},
        )

        self.assertEqual("=N(F23) - N(F24) + N(F25)", generator.get_eac_formula("F"))
        self.assertEqual("=N(G23) - N(G24) + N(G25)+F26", generator.get_eac_formula("G"))
        self.assertEqual("=F31+F37", generator.get_cumulative_direct_cost_formula("F"))
        self.assertEqual("=G31+G37+F27", generator.get_cumulative_direct_cost_formula("G"))
        self.assertEqual('=IFERROR(F31-F32-F33-F35+F36+F39+F42,"")', generator.get_cogs_company_formula("F"))
        self.assertEqual("=IFERROR(IF(N(F26)=0, 0, N(F27) / N(F26)), 0)", generator.get_poc_formula("F"))
        self.assertEqual(
            '=IF(F$10<Year($K$2),"",IF(OR(F18<>"",F18<>0),IFERROR(F18,""),IFERROR(F17,"")))',
            generator.get_revenue_formula("F"),
        )
        self.assertEqual(
            '=IF(G$10<Year($K$2),"",IF(OR(G18<>"",G18<>0),IFERROR(G18,""),IFERROR(SUM($F17:G17)-SUM($F19:F19),"")))',
            generator.get_revenue_formula("G"),
        )
        self.assertEqual(
            '=IF(F$10<Year($K$2),"",IF(OR(F29<>"",F29<>0),IFERROR(F29,""),IFERROR(F28,"")))',
            generator.get_confirmed_cogs_formula("F"),
        )
        self.assertEqual('=IFERROR(F17+F28,"")', generator.get_gross_profit_company_formula("F"))
        self.assertEqual('=IFERROR(F18+F29,"")', generator.get_gross_profit_audited_formula("F"))
        self.assertEqual(
            '=IF(F$10<Year($K$2),"",IF(OR(F18<>"",F18<>0),IFERROR(F52,""),IFERROR(F51,"")))',
            generator.get_gross_profit_formula("F"),
        )
        self.assertEqual(
            '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "GC Income", Payable!$J:$J, F$10)',
            generator.get_gc_income_formula("F", "F$10"),
        )
        self.assertEqual(
            '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "RACC2", Payable!$J:$J, F$10)',
            generator.get_actual_warranty_formula("F", "F$10"),
        )

    def test_generator_matches_audit_rollforward_families(self):
        mapper = ExcelSemanticMapper()
        mapper.scan_sheet(build_live_like_109_grid())
        generator = FinanceFormulaGenerator(
            mapper,
            config={"formula_mappings": FORMULA_MAPPINGS},
        )

        self.assertEqual(
            '=IF(M$10<Year($K$2),"",IF(OR(M18<>"",M18<>0),IFERROR(M18,""),IFERROR(M17,"")))',
            generator.get_revenue_formula("M"),
        )
        self.assertEqual(
            '=IF(N$10<Year($K$2),"",IF(OR(N18<>"",N18<>0),IFERROR(N18,""),IFERROR(SUM($M17:N17)-SUM($M19:M19),"")))',
            generator.get_revenue_formula("N"),
        )
        self.assertEqual(
            '=IF(M$10<Year($K$2),"",IF(OR(M29<>"",M29<>0),IFERROR(M29,""),IFERROR(M28,"")))',
            generator.get_confirmed_cogs_formula("M"),
        )
        self.assertEqual(
            '=IF(M$10<Year($K$2),"",IF(OR(M18<>"",M18<>0),IFERROR(M52,""),IFERROR(M51,"")))',
            generator.get_gross_profit_formula("M"),
        )

    def test_semantic_updates_cover_primary_and_audit_blocks_but_skip_l_gap(self):
        updates = fe.update_109_semantic_logic(
            build_live_like_109_grid(),
            sheet_109_title="110",
            formula_mappings=FORMULA_MAPPINGS,
        )
        by_cell = {item["cell"]: item["formula"] for item in updates}

        self.assertEqual("=N(F23) - N(F24) + N(F25)", by_cell["F26"])
        self.assertEqual("=G31+G37+F27", by_cell["G27"])
        self.assertEqual('=IFERROR(F31-F32-F33-F35+F36+F39+F42,"")', by_cell["F28"])
        self.assertEqual(
            '=IF(F$10<Year($K$2),"",IF(OR(F29<>"",F29<>0),IFERROR(F29,""),IFERROR(F28,"")))',
            by_cell["F30"],
        )
        self.assertEqual(
            '=SUMIFS(Payable!$U:$U, Payable!$A:$A, "RACC2", Payable!$J:$J, F$10)',
            by_cell["F40"],
        )
        self.assertEqual('=SUMIFS(Payable!$U:$U, Payable!$A:$A, "Income", Payable!$J:$J, F$10)', by_cell["F34"])
        self.assertEqual('=SUMIFS(Payable!$U:$U, Payable!$A:$A, "GC Income", Payable!$J:$J, F$10)', by_cell["F35"])
        self.assertEqual(
            '=IF(M$10<Year($K$2),"",IF(OR(M18<>"",M18<>0),IFERROR(M18,""),IFERROR(M17,"")))',
            by_cell["M19"],
        )
        self.assertEqual(
            '=IF(M$10<Year($K$2),"",IF(OR(M18<>"",M18<>0),IFERROR(M52,""),IFERROR(M51,"")))',
            by_cell["M53"],
        )
        self.assertNotIn("L12", by_cell)
        self.assertNotIn("L19", by_cell)
        self.assertNotIn("L30", by_cell)
        self.assertNotIn("L53", by_cell)

    def test_build_109_date_array_formula_uses_confirmed_external_date_columns(self):
        self.assertEqual(
            '=MAX(DATE(2021,1,1),MIN(TOCOL({IFERROR(FILTER(Payable!$T:$T,Payable!$T:$T<>""),"");IFERROR(FILTER(Payable!$V:$V,Payable!$V:$V<>""),"");IFERROR(FILTER(Payable!$AC:$AC,Payable!$AC:$AC<>""),"");IFERROR(FILTER(\'Final Detail\'!$O:$O,\'Final Detail\'!$O:$O<>""),"");IFERROR(FILTER(\'Final Detail\'!$S:$S,\'Final Detail\'!$S:$S<>""),"");IFERROR(FILTER(\'Draw request report\'!$R:$R,\'Draw request report\'!$R:$R<>""),"");IFERROR(FILTER(\'Draw request report\'!$Z:$Z,\'Draw request report\'!$Z:$Z<>""),"")},1)))',
            fe._build_109_date_array_formula("MIN"),
        )
