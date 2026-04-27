import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOGIC_DIR = ROOT / "api" / "logic"
if str(LOGIC_DIR) not in sys.path:
    sys.path.append(str(LOGIC_DIR))

from finance_utils import _values_to_dataframe


def _load_reclassify_job_module():
    module_path = ROOT / "api" / "internal" / "reclassify_job.py"
    spec = importlib.util.spec_from_file_location("reclassify_job", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


reclassify_job = _load_reclassify_job_module()


def _make_row(length: int):
    return [""] * length


def test_build_draw_request_cost_state_updates_uses_strict_invoice_and_cost_code_match():
    payable = _values_to_dataframe(
        [
            ["Vendor", "Invoice No", "Cost Code", "Cost State", "Amount"],
            ["WB Home LLC", "INV-001", "1SF116", "ROE", "150.25"],
        ]
    )
    preamble = _make_row(20)
    preamble[7] = "Project Name："
    preamble[10] = "Download Date：2026-04-12 18:28"
    header = _make_row(20)
    header[7] = "Sql"
    header[8] = "Draw Date"
    header[9] = "Draw Invoice"
    header[10] = "Unit Code"
    header[11] = "Complete Stage"
    header[12] = "Incurred Date"
    header[13] = "Invoiced Date"
    header[14] = "Invoiced No"
    header[15] = "Activity"
    header[16] = "Cost Code"
    header[17] = "Type"
    header[18] = "Vendor"
    header[19] = "Amount"
    data = _make_row(20)
    data[7] = "2"
    data[8] = "2024-05-31"
    data[9] = "WPRED-SandyCove-00"
    data[10] = "WBWT Sandy Cove Common"
    data[12] = "2024-05-01"
    data[13] = "2024-05-01"
    data[14] = "INV-001"
    data[15] = "Permit"
    data[16] = "1SF116"
    data[17] = "AUTOR"
    data[18] = "WB Home LLC"
    data[19] = "150.25"
    draw_request = _values_to_dataframe([preamble, header, data])

    updates, summary = reclassify_job.build_draw_request_cost_state_updates(
        {
            "Payable": payable,
            "Draw request report": draw_request,
        }
    )

    assert updates == [
        {
            "range": "'Draw request report'!C3:C3",
            "values": [["ROE"]],
        }
    ]
    assert summary["draw_request_rows_written"] == 1
    assert summary["draw_request_matched_rows"] == 1
    assert summary["draw_request_unmatched_rows"] == 0
    assert summary["draw_request_ambiguous_rows"] == 0


def test_build_draw_request_cost_state_updates_does_not_fallback_to_draw_invoice_or_invoice_only():
    payable = _values_to_dataframe(
        [
            ["Vendor", "Invoice No", "Cost Code", "Cost State", "Amount"],
            ["Wan Pacific Real Estate Development LLC", "WPRED-SandyCove-11", "3GN896", "Income", "45473.05"],
        ]
    )
    preamble = _make_row(20)
    preamble[7] = "Project Name："
    preamble[10] = "Download Date：2026-04-12 18:28"
    header = _make_row(20)
    header[7] = "Sql"
    header[8] = "Draw Date"
    header[9] = "Draw Invoice"
    header[10] = "Unit Code"
    header[11] = "Complete Stage"
    header[12] = "Incurred Date"
    header[13] = "Invoiced Date"
    header[14] = "Invoiced No"
    header[15] = "Activity"
    header[16] = "Cost Code"
    header[17] = "Type"
    header[18] = "Vendor"
    header[19] = "Amount"
    data = _make_row(20)
    data[7] = "910"
    data[8] = "2025-04-30"
    data[9] = "WPRED-SandyCove-11"
    data[10] = "WBWT Sandy Cove Common"
    data[12] = "2025-04-01"
    data[13] = "2025-04-01"
    data[15] = "AUTOR"
    data[16] = "2HD540"
    data[17] = "AUTOR"
    data[18] = "The Home Depot"
    data[19] = "84.61"
    draw_request = _values_to_dataframe([preamble, header, data])

    updates, summary = reclassify_job.build_draw_request_cost_state_updates(
        {
            "Payable": payable,
            "Draw request report": draw_request,
        }
    )

    assert updates == [
        {
            "range": "'Draw request report'!C3:C3",
            "values": [[""]],
        }
    ]
    assert summary["draw_request_rows_written"] == 1
    assert summary["draw_request_matched_rows"] == 0
    assert summary["draw_request_unmatched_rows"] == 1
    assert summary["draw_request_ambiguous_rows"] == 0


def test_build_reclassify_updates_includes_draw_request_c_updates():
    class Decision:
        def __init__(self, category, rule_id):
            self.category = category
            self.rule_id = rule_id

    updates, summary = reclassify_job.build_reclassify_updates(
        {
            "payable_decisions": [Decision("Direct", "R101")],
            "final_detail_decisions": [Decision("Consulting", "R202")],
            "draw_request_updates": [
                {"range": "'Draw request report'!C3:C3", "values": [["ROE"]]},
                {"range": "'Draw request report'!C4:C4", "values": [[""]]},
            ],
            "draw_request_summary": {
                "draw_request_rows_written": 2,
                "draw_request_matched_rows": 1,
                "draw_request_unmatched_rows": 1,
                "draw_request_ambiguous_rows": 0,
            },
        }
    )

    assert updates[-2:] == [
        {"range": "'Draw request report'!C3:C3", "values": [["ROE"]]},
        {"range": "'Draw request report'!C4:C4", "values": [[""]]},
    ]
    assert summary == {
        "payable_rows_written": 1,
        "final_detail_rows_written": 1,
        "draw_request_rows_written": 2,
        "draw_request_matched_rows": 1,
        "draw_request_unmatched_rows": 1,
        "draw_request_ambiguous_rows": 0,
        "mapping_warning_count": 0,
        "fallback_count": 0,
        "fallback_fields": [],
    }


def test_coerce_sheet_values_to_dataframe_preserves_wider_rows_after_a_short_preamble():
    values = [
        ["", "", "", "", "", "", "", "Project Name：", "", "", "Download Date：2026-04-12 18:28"],
        ["", "", "", "", "", "", "", "Sql", "Draw Date", "Draw Invoice", "Unit Code", "Complete Stage", "Incurred Date", "Invoiced Date", "Invoiced No", "Activity", "Cost Code", "Type", "Vendor", "Amount"],
        ["", "", "", "", "", "", "", "910", "2025-04-30", "WPRED-SandyCove-11", "WBWT Sandy Cove Common", "", "2025-04-01", "2025-04-01", "", "AUTOR", "2HD540", "AUTOR", "The Home Depot", "84.61"],
    ]

    df = reclassify_job.coerce_sheet_values_to_dataframe(values)

    assert len(df.columns) == 20
    assert df.iloc[0, 14] == "Invoiced No"
    assert df.iloc[0, 16] == "Cost Code"
    assert df.iloc[1, 18] == "The Home Depot"
