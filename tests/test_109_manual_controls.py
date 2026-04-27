import json
import os
import sys
import unittest
from unittest.mock import patch

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

    def test_build_external_import_zone_metadata_requests_replaces_seven_zone_markers(self):
        sheet_ids = {
            "Payable": 101,
            "Final Detail": 102,
            "Unit Budget": 103,
            "Draw request report": 104,
            "Draw Invoice List": 105,
            "Transfer Log": 106,
            "Change Order Log": 107,
        }

        def fake_get_sheet_metadata(_service, _spreadsheet_id, sheet_name):
            return {
                "sheet_id": sheet_ids[sheet_name],
                "row_count": 20000,
                "column_count": 50,
                "protected_ranges": [],
            }

        with patch.object(fe, "_get_sheet_metadata", side_effect=fake_get_sheet_metadata):
            requests = fe._build_external_import_zone_metadata_requests(object(), "spreadsheet-123")

        self.assertEqual(14, len(requests))
        self.assertTrue(all("deleteDeveloperMetadata" in request for request in requests[:7]))
        self.assertTrue(all("createDeveloperMetadata" in request for request in requests[7:]))
        delete_lookups = [
            request["deleteDeveloperMetadata"]["dataFilter"]["developerMetadataLookup"]
            for request in requests[:7]
        ]
        self.assertTrue(all("locationType" not in lookup for lookup in delete_lookups))
        self.assertTrue(all(lookup["locationMatchingStrategy"] == "EXACT_LOCATION" for lookup in delete_lookups))

        created_by_source_role = {}
        for request in requests[7:]:
            metadata = request["createDeveloperMetadata"]["developerMetadata"]
            payload = json.loads(metadata["metadataValue"])
            created_by_source_role[payload["source_role"]] = (metadata, payload)

        self.assertEqual(
            {
                "payable",
                "final_detail",
                "unit_budget",
                "draw_request",
                "draw_invoice_list",
                "transfer_log",
                "change_order_log",
            },
            set(created_by_source_role),
        )
        self.assertEqual(
            {
                "external_import.payable_raw",
                "external_import.final_detail_raw",
                "external_import.unit_budget_raw",
                "external_import.draw_request_raw",
                "external_import.draw_invoice_list_raw",
                "external_import.transfer_log_raw",
                "external_import.change_order_log_raw",
            },
            {payload["zone_key"] for _metadata, payload in created_by_source_role.values()},
        )

        payable_metadata, payable_payload = created_by_source_role["payable"]
        self.assertEqual("aiwb.import_zone", payable_metadata["metadataKey"])
        self.assertEqual("DOCUMENT", payable_metadata["visibility"])
        self.assertEqual({"sheetId": 101}, payable_metadata["location"])
        self.assertEqual("external_import.payable_raw", payable_payload["zone_key"])
        self.assertEqual("Payable", payable_payload["sheet_role"])
        self.assertEqual("AiWB", payable_payload["managed_by"])
        self.assertEqual(1, payable_payload["schema_version"])
        self.assertEqual("expand_within_managed_sheet", payable_payload["capacity_policy"])
        self.assertEqual("required_semantic_headers", payable_payload["header_signature_policy"])
        self.assertEqual(1, payable_payload["start_row_index"])
        self.assertEqual(0, payable_payload["start_column_index"])
        self.assertEqual(20000, payable_payload["end_row_index"])
        self.assertEqual(702, payable_payload["end_column_index"])
        self.assertEqual("external_import.payable_raw:101:1:0:20000:702", payable_payload["grid_fingerprint"])


if __name__ == "__main__":
    unittest.main()
