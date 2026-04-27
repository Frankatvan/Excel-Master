import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import finance_engine as fe


def build_scoping_grid():
    rows = [[""] * 14 for _ in range(8)]
    rows[0] = ["", "", "", "", "1", "2", "3", "4", "5", "6", "", "", "100", "200"]
    rows[1] = ["", "Welltower", "Group Number", "Group Name", "GMP", "Fee", "WIP", "WTC", "GC", "TBD", "保修月数", "", "Budget", "Incurred amount"]
    rows[2] = ["", "", "", "Section Header", "", "", "", "", "", "", "", "", "", ""]
    rows[3] = ["", "", "101", "101 Test", "1", "", "", "", "", "", "24", "", "", ""]
    rows[4] = ["", "", "", "Subtotal With Amount", "", "", "", "", "", "", "", "", "123.45", ""]
    rows[5] = ["", "", "", "Subtotal With Incurred", "", "", "", "", "", "", "", "", "", "-22.1"]
    rows[6] = ["", "", "", "Subtotal Empty", "", "", "", "", "", "", "", "", "", ""]
    rows[7] = ["", "", "102", "102 Test", "", "2", "", "", "", "", "12", "", "", ""]
    return rows


class ScopingControlsTests(unittest.TestCase):
    def test_ensure_scoping_final_gmp_column_inserts_after_gmp_and_copies_values(self):
        rows = [
            ["", "", "Group Number", "Group Name", "GMP", "Fee", "WIP", "WTC", "GC", "TBD", "保修月数"],
            ["", "", "101", "Group 101", "1", "", "", "", "", "", "12"],
            ["", "", "102", "Group 102", "", "2", "", "", "", "", ""],
        ]

        migrated, meta = fe._ensure_scoping_final_gmp_rows(rows)

        self.assertEqual({"inserted": True, "final_gmp_col_1based": 6}, meta)
        self.assertEqual(["GMP", "Final GMP", "Fee"], migrated[0][4:7])
        self.assertEqual(["1", "1", ""], migrated[1][4:7])
        self.assertEqual(["", "", "2"], migrated[2][4:7])

    def test_ensure_scoping_final_gmp_column_does_not_overwrite_existing_values(self):
        rows = [
            ["", "", "Group Number", "Group Name", "GMP", "Final GMP", "Fee"],
            ["", "", "101", "Group 101", "1", "", "2"],
            ["", "", "102", "Group 102", "", "1", ""],
        ]

        migrated, meta = fe._ensure_scoping_final_gmp_rows(rows)

        self.assertEqual({"inserted": False, "final_gmp_col_1based": 6}, meta)
        self.assertEqual(rows, migrated)

    def test_apply_scoping_layout_controls_inserts_final_gmp_without_value_overwrite(self):
        class Execute:
            def __init__(self, value):
                self.value = value

            def execute(self):
                return self.value

        class Values:
            def __init__(self, rows):
                self.rows = rows
                self.updates = []

            def get(self, **_kwargs):
                return Execute({"values": self.rows})

            def update(self, **kwargs):
                self.updates.append(kwargs)
                return Execute({})

        class Spreadsheets:
            def __init__(self, rows):
                self.values_api = Values(rows)
                self.batch_updates = []

            def values(self):
                return self.values_api

            def get(self, **_kwargs):
                return Execute(
                    {
                        "sheets": [
                            {
                                "properties": {
                                    "title": "Scoping",
                                    "sheetId": 241616920,
                                    "gridProperties": {"rowCount": 1000, "columnCount": 26},
                                }
                            }
                        ]
                    }
                )

            def batchUpdate(self, **kwargs):
                self.batch_updates.append(kwargs)
                return Execute({})

        class Service:
            def __init__(self, rows):
                self.spreadsheets_api = Spreadsheets(rows)

            def spreadsheets(self):
                return self.spreadsheets_api

        rows = [
            ["", "", "Group Number", "Group Name", "GMP", "Fee"],
            ["", "", "101", "Group 101", "1", ""],
        ]
        service = Service(rows)

        result = fe._apply_scoping_layout_controls(service, "sheet-123")

        self.assertEqual({"inserted": True, "final_gmp_col_1based": 6}, result["final_gmp"])
        self.assertEqual([], service.spreadsheets_api.values_api.updates)
        requests = service.spreadsheets_api.batch_updates[0]["body"]["requests"]
        self.assertEqual("insertDimension", next(iter(requests[0])))
        self.assertEqual("copyPaste", next(iter(requests[1])))
        self.assertEqual("copyPaste", next(iter(requests[2])))
        self.assertEqual("updateCells", next(iter(requests[3])))

    def test_build_scoping_manual_input_ranges(self):
        ranges = fe._build_scoping_manual_input_ranges(build_scoping_grid())
        self.assertEqual(
            [
                "'Scoping'!B4",
                "'Scoping'!E4:K4",
                "'Scoping'!B8",
                "'Scoping'!E8:K8",
            ],
            ranges,
        )

    def test_build_scoping_manual_input_ranges_includes_final_gmp_when_present(self):
        migrated, _meta = fe._ensure_scoping_final_gmp_rows(build_scoping_grid())

        ranges = fe._build_scoping_manual_input_ranges(migrated)

        self.assertEqual(
            [
                "'Scoping'!B4",
                "'Scoping'!E4:L4",
                "'Scoping'!B8",
                "'Scoping'!E8:L8",
            ],
            ranges,
        )

    def test_build_scoping_hidden_row_numbers_hides_blank_group_rows_without_amounts(self):
        hidden_rows = fe._build_scoping_hidden_row_numbers(build_scoping_grid())
        self.assertEqual([3, 7], hidden_rows)
        self.assertNotIn(5, hidden_rows)
        self.assertNotIn(6, hidden_rows)

    def test_build_scoping_warranty_expiry_values_uses_latest_group_co_date(self):
        scoping_rows = [[""] * 15 for _ in range(6)]
        scoping_rows[1][2] = "Group Number"
        scoping_rows[1][10] = "Warranty Months"
        scoping_rows[2][2] = "101"
        scoping_rows[2][10] = "12"
        scoping_rows[3][2] = "102"
        scoping_rows[3][10] = "6"
        scoping_rows[4][2] = ""

        unit_master_rows = [
            ["Unit Code", "Total Budget", "GC Budget", "WIP Budget", "Incurred Amount", "Settlement Amount", "Final Date", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "Budget Variance", "Group"],
            ["A-101", "", "", "", "", "", "", "2025-01-01", "", "", "", "", "101"],
            ["B-101", "", "", "", "", "", "", "2025-03-01", "", "", "", "", "101"],
            ["A-102", "", "", "", "", "", "", "2025-02-15", "", "", "", "", "102"],
        ]

        values = fe._build_scoping_warranty_expiry_values(scoping_rows, unit_master_rows)

        self.assertEqual("保修到期日", values[1][0])
        self.assertEqual("2/27/2026", values[2][0])
        self.assertEqual("8/15/2025", values[3][0])
        self.assertEqual("", values[4][0])

    def test_build_scoping_warranty_expiry_values_falls_back_to_unit_budget_group_data(self):
        scoping_rows = [[""] * 15 for _ in range(5)]
        scoping_rows[1][2] = "Group Number"
        scoping_rows[1][10] = "Warranty Months"
        scoping_rows[2][2] = "4"
        scoping_rows[2][10] = "24"

        unit_master_rows = [
            ["Unit Code", "Total Budget", "GC Budget", "WIP Budget", "Incurred Amount", "Settlement Amount", "Final Date", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "Budget Variance", "Group"],
            ["14403DD", "", "", "", "", "", "", "2025-07-31", "", "", "", "", ""],
        ]
        unit_budget_rows = [
            ["", "", "", "", "", "", "", "", "", "", "", "", "", "Group"],
            ["", "Unit Code", "", "", "", "", "结算年份", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "预算差异", "", "Group"],
            ["", "14403DD", "", "", "", "", "", "2025-07-31", "", "", "", "", "", "4"],
        ]

        values = fe._build_scoping_warranty_expiry_values(scoping_rows, unit_master_rows, unit_budget_rows)

        self.assertEqual("7/27/2027", values[2][0])


if __name__ == "__main__":
    unittest.main()
