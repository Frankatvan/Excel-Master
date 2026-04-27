import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import finance_engine as fe


class _FakeExecutable:
    def __init__(self, payload):
        self.payload = payload

    def execute(self):
        return self.payload


class _FakeValuesApi:
    def __init__(self, row_values, expected_range="'109'!A64:Q64"):
        self.row_values = row_values
        self.expected_range = expected_range
        self.cleared = []

    def get(self, spreadsheetId, range, valueRenderOption=None):
        assert range == self.expected_range
        return _FakeExecutable({"values": [self.row_values] if self.row_values is not None else []})

    def batchClear(self, spreadsheetId, body):
        self.cleared.extend(body.get("ranges", []))
        return _FakeExecutable({})


class _FakeSpreadsheetsApi:
    def __init__(self, values_api):
        self.values_api = values_api

    def values(self):
        return self.values_api


class _FakeService:
    def __init__(self, row_values, expected_range="'109'!A64:Q64"):
        self.values_api = _FakeValuesApi(row_values, expected_range=expected_range)

    def spreadsheets(self):
        return _FakeSpreadsheetsApi(self.values_api)


class Legacy109CleanupTests(unittest.TestCase):
    def test_clears_only_matching_legacy_duplicate_contract_change_row(self):
        row = [""] * 17
        row[0] = "合同变动金额"
        row[2] = "Contract Change Amount"
        row[5] = '=IF(F$10<Year($K$2),"",IF(F$10=Year($K$2),F14+F15,IFERROR(61+F15,"")))'
        row[12] = '=IF(AND($C$4<M$9,$C$4>L$9),$E$3,"")'
        service = _FakeService(row)

        result = fe._cleanup_109_legacy_duplicate_contract_change_row(service, "spreadsheet-id")

        self.assertEqual({"cleared": True, "range": "'109'!A64:Q64"}, result)
        self.assertEqual(["'109'!A64:Q64"], service.values_api.cleared)

    def test_skips_when_row64_is_not_legacy_signature(self):
        row = [""] * 17
        row[0] = "合同变动金额"
        row[2] = "Contract Change Amount"
        row[5] = '=IF(F$10<Year($K$2),"",IF(F$10=Year($K$2),F14+F15,IFERROR(F16+F15,"")))'
        row[12] = '=IF(AND($C$4<M$9,$C$4>L$9),$E$3,"")'
        service = _FakeService(row)

        result = fe._cleanup_109_legacy_duplicate_contract_change_row(service, "spreadsheet-id")

        self.assertEqual({"cleared": False, "range": "'109'!A64:Q64"}, result)
        self.assertEqual([], service.values_api.cleared)

    def test_cleanup_uses_dynamic_sheet_title_when_provided(self):
        row = [""] * 17
        row[0] = "合同变动金额"
        row[2] = "Contract Change Amount"
        row[5] = '=IF(F$10<Year($K$2),"",IF(F$10=Year($K$2),F14+F15,IFERROR(61+F15,"")))'
        row[12] = '=IF(AND($C$4<M$9,$C$4>L$9),$E$3,"")'
        service = _FakeService(row, expected_range="'237'!A64:Q64")

        result = fe._cleanup_109_legacy_duplicate_contract_change_row(
            service,
            "spreadsheet-id",
            sheet_109_title="237",
        )

        self.assertEqual({"cleared": True, "range": "'237'!A64:Q64"}, result)
        self.assertEqual(["'237'!A64:Q64"], service.values_api.cleared)
