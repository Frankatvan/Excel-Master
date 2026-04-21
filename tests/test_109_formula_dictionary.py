import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import check_finance as cf
import pandas as pd


def build_minimal_109_grid():
    rows = [[""] * 12 for _ in range(80)]
    # Row 10 (index 9) must contain years for _find_year_header_row_109
    for i, year in enumerate([2021, 2022, 2023, 2024, 2025, 2026]):
        rows[9][5 + i] = str(year)

    # Required labels in column 3 (index 2) for _find_rows_by_item_label
    # Using consistent indices where possible, expanding to cover all required_rows
    rows[1][2] = "Contract price"
    rows[2][2] = "Contract Amount"
    rows[3][2] = "Budget Surplus" # Maps to Contract Change Order
    rows[4][2] = "Dynamic Budget (EAC)"
    rows[5][2] = "Cost of Goods Sold-Audited" # Row 6
    rows[6][2] = "Cost of Goods Sold"
    rows[7][2] = "Percentage of Completion"
    rows[10][2] = "Contract Change Order"
    rows[11][2] = "Completion Rate for the Period" # Row 12
    rows[12][2] = "General Conditions fee-Company"

    rows[13][2] = "Initial Budget"
    rows[14][2] = "Cumulative Savings (Target vs Actual)"
    rows[30][2] = "Owner-unapproved Overrun" # Row 31
    rows[31][2] = "Budget Cost(分母EAC)"
    rows[32][2] = "Cumulative Direct Cost"
    rows[33][2] = "Cost of Goods Sold-Company"
    rows[34][2] = "Gross Profit-Company"
    rows[35][2] = "Accounts Receivable-Incurred"
    rows[36][2] = "Accounts Receivable-Audited"
    rows[37][2] = "Accounts Receivable-Company"
    rows[38][2] = "Accounts Receivable"

    rows[19][2] = "WB Home Income" # Row 20
    rows[20][2] = "WB Home COGS" # Row 21
    rows[21][2] = "WB Home Inventory Income" # Row 22
    rows[22][2] = "WB Home Inventory" # Row 23
    rows[23][2] = "WB Home Inventory Income-Reverse"
    rows[24][2] = "WB Home Inventory-Reverse"
    rows[25][2] = "WB. Home Material Margin Total"

    rows[40][2] = "Total ROE Cost"
    rows[41][2] = "ROE Cost - WB Home"
    rows[42][2] = "ROE Cost - WPRED"
    rows[65][2] = "Accrued Expenses" # Row 66
    rows[66][2] = "Reversed Accrued Expenses" # Row 67
    rows[67][2] = "Total Income Cost" # Row 68
    
    rows[70][2] = "Material Margin" # For Material Margin(main)
    rows[71][2] = "Material Margin" # For Material Margin(inventory)

    # New semantic row requirements
    rows[0][3] = "Contract price (Day1):"

    return rows


