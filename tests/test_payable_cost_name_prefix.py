import os
import sys
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import finance_engine as engine
import finance_utils as utils


def _make_df(rows: int, cols: int) -> pd.DataFrame:
    return pd.DataFrame([[""] * cols for _ in range(rows)])


def test_extract_leading_int_reads_first_three_digits_from_cost_name():
    assert utils._extract_leading_int("116 Permit", 3) == 116
    assert utils._extract_leading_int("83102 Mowing", 3) == 831
    assert utils._extract_leading_int("Permit 116", 3) == 116


def test_process_payable_uses_cost_name_prefix_for_payable_d_and_scoping_match():
    payable = _make_df(1, 44)
    scoping = _make_df(1, 10)

    payable.columns = [f"col_{idx}" for idx in range(1, 45)]
    payable.columns.values[41] = "Cost Name"

    payable.iat[0, 14] = "Wan Pacific Real Estate Development LLC"
    payable.iat[0, 21] = "03/14/2025"
    payable.iat[0, 39] = "No code here"
    payable.iat[0, 41] = "116 Permit"

    scoping.iat[0, 2] = "116"
    scoping.iat[0, 4] = "1000"
    scoping.iat[0, 5] = "200"
    scoping.iat[0, 7] = "300"

    sheet_map = {
        "Payable": payable,
        "Scoping": scoping,
    }

    with patch(
        "finance_classification.compute_payable_classifications",
        return_value=(["ROE"], {"rule_ids": ["R107"]}),
    ):
        out, extra = engine._process_payable_py(sheet_map)

    payable_out = out["Payable"]

    assert payable_out.iat[0, 2] == "WPRED"
    assert payable_out.iat[0, 3] == 116
    assert payable_out.iat[0, 4] == 1000
    assert payable_out.iat[0, 5] == 200
    assert payable_out.iat[0, 6] == 300
    assert payable_out.iat[0, 9] == "2025"
    assert extra["rule_ids"] == ["R107"]
