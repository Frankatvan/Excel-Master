import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from finance_mapping import ExcelSemanticMapper


class ExcelSemanticMapperTests(unittest.TestCase):
    def test_semantic_discovery_accuracy(self):
        mock_values = [[""] * 5 for _ in range(30)]

        mock_values[4][0] = "WB 房屋收入 "
        mock_values[4][2] = "WB Home Income"

        mock_values[22][0] = "初始预算"
        mock_values[22][2] = "Initial Budget (Original Contract Sum)"

        mapper = ExcelSemanticMapper()
        mapper.scan_sheet(mock_values)

        self.assertEqual(23, mapper.get_row("Initial Budget"))
        self.assertEqual(5, mapper.get_row("WB Home Income"))
        self.assertEqual(23, mapper.get_row("初始预算"))
        self.assertEqual("G23", mapper.get_ref("Initial Budget", "G"))

        shifted_values = [[""] * 5 for _ in range(2)] + mock_values
        mapper.scan_sheet(shifted_values)
        self.assertEqual(25, mapper.get_row("Initial Budget"))