def build_day1_contract_price_grid():
    rows = [[""] * 18 for _ in range(75)] # Increased to 75 rows to accommodate new labels
    rows[2][3] = "Contract price (Day1):"
    rows[2][4] = 14795410.77

    for offset, year in enumerate([2021, 2022, 2023, 2024, 2025, 2026], start=5):
        rows[8][offset] = "31-Dec"
        rows[9][offset] = str(year)
        rows[10][offset] = "AiWB"

    labels = {
        11: "Percentage of Completion",
        12: "Completion Rate for the Period",
        13: "Contract Amount",
        14: "Budget Surplus",
        15: "Contract price",
        16: "General Conditions fee-Company",
        17: "General Conditions fee-Audited",
        18: "General Conditions fee",
        22: "Initial Budget (Original Contract Sum)", # Corrected from "Day 1 Budget"
        23: "Cumulative Savings (Target vs Actual)",
        24: "Owner-unapproved Overrun",
        25: "Dynamic Budget (EAC)",
        26: "Cost of Goods Sold-Audited",
        27: "Cost of Goods Sold",
        28: "Percentage of Completion (POC)",
        29: "Current Dynamic EAC (Total Cost)",
        30: "Total Estimated Revenue",
        31: "Revenue Recognized (Current Period)",
        32: "Cumulative Revenue Recognized (Prior Period)",
        33: "Initial Budget (Original Contract Sum)", # Duplicated, but needed for specific logic if row 22 is changed
        34: "WB Home Income",
        35: "WB Home COGS",
        36: "Material Margin",
        37: "WB Home Inventory Income",
        38: "WB Home Inventory",
        39: "Confirmed COGS (Current Period)", # Corrected from "Material Margin"
        40: "WB Home Inventory Income-Reverse",
        41: "WB Home Inventory-Reverse",
        42: "WB. Home Material Margin Total",
        44: "Gross Profit-Company",
        46: "Gross Profit",
        48: "Accounts Receivable-Incurred",
        49: "Cumulative Total Cost (Actual)",
        50: "Audit Adjustment (Current Period)",
        52: "Accounts Receivable-Audited",
        53: "Accounts Receivable-Company",
        54: "Cumulative Confirmed COGS (Prior Period)", # Added
        55: "Total ROE Cost",
        56: "ROE Cost - WB Home",
        57: "ROE Cost - WPRED",
        58: "Accrued Expenses",
        59: "Reversed Accrued Expenses",
        60: "Total Income Cost",
        61: "ROE (Current Period)",
        62: "Corporate Tax Rate",      # Added
        63: "Retention Percentage",  # Added
    }
    for row_idx, label in labels.items():
        rows[row_idx][2] = label
    return rows


def build_renamed_contract_change_grid():
    rows = build_day1_contract_price_grid()
    rows[14][2] = "Budget Surplus"
    return rows


def build_semantic_109_ac_grid():
    rows = [[""] * 12 for _ in range(100)]

    # Existing labels from original build_semantic_109_ac_grid, preserving row numbers
    rows[11][2] = "Percentage of Completion"
    rows[22][2] = "Initial Budget (Original Contract Sum)"
    rows[23][2] = "Cumulative Savings (Target vs Actual)"
    rows[24][2] = "Owner-unapproved Overrun"
    rows[29][2] = "Current Dynamic EAC (Total Cost)"
    rows[39][2] = "Confirmed COGS (Current Period)"
    rows[44][2] = "Audit Adjustment (Current Period)"
    rows[49][2] = "Cumulative Total Cost (Actual)"

    # Labels added to match _build_109_formula_plan_from_grid's 'required_rows' and other semantic updates
    rows[12][2] = "Completion Rate for the Period"
    rows[13][2] = "Contract Amount"
    rows[15][2] = "Contract price"
    rows[1][2] = "Contract price (Day1):" # Assuming row 1, col 2 for label

    rows[31][2] = "Budget Cost(分母EAC)"
    rows[32][2] = "Cumulative Direct Cost"
    rows[33][2] = "Initial Budget" # For required_rows Initial Budget

    rows[60][2] = "Cost of Goods Sold-Company"
    rows[61][2] = "General Conditions fee-Company"
    rows[62][2] = "Gross Profit-Company"
    rows[63][2] = "Accounts Receivable-Incurred"
    rows[64][2] = "Accounts Receivable-Audited"
    rows[65][2] = "Accounts Receivable-Company"
    rows[66][2] = "Accounts Receivable"
    rows[67][2] = "WB Home Income"
    rows[68][2] = "WB Home COGS"
    rows[69][2] = "WB Home Inventory Income"
    rows[70][2] = "WB Home Inventory"
    rows[71][2] = "WB Home Inventory Income-Reverse"
    rows[72][2] = "WB Home Inventory-Reverse"
    rows[73][2] = "WB. Home Material Margin Total"
    rows[74][2] = "Total ROE Cost"
    rows[75][2] = "ROE Cost - WB Home"
    rows[76][2] = "ROE Cost - WPRED"
    rows[77][2] = "Accrued Expenses"
    rows[78][2] = "Reversed Accrued Expenses"
    rows[79][2] = "Total Income Cost"

    # Semantic updates from update_109_semantic_logic that are not already present
    rows[80][2] = "Revenue Recognized (Current Period)"
    rows[81][2] = "ROE (Current Period)"
    rows[82][2] = "Retention"
    rows[83][2] = "Net Profit (Post-Tax)"

    # Added missing labels to match finance_formulas.py requirements
    rows[84][2] = "Total Estimated Revenue"
    rows[85][2] = "Cumulative Revenue Recognized (Prior Period)"
    rows[86][2] = "Corporate Tax Rate"
    rows[87][2] = "Cumulative Confirmed COGS (Prior Period)"
    rows[88][2] = "Retention Percentage"

    # Material Margin labels are specifically handled by _find_material_margin_rows_109
    rows[36][2] = "Material Margin"
    rows[37][2] = "Material Margin"
    
    rows[90][2] = "Contract Change Order" # For required_rows Contract Change Order

    # Add years in columns F to K (index 5 to 10) to simulate _find_year_header_row_109
    for i, year in enumerate([2021, 2022, 2023, 2024, 2025, 2026]):
        rows[9][5 + i] = str(year)
    return rows


