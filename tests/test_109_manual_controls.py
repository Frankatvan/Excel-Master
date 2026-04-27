import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import finance_engine as fe


def build_live_like_109_grid():
    rows = [[""] * 18 for _ in range(70)]

    year_headers = ["2021", "2022", "2023", "2024", "2025", "2026"]
    for idx, year in enumerate(year_headers, start=5):
        rows[9][idx] = year
        rows[9][idx + 7] = year

    labels = {
        18: "General Conditions fee-Audited",
        25: "Owner-unapproved Overrun",
        27: "Cumulative Direct Cost",
        29: "Cost of Goods Sold-Audited",
        37: "Accrued Warranty Expenses",
        40: "WB Home Income",
        41: "WB Home COGS",
        43: "WB Home Inventory Income",
        44: "WB Home Inventory",
    }
    for row_idx, label in labels.items():
        rows[row_idx - 1][2] = label
    return rows


class Manual109ControlsTests(unittest.TestCase):
    def test_109_protection_description_constant_is_stable(self):
        self.assertEqual("AiWB managed main sheet protection", fe.MANAGED_109_PROTECTION_DESCRIPTION)

    def test_external_protection_prefix_constant_is_stable(self):
        self.assertEqual("AiWB managed external protection", fe.MANAGED_EXTERNAL_PROTECTION_PREFIX)

    def test_build_109_manual_input_ranges_matches_whitelist(self):
        ranges = fe._build_109_manual_input_ranges(
            build_live_like_109_grid(),
            [2021, 2022, 2023, 2024, 2025, 2026],
            sheet_109_title="110",
        )

        self.assertEqual(
            [
                "'110'!C2:E2",
                "'110'!G2:I2",
                "'110'!F18:K18",
                "'110'!M18:R18",
                "'110'!F25:K25",
                "'110'!F29:K29",
                "'110'!M29:R29",
                "'110'!F37:K37",
                "'110'!F40:K40",
                "'110'!F41:K41",
                "'110'!F43:K43",
                "'110'!F44:K44",
            ],
            ranges,
        )
        self.assertNotIn("'110'!F27:K27", ranges)

    def test_build_109_manual_input_ranges_accepts_dynamic_sheet_title(self):
        ranges = fe._build_109_manual_input_ranges(
            build_live_like_109_grid(),
            [2021, 2022, 2023, 2024, 2025, 2026],
            sheet_109_title="237",
        )

        self.assertEqual("'237'!C2:E2", ranges[0])
        self.assertEqual("'237'!G2:I2", ranges[1])
        self.assertIn("'237'!F18:K18", ranges)
        self.assertIn("'237'!M18:R18", ranges)

    def test_build_109_units_count_formula_uses_unit_master(self):
        self.assertEqual(
            '=IFERROR(COUNTA(FILTER(\'Unit Master\'!$A$3:$A,REGEXMATCH(\'Unit Master\'!$A$3:$A,"[0-9]"))),0)',
            fe._build_109_units_count_formula(),
        )

    def test_add_protected_range_request_uses_whitelist_as_unprotected_ranges(self):
        request = fe._build_add_protected_range_request(
            sheet_id=123,
            unprotected_ranges=[
                fe._a1_to_grid_range("'109'!C2", 123),
                fe._a1_to_grid_range("'109'!F18:K18", 123),
            ],
            editor_email="robot@example.com",
        )

        payload = request["addProtectedRange"]["protectedRange"]
        self.assertEqual(123, payload["range"]["sheetId"])
        self.assertEqual(fe.MANAGED_109_PROTECTION_DESCRIPTION, payload["description"])
        self.assertFalse(payload["warningOnly"])
        self.assertEqual(["robot@example.com"], payload["editors"]["users"])
        self.assertEqual(2, len(payload["unprotectedRanges"]))


if __name__ == "__main__":
    unittest.main()
