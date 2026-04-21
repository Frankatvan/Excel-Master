import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import check_finance as cf
from finance_formatting import SemanticFormattingEngine
from finance_mapping import ExcelSemanticMapper


def build_formatting_mapper():
    values = [["", "", ""] for _ in range(20)]
    values[11][2] = "Percentage of Completion"
    values[12][2] = "Completion Rate for the Period"
    mapper = ExcelSemanticMapper()
    mapper.scan_sheet(values)
    return mapper


class SemanticFormattingEngineTests(unittest.TestCase):
    def test_build_bold_row_request_uses_semantic_row_lookup(self):
        mapper = build_formatting_mapper()
        engine = SemanticFormattingEngine(mapper, sheet_id=7)

        request = engine.build_bold_row_request("Percentage of Completion")

        self.assertEqual(7, request["repeatCell"]["range"]["sheetId"])
        self.assertEqual(11, request["repeatCell"]["range"]["startRowIndex"])
        self.assertEqual(12, request["repeatCell"]["range"]["endRowIndex"])
        self.assertTrue(request["repeatCell"]["cell"]["userEnteredFormat"]["textFormat"]["bold"])

    def test_apply_109_formatting_adds_semantic_percent_number_formats(self):
        class FakeExecutable:
            def __init__(self, payload):
                self.payload = payload

            def execute(self):
                return self.payload

        class FakeValues:
            def get(self, spreadsheetId, range):
                if range == "109!A:C":
                    return FakeExecutable({"values": build_formatting_mapper().raw_data_to_values if False else [["", "", ""]]})
                raise AssertionError(f"unexpected range: {range}")

        class FakeSpreadsheets:
            def __init__(self):
                self.batch_body = None
                self.values_api = FakeValues()

            def values(self):
                return self.values_api

            def batchUpdate(self, spreadsheetId, body):
                self.batch_body = body
                return FakeExecutable({})

        class FakeService:
            def __init__(self):
                self.spreadsheets_api = FakeSpreadsheets()

            def spreadsheets(self):
                return self.spreadsheets_api

        service = FakeService()
        ac_values = [["", "", ""] for _ in range(20)]
        ac_values[11][2] = "Percentage of Completion"
        ac_values[12][2] = "Completion Rate for the Period"

        with mock.patch.object(
            cf,
            "_get_sheet_properties",
            return_value={"sheetId": 7, "gridProperties": {"rowCount": 30, "columnCount": 20}},
        ), mock.patch.object(
            cf,
            "_load_109_semantic_values",
            return_value=ac_values,
        ):
            result = cf._apply_109_formatting(
                service,
                "spreadsheet-id",
                manual_ranges=["'109'!F20:K20"],
                highlight_ranges=["'109'!F24"],
                error_ranges=["'109'!E5"],
            )

        self.assertEqual(1, result)
        requests = service.spreadsheets_api.batch_body["requests"]
        percent_requests = [
            item
            for item in requests
            if item.get("repeatCell", {})
            .get("cell", {})
            .get("userEnteredFormat", {})
            .get("numberFormat", {})
            .get("pattern")
            == "0.00%"
        ]
        self.assertEqual(2, len(percent_requests))
        self.assertEqual(11, percent_requests[0]["repeatCell"]["range"]["startRowIndex"])
        self.assertEqual(12, percent_requests[1]["repeatCell"]["range"]["startRowIndex"])