def build_shifted_unit_budget_df():
    columns = [f"col_{i}" for i in range(1, 21)] + ["14403DD", "Common"]
    rows = [[""] * len(columns) for _ in range(4)]

    rows[0][7] = "C/O date"
    rows[0][8] = "实际结算日期"
    rows[0][9] = "实际结算年份"
    rows[0][10] = "TBD Acceptance Date"

    rows[1][1] = "14403DD"
    rows[2][14] = 1
    rows[2][16] = "3"
    rows[2][20] = 100
    rows[3][16] = "3"
    rows[3][20] = 40

    return pd.DataFrame(rows, columns=columns)


def build_unit_budget_rows_for_master():
    rows = [[""] * 20 for _ in range(8)]
    rows[1][1:13] = [
        "Unit Code",
        "预算金额",
        "WIP逻辑预算",
        "incurred Amount",
        "结算金额",
        "结算年份",
        "C/O date",
        "实际结算日期",
        "实际结算年份",
        "TBD Acceptance Date",
        "预算差异",
        "Group",
    ]
    rows[2][1:13] = ["14403DD", 1, 2, 3, 4, 2026, "2025-07-31", "2025-08-31", 2025, "2025-09-17", 5, 895]
    rows[3][1:13] = ["Common", 6, 7, 8, 9, "", "", "2025-10-31", 2025, "2025-10-29", 10, ""]
    rows[4][1] = ""
    rows[5][1:13] = ["Unit Code", 999, 999, 999, 999, 2020, "2020-01-01", "2020-01-31", 2020, "2020-02-01", 999, 999]
    rows[6][1:13] = ["WBWT Sandy Cove Common", 100, 100, 100, 100, "", "", "2025-11-30", 2025, "2025-10-29", 100, ""]
    return rows


class FormulaDictionaryTests(unittest.TestCase):
    def test_update_109_semantic_logic_reads_ac_values_and_generates_expected_ranges(self):
        class FakeExecutable:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                return self.payload

        class FakeValues:
            def __init__(self):
                self.requested_ranges = []

            def get(self, spreadsheetId, range):
                self.requested_ranges.append(range)
                if range == "109!A:C":
                    return FakeExecutable({"values": build_semantic_109_ac_grid()})
                raise AssertionError(f"unexpected range: {range}")

        class FakeSpreadsheets:
            def __init__(self):
                self.values_api = FakeValues()

            def values(self):
                return self.values_api

        class FakeService:
            def __init__(self):
                self.spreadsheets_api = FakeSpreadsheets()

            def spreadsheets(self):
                return self.spreadsheets_api

        service = FakeService()

        updates = cf.update_109_semantic_logic(service, "spreadsheet-id")

        self.assertEqual(["109!A:C"], service.spreadsheets_api.values_api.requested_ranges)
        by_range = {item["range"]: item for item in updates}
        self.assertEqual("=N(F23) - N(F24) + N(F25)", by_range["'109'!F30"]["formula"])
        self.assertEqual("=IFERROR(IF(N(F30)=0, 0, N(F40) / N(F30)), 0)", by_range["'109'!F12"]["formula"])
        self.assertEqual('=IF(F45<>"", F45, N(F50) - N(F88))', by_range["'109'!F40"]["formula"])

    def test_generate_109_formula_plan_overlays_semantic_updates_by_range(self):
        class FakeExecutable:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                return self.payload

        class FakeValues:
            def __init__(self):
                self.requested_ranges = []

            def get(self, spreadsheetId, range):
                self.requested_ranges.append(range)
                if range == "109!A:ZZ":
                    return FakeExecutable({"values": [["full-grid"]]})
                if range == "109!A:C":
                    return FakeExecutable({"values": build_semantic_109_ac_grid()})
                raise AssertionError(f"unexpected range: {range}")

        class FakeSpreadsheets:
            def __init__(self):
                self.values_api = FakeValues()

            def values(self):
                return self.values_api

        class FakeService:
            def __init__(self):
                self.spreadsheets_api = FakeSpreadsheets()

            def spreadsheets(self):
                return self.spreadsheets_api

        fake_service = FakeService()
        base_plan = [{"range": "'109'!F12", "formula": "=OLD", "sheet": "109", "cell": "F12", "logic": "old"}]

        with mock.patch.object(cf, "get_sheets_service", return_value=fake_service), mock.patch.object(
            cf, "_ensure_unit_budget_actual_settlement_columns"
        ), mock.patch.object(
            cf, "_refresh_unit_budget_actual_settlement_columns"
        ), mock.patch.object(
            cf, "_sync_unit_master_sheet"
        ), mock.patch.object(
            cf, "_apply_unit_budget_support_formatting"
        ), mock.patch.object(
            cf, "_ensure_109_contract_amount_row"
        ), mock.patch.object(
            cf,
            "_build_109_formula_plan_from_grid",
            return_value=(base_plan, {"dictionary_version": "test-v1"}),
        ):
            plan, meta = cf.generate_109_formula_plan("spreadsheet-id")

        f12_items = [item for item in plan if item["range"] == "'109'!F12"]
        self.assertEqual(1, len(f12_items))
        self.assertEqual("=IFERROR(IF(N(F30)=0, 0, N(F40) / N(F30)), 0)", f12_items[0]["formula"])
        self.assertEqual(51, len(plan))
        self.assertEqual(51, meta["semantic_formula_count"])

    def test_verify_formula_plan_treats_google_function_case_normalization_as_match(self):
        class FakeExecutable:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                return self.payload

        class FakeValues:
            def batchGet(self, spreadsheetId, ranges, valueRenderOption):
                return FakeExecutable(
                    {
                        "valueRanges": [
                            {
                                "range": "'109'!F15",
                                "values": [['=IF(F$10=Year($K$2),$E$3,"")']],
                            }
                        ]
                    }
                )

        class FakeSpreadsheets:
            def values(self):
                return FakeValues()

        class FakeService:
            def spreadsheets(self):
                return FakeSpreadsheets()

        verify = cf._verify_formula_plan(
            FakeService(),
            "spreadsheet-id",
            [{"range": "'109'!F15", "formula": '=IF(F$10=Year($K$2),$E$3,"")'}],
        )

        self.assertEqual(1, verify["matched"])
        self.assertEqual([], verify["mismatches"])

    def test_load_109_formula_dictionary_reads_yaml_metadata(self):
        cfg = cf._load_109_formula_dictionary()

        self.assertEqual("v1", cfg["version"])
        self.assertEqual("109", cfg["sheet"])
        self.assertEqual("yearly", cfg["period_axis"]["mode"])
        self.assertEqual([2021, 2022, 2023, 2024, 2025, 2026], cfg["period_axis"]["years"])

    def test_build_109_formula_plan_from_grid_exposes_dictionary_metadata(self):
        rows = build_semantic_109_ac_grid()
        cfg = {
            "version": "test-v1",
            "sheet": "109",
            "period_axis": {"mode": "yearly", "years": [2021, 2022, 2023, 2024, 2025, 2026]},
            "open_items": ["Budget Cost Change Order source mapping"],
        }

        plan, meta = cf._build_109_formula_plan_from_grid(rows, cfg)

        self.assertTrue(plan)
        self.assertEqual("test-v1", meta["dictionary_version"])
        self.assertEqual(
            ["Budget Cost Change Order source mapping"],
            meta["open_items"],
        )

    def test_execute_109_formula_plan_skips_noop_when_sheet_already_matches(self):
        class FakeExecutable:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                return self.payload

        class FakeValues:
            def __init__(self):
                self.batch_update_called = False

            def batchUpdate(self, spreadsheetId, body):
                self.batch_update_called = True
                return FakeExecutable({})

        class FakeSpreadsheets:
            def __init__(self, values_api):
                self.values_api = values_api

            def values(self):
                return self.values_api

        class FakeService:
            def __init__(self, values_api):
                self.values_api = values_api

            def spreadsheets(self):
                return FakeSpreadsheets(self.values_api)

        fake_values = FakeValues()
        fake_service = FakeService(fake_values)
        plan = [{"range": "'109'!F24", "formula": '=IFERROR(F12,"")'}]

        with mock.patch.object(cf, "get_sheets_service", return_value=fake_service), mock.patch.object(
            cf,
            "_verify_formula_plan",
            return_value={"matched": 1, "total": 1, "mismatches": []},
        ), mock.patch.object(
            cf,
            "_load_109_rows",
            return_value=build_minimal_109_grid(),
        ), mock.patch.object(
            cf,
            "_apply_109_formatting",
            return_value=1,
        ), mock.patch.object(
            cf,
            "_load_109_validation_numbers",
            return_value={},
        ), mock.patch.object(
            cf,
            "_append_109_log_entry",
            return_value=1,
        ):
            result = cf.execute_109_formula_plan("spreadsheet-id", plan)

        self.assertFalse(fake_values.batch_update_called)
        self.assertTrue(result["skipped_noop"])
        self.assertEqual(0, result["updated_ranges"])
        self.assertEqual(0, result["api_calls"])

    def test_build_109_manual_input_ranges_uses_confirmed_scope_only(self):
        rows = build_minimal_109_grid()
        ranges = cf._build_109_manual_input_ranges(rows, [2021, 2022, 2023, 2024, 2025, 2026])

        self.assertEqual(
            ["'109'!F20:K20", "'109'!F21:K21", "'109'!F22:K22", "'109'!F23:K23", "'109'!F31:K31", "'109'!F6:K6"],
            ranges,
        )

    def test_build_109_format_requests_clears_then_paints_manual_and_highlight_ranges(self):
        requests = cf._build_109_format_requests(
            sheet_id=7,
            row_count=30,
            column_count=20,
            manual_ranges=["'109'!F20:K20"],
            highlight_ranges=["'109'!F24", "'109'!G24"],
            error_ranges=["'109'!E5"],
        )

        self.assertEqual(4, len(requests))
        self.assertEqual(7, requests[0]["repeatCell"]["range"]["sheetId"])
        self.assertEqual(30, requests[0]["repeatCell"]["range"]["endRowIndex"])
        self.assertEqual(20, requests[0]["repeatCell"]["range"]["endColumnIndex"])
        self.assertEqual(1, requests[0]["repeatCell"]["cell"]["userEnteredFormat"]["backgroundColor"]["red"])
        self.assertAlmostEqual(
            0.93,
            requests[1]["repeatCell"]["cell"]["userEnteredFormat"]["backgroundColor"]["red"],
            places=2,
        )
        self.assertAlmostEqual(
            1.0,
            requests[2]["repeatCell"]["cell"]["userEnteredFormat"]["backgroundColor"]["red"],
            places=2,
        )
        self.assertGreater(
            requests[3]["repeatCell"]["cell"]["userEnteredFormat"]["backgroundColor"]["red"],
            0.95,
        )

    def test_execute_109_formula_plan_rehighlights_and_logs_on_noop(self):
        plan = [{"range": "'109'!F24", "formula": '=IFERROR(F12,"")'}]

        with mock.patch.object(cf, "get_sheets_service", return_value=object()), mock.patch.object(
            cf,
            "_verify_formula_plan",
            return_value={"matched": 1, "total": 1, "mismatches": []},
        ), mock.patch.object(
            cf,
            "_load_109_rows",
            return_value=build_minimal_109_grid(),
        ), mock.patch.object(
            cf,
            "_apply_109_formatting",
            return_value=1,
        ) as formatting_mock, mock.patch.object(
            cf,
            "_load_109_validation_numbers",
            return_value={},
        ), mock.patch.object(
            cf,
            "_append_109_log_entry",
            return_value=1,
        ) as log_mock:
            result = cf.execute_109_formula_plan("spreadsheet-id", plan)

        formatting_mock.assert_called_once()
        log_mock.assert_called_once()
        self.assertTrue(result["skipped_noop"])
        self.assertEqual(1, result["format_calls"])
        self.assertEqual(1, result["log_rows_appended"])
        self.assertEqual([], result["highlighted_cells"])

    def test_build_109_formula_plan_uses_day1_contract_price_source(self):
        rows = build_day1_contract_price_grid()
        cfg = cf._load_109_formula_dictionary()

        plan, _ = cf._build_109_formula_plan_from_grid(rows, cfg)
        formula_by_cell = {item["cell"]: item["formula"] for item in plan}

        self.assertEqual('=IF(F$10<Year($K$2),"",IF(F$10=Year($K$2),F14+F15,""))', formula_by_cell["F16"])
        self.assertEqual('=IF(F$10=Year($K$2),-$E$3,0)', formula_by_cell["F14"])
        self.assertEqual('=IF(F$10=Year($K$2),$C$3,0)', formula_by_cell["F23"])
        self.assertEqual('=F23-F24+F25', formula_by_cell["F26"])

        self.assertEqual('=IFERROR(round(SUM($F$28:F28)/F26,8),"")', formula_by_cell["F12"])



    def test_build_109_formula_plan_includes_fixed_summary_cells(self):
        rows = build_day1_contract_price_grid()
        cfg = cf._load_109_formula_dictionary()

        plan, _ = cf._build_109_formula_plan_from_grid(rows, cfg)
        formula_by_cell = {item["cell"]: item["formula"] for item in plan}

        self.assertEqual('=IFERROR(COUNTA(FILTER(\'Unit Budget\'!$B$3:$B,REGEXMATCH(\'Unit Budget\'!$B$3:$B,"[0-9]"))),0)', formula_by_cell["C5"])
        self.assertEqual('=IFERROR($E$19,"")', formula_by_cell["G3"])
        self.assertEqual('=IFERROR($E$47,"")', formula_by_cell["G5"])
        self.assertEqual('=IFERROR($E$37,"")', formula_by_cell["I5"])

    def test_build_109_formula_plan_includes_new_top_rules(self):
        rows = build_day1_contract_price_grid()
        cfg = cf._load_109_formula_dictionary()

        plan, _ = cf._build_109_formula_plan_from_grid(rows, cfg)
        formula_by_cell = {item["cell"]: item["formula"] for item in plan}

        self.assertEqual("合同金额", formula_by_cell["A14"])
        self.assertEqual("Contract Amount", formula_by_cell["C14"])
        self.assertEqual("预算结余", formula_by_cell["A15"])
        self.assertEqual("Budget Surplus", formula_by_cell["C15"])
        self.assertEqual('=IFERROR(INDEX(F16:K16,1,MAX(FILTER(COLUMN(F16:K16)-COLUMN(F16)+1,F16:K16<>""))),"")', formula_by_cell["E16"])
        self.assertEqual("=SUMIFS('Unit Master'!$K:$K,'Unit Master'!$I:$I,F$10)", formula_by_cell["F15"])
        self.assertEqual("=SUMIFS('Unit Master'!$K:$K,'Unit Master'!$I:$I,F$10)", formula_by_cell["F24"])
        self.assertEqual('=IF(F$10<Year($K$2),"",IF(F$10=Year($K$2),F14+F15,""))', formula_by_cell["F16"])
        self.assertEqual('=IF(F$10=Year($K$2),-$E$3,0)', formula_by_cell["F14"])
        self.assertEqual('=IF(F$10=Year($K$2),$C$3,0)', formula_by_cell["F23"])
        self.assertEqual('=F23-F24+F25', formula_by_cell["F26"])

        self.assertEqual('=IFERROR(round(SUM($F$28:F28)/F26,8),"")', formula_by_cell["F12"])



        self.assertEqual('=IF(F18<>"",F18,IF(F$10<Year($K$2),"",IFERROR(SUM($F$17:F17),"")))', formula_by_cell["F19"])

    def test_build_109_formula_plan_includes_new_day1_totals_and_date_formulas(self):
        rows = build_day1_contract_price_grid()
        cfg = cf._load_109_formula_dictionary()

        plan, _ = cf._build_109_formula_plan_from_grid(rows, cfg)
        formula_by_cell = {item["cell"]: item["formula"] for item in plan}

        self.assertIn("Payable!$T:$T", formula_by_cell["K2"])
        self.assertIn("'Draw request report'!$W:$W", formula_by_cell["K2"])
        self.assertIn("'Change Order Log'!$B:$B", formula_by_cell["K3"])
        self.assertEqual("=SUMIFS('Unit Budget'!$T:$T,'Unit Budget'!$O:$O,1)", formula_by_cell["E3"])
        self.assertEqual("=IFERROR($E$3-$E$5,\"\")", formula_by_cell["C3"])
        self.assertEqual("=IFERROR($E$3-$E$5,\"\")", formula_by_cell["E4"])
        self.assertEqual("=SUMIFS('Unit Budget'!$T:$T,'Unit Budget'!$P:$P,2)", formula_by_cell["E5"])
        self.assertEqual('=IFERROR(round(MAX(F12:K12),8),"")', formula_by_cell["E12"])
        self.assertEqual('=IFERROR(round(SUM(F13:K13),8),"")', formula_by_cell["E13"])
        self.assertEqual('=IFERROR(round(SUM($F$28:F28)/F26,8),"")', formula_by_cell["F12"])
        self.assertEqual('=IFERROR(round(G12-F12,8),"")', formula_by_cell["G13"])
        self.assertEqual('=IF(J$10<Year($K$2),"",IF(J$10=Year($K$2),J14+J15,IFERROR(I16+J15,"")))', formula_by_cell["J16"])
        self.assertEqual('=IF(I$10<Year($K$2),"",IF(I$10=Year($K$2),IFERROR(I16*I12,""),IFERROR(I16*I12-SUM($F$17:H17),"")))', formula_by_cell["I17"])

    def test_build_109_formula_plan_accepts_budget_surplus_as_contract_change_row_label(self):
        rows = build_renamed_contract_change_grid()
        cfg = cf._load_109_formula_dictionary()

        plan, meta = cf._build_109_formula_plan_from_grid(rows, cfg)
        formula_by_cell = {item["cell"]: item["formula"] for item in plan}

        self.assertEqual("Budget Surplus", formula_by_cell["C15"])
        self.assertEqual(15, meta["key_rows"]["Contract Change Order"])

    def test_calculate_unit_budget_cd_uses_shifted_layout_after_actual_settlement_columns_added(self):
        sheet_map = {"Unit Budget": build_shifted_unit_budget_df()}

        out, meta = cf._calculate_unit_budget_cd_py(sheet_map)
        wsb = out["Unit Budget"]

        self.assertEqual(3, meta["computed_rows"])
        self.assertEqual(100, wsb.iat[1, 2])
        self.assertEqual(140, wsb.iat[1, 3])

    def test_derive_unit_budget_actual_settlement_fields_prefers_earlier_year_and_common_uses_latest_unit_year(self):
        self.assertEqual("2025-01-31", cf._co_date_to_actual_settlement_date("2024-12-01"))
        self.assertEqual(
            ("2025-01-31", 2025),
            cf._derive_unit_budget_actual_settlement_fields("14403DD", 2026, "2024-12-01", None),
        )
        self.assertEqual(
            ("", ""),
            cf._derive_unit_budget_actual_settlement_fields("14403DD", 2026, "", None),
        )
        self.assertEqual(
            ("", 2025),
            cf._derive_unit_budget_actual_settlement_fields("Common Area", "", "", 2025),
        )

    def test_build_unit_budget_actual_settlement_values_uses_common_last_dates(self):
        rows = [
            [""] * 11,
            ["", "84", "预算金额", "WIP逻辑预算", "incurred Amount", "结算金额", "结算年份", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date"],
            ["", "14403DD", "", "", "", "", 2026, "2025-07-31", "", "", "2025-09-17"],
            ["", "14407DD", "", "", "", "", 2025, "2025-09-10", "", "", "2025-10-02"],
            ["", "Common", "", "", "", "", "", "", "", "", ""],
        ]

        values = cf._build_unit_budget_actual_settlement_values(rows, {})

        self.assertEqual(["2025-07-31", "2025-08-31", 2025, "2025-09-17"], values[0])
        self.assertEqual(["2025-09-10", "2025-10-31", 2025, "2025-10-02"], values[1])
        self.assertEqual(["", "2025-10-31", 2025, "2025-10-02"], values[2])

    def test_build_unit_master_rows_from_unit_budget_rows_copies_b_to_m(self):
        ub_rows = build_unit_budget_rows_for_master()
        fd_rows = [] # Provide empty list for other required arguments
        pay_rows = [] # Provide empty list for other required arguments

        unit_master_rows = cf._build_unit_master_rows_v2(ub_rows, fd_rows, pay_rows)

        # Updated assertions to match _build_unit_master_rows_v2 output
        self.assertEqual(
            "Total",
            unit_master_rows[0][0],
        )
        self.assertTrue(unit_master_rows[0][1].startswith("=SUM(")) # Check for sum formula
        self.assertEqual(
            ["Unit Code", "Total Budget", "GC Budget", "WIP Budget", "Incurred Amount",
             "Settlement Amount", "Final Date", "C/O date", "实际结算日期", "实际结算年份",
             "TBD Acceptance Date", "Budget Variance", "Group"],
            unit_master_rows[1],
        )
        self.assertEqual("14403DD", unit_master_rows[2][0])
        self.assertEqual(2025, unit_master_rows[2][9]) # '实际结算年份' should be 2025 from mock data
        self.assertEqual("Common", unit_master_rows[3][0])
        self.assertEqual(6, len(unit_master_rows)) # 1 Total row + 1 Header row + 4 Data rows (from build_unit_budget_rows_for_master)

    def test_build_unit_budget_support_requests_hides_b_to_m_and_formats_manual_columns(self):
        requests = cf._build_unit_budget_support_requests(unit_budget_sheet_id=11, unit_master_sheet_id=12, row_count=50)

        self.assertEqual("COLUMNS", requests[0]["updateDimensionProperties"]["range"]["dimension"])
        self.assertEqual(1, requests[0]["updateDimensionProperties"]["range"]["startIndex"])
        self.assertEqual(13, requests[0]["updateDimensionProperties"]["range"]["endIndex"])
        self.assertTrue(requests[0]["updateDimensionProperties"]["properties"]["hiddenByUser"])
        self.assertEqual(11, requests[1]["repeatCell"]["range"]["sheetId"])
        self.assertEqual(12, requests[2]["repeatCell"]["range"]["sheetId"])
        self.assertEqual(1.0, requests[1]["repeatCell"]["cell"]["userEnteredFormat"]["backgroundColor"]["red"])
        self.assertEqual(11, requests[3]["repeatCell"]["range"]["sheetId"])
        self.assertEqual(12, requests[6]["repeatCell"]["range"]["sheetId"])
        self.assertEqual(7, requests[3]["repeatCell"]["range"]["startColumnIndex"])
        self.assertEqual(10, requests[4]["repeatCell"]["range"]["startColumnIndex"])
        self.assertEqual(6, requests[6]["repeatCell"]["range"]["startColumnIndex"])
        self.assertEqual(9, requests[7]["repeatCell"]["range"]["startColumnIndex"])
        self.assertAlmostEqual(0.93, requests[3]["repeatCell"]["cell"]["userEnteredFormat"]["backgroundColor"]["red"], places=2)
        self.assertEqual("NUMBER", requests[5]["repeatCell"]["cell"]["userEnteredFormat"]["numberFormat"]["type"])
        self.assertEqual("0", requests[5]["repeatCell"]["cell"]["userEnteredFormat"]["numberFormat"]["pattern"])


if __name__ == "__main__":
    unittest.main()
