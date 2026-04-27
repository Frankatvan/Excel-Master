import os
import sys
import unittest
from pathlib import Path
from tempfile import NamedTemporaryFile
import re
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import pandas as pd
from openpyxl import Workbook

import check_finance as cf
import finance_classification as fc
import finance_engine as fe
import finance_utils as fu
from finance_services import ClassificationService


AUDIT_MANUAL_PATH = Path("docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md")
AUDIT_MANUAL_RULE_PATTERN = re.compile(r"^## (R\d{3})\n(.*?)(?=^## R\d{3}\n|\Z)", re.MULTILINE | re.DOTALL)
MANUAL_METADATA_RULE_IDS = ()
CORE_RULE_IDS = (
    "R000",
    "R101",
    "R102",
    "R103",
    "R104",
    "R105",
    "R106",
    "R107",
    "R108",
    "R201",
    "R202",
    "R203",
    "R204",
    "R205",
    "R301",
    "R302",
)


class AuditManualConsistencyTests(unittest.TestCase):
    def _parse_rule_manual_sections(self) -> dict[str, dict[str, str | tuple[str, ...]]]:
        text = AUDIT_MANUAL_PATH.read_text(encoding="utf-8")
        sections: dict[str, dict[str, str | tuple[str, ...]]] = {}
        for rule_id, body in AUDIT_MANUAL_RULE_PATTERN.findall(text):
            fields: dict[str, str | tuple[str, ...]] = {}
            for line in body.splitlines():
                line = line.strip()
                if line.startswith("- Category: "):
                    fields["category"] = line.removeprefix("- Category: ").strip().strip("`")
                elif line.startswith("- Sheet Scope: "):
                    scope_text = line.removeprefix("- Sheet Scope: ").strip().strip("`")
                    fields["sheet_scope"] = tuple(part.strip().strip("`") for part in scope_text.split("/"))
                elif line.startswith("- 中文判定依据："):
                    fields["reason_zh"] = line.removeprefix("- 中文判定依据：").strip()
                elif line.startswith("- English Reason: "):
                    fields["reason_en"] = line.removeprefix("- English Reason: ").strip()
            sections[rule_id] = fields
        return sections

    def _normalize_manual_compare_text(self, value: str | None) -> str:
        if value is None:
            return ""
        return value.strip().rstrip(".。")

    def test_rule_registry_matches_audit_manual_for_core_rules(self):
        manual_sections = self._parse_rule_manual_sections()

        for rule_id in CORE_RULE_IDS:
            self.assertIn(rule_id, fc.RULE_REGISTRY)
            self.assertIn(rule_id, manual_sections)
            manual_entry = manual_sections[rule_id]
            registry_entry = fc.RULE_REGISTRY[rule_id]

            self.assertEqual(registry_entry["category"], manual_entry.get("category"), rule_id)
            self.assertEqual(
                self._normalize_manual_compare_text(str(registry_entry["reason_zh"])),
                self._normalize_manual_compare_text(manual_entry.get("reason_zh")),
                rule_id,
            )
            self.assertEqual(
                self._normalize_manual_compare_text(str(registry_entry["reason_en"])),
                self._normalize_manual_compare_text(manual_entry.get("reason_en")),
                rule_id,
            )

    def test_audit_manual_contains_exact_core_rules_and_matching_sheet_scope(self):
        manual_sections = self._parse_rule_manual_sections()

        self.assertEqual(set(CORE_RULE_IDS), set(manual_sections))
        for rule_id in CORE_RULE_IDS:
            self.assertEqual(tuple(fc.RULE_REGISTRY[rule_id]["sheet_scope"]), manual_sections[rule_id].get("sheet_scope"), rule_id)


class PayableFinalDetailClassificationTests(unittest.TestCase):

    def _get_classification_service(self, sheet_map=None):
        if sheet_map is None:
            sheet_map = self._build_restore_ready_sheet_map()
        
        dependencies = {
            "_build_unit_budget_schedule_map": fe._build_unit_budget_schedule_map,
            "_contains_general_condition": fu._contains_general_condition,
            "_ensure_column_count": fu._ensure_column_count,
            "_extract_tail_int": fu._extract_tail_int,
            "_find_col_in_headers": fu._find_col_in_headers,
            "_find_col_in_row": fu._find_col_in_row,
            "_get_cell": fu._get_cell,
            "_has_digits": fu._has_digits,
            "_load_default_unit_budget_schedule_overrides": fe._load_default_unit_budget_schedule_overrides,
            "_normalize_amount_key": fu._normalize_amount_key,
            "_normalize_date_value": fu._normalize_date_value,
            "_normalize_text_key": fu._normalize_text_key,
            "_safe_string": fu._safe_string,
            "_sheet_key": fu._sheet_key,
            "_to_float": fu._to_float,
        }
        return ClassificationService(sheet_map, dependencies)

    def test_build_final_detail_summary_rows_aggregates_per_unit(self):
        rows = fe._build_final_detail_summary_rows(
            units=["U1", "U2", ""],
            row_unit_codes=["U1", "U1", "U2"],
            row_d_values=[10, "", 20],
            row_c_values=[1, "", 1],
            row_p_values=[100, 200, 300],
            row_t_texts=["", "2025", ""],
            row_v_texts=["Normal", "Sharing", "Normal"],
        )

        self.assertEqual(
            [
                ["U1", 10.0, 100.0, 100.0],
                ["U2", 20.0, 300.0, 300.0],
                ["", "", "", ""],
            ],
            rows,
        )

    def test_detect_rule_id_hit_rate_alerts_flags_deviation_above_twenty_percent(self):
        alerts = fe._detect_rule_id_hit_rate_alerts(
            current_rule_ids=["R107"] * 71 + ["R108"] * 29,
            historical_avg_rates={"R107": 0.50, "R108": 0.30},
            deviation_threshold=0.20,
        )

        self.assertEqual(1, len(alerts))
        self.assertEqual("R107", alerts[0]["rule_id"])

    def test_classification_and_alerting_integration_detects_deviation(self):
        sheet_map = self._build_restore_ready_sheet_map()
        service = self._get_classification_service(sheet_map)
        results = service.compute()

        working_map = sheet_map.copy()
        working_map["Payable"].iloc[:, 1] = results["payable_extra"]["rule_ids"]
        working_map["Final Detail"].iloc[:, 1] = results["final_detail_extra"]["rule_ids"]
        
        self.assertEqual("R301", working_map["Payable"].iloc[0, 1])
        self.assertEqual("R302", working_map["Final Detail"].iloc[0, 1])

    def test_restore_marks_payable_r301_even_without_final_detail_match(self):
        sheet_map = self._build_restore_ready_sheet_map()
        sheet_map["Final Detail"] = sheet_map["Final Detail"].iloc[0:0].copy()

        service = self._get_classification_service(sheet_map)
        results = service.compute()

        self.assertEqual("R301", results["payable_extra"]["rule_ids"][0])
        self.assertEqual(1, results["restore_extra"]["payable_restore_hit_count"])
        self.assertEqual(1, results["restore_extra"]["payable_missing_final_detail_count"])

    def test_restore_marks_final_detail_r302_even_without_payable_match(self):
        sheet_map = self._build_restore_ready_sheet_map()
        sheet_map["Payable"] = sheet_map["Payable"].iloc[0:0].copy()

        service = self._get_classification_service(sheet_map)
        results = service.compute()

        self.assertEqual("R302", results["final_detail_extra"]["rule_ids"][0])
        self.assertEqual(1, results["restore_extra"]["final_detail_restore_hit_count"])
        self.assertEqual(1, results["restore_extra"]["final_detail_missing_payable_count"])

    def _build_restore_ready_sheet_map(self) -> dict[str, pd.DataFrame]:
        payable = pd.DataFrame(
            [
                ["", "", "GT Plumbing LLC", 4646.0, "2025-06-24", "24407DD", "2HD300"]
            ],
            columns=["Category", "Rule ID", "Vendor", "Amount", "Incurred Date", "Unit Code", "Cost Code"]
        )

        final_detail = pd.DataFrame(
            [
                ["", "", "2025-07-15", "2025-06-24", "24407DD", "30002", "2HD300", 4646.0, "GT Plumbing LLC", "Normal"]
            ],
            columns=["Category", "Rule ID", "Final Date", "Incurred Date", "Unit Code", "Activity No.", "Cost Code", "Amount", "Vendor", "Type"]
        )

        scoping = pd.DataFrame(
            [
                ["", "", "Group Number", "", "GMP", "Fee", "WIP", "WTC", "GC", "TBD", "Warranty Months"],
                ["", "", 1, "", 1, 5, "", "", "", "", ""],
                ["", "", 4, "", 1, "", "", "", "", "", 12],
                ["", "", 300, "", 1, "", "", "", "", "", ""],
                ["", "", 305, "", 1, "", "", "", "", "", 12],
                ["", "", 670, "", 6, "", "", "", "", "", ""],
                ["", "", 895, "", 1, 6, "", "", "", "", ""],
            ]
        )

        unit_budget = pd.DataFrame(
            [
                ["", "Unit Code", "", "", "", "", "结算年份", "C/O date", "实际结算日期", "实际结算年份", "预算差异", "TBD Acceptance Date", "Group", "GMP", "Fee", "WIP"],
                ["", "24407DD", "", "", "", "", 2025, "2025-04-15", "2025-05-31", 2025, "", "", "", "", "", ""],
            ]
        )
        
        unit_master = pd.DataFrame(
            [
                ["Unit Code", "Total Budget", "GC Budget", "WIP Budget", "Incurred Amount", "Settlement Amount", "Final Date", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "Budget Variance", "Group"],
                ["24407DD", 0, 0, 0, 0, 0, "2025-04-15", "2025-04-15", "2025-05-31", 2025, "", 0, 300],
                ["24408DD", 0, 0, 0, 0, 0, "2025-04-15", "2025-04-15", "2025-05-31", 2025, "", 0, 305],
                ["24409DD", 0, 0, 0, 0, 0, "2025-06-15", "2025-06-15", "2025-07-31", 2025, "", 0, 305],
                ["14403DD", 0, 0, 0, 0, 0, "2025-04-15", "2025-04-15", "2025-05-31", 2025, "", 0, 4],
            ]
        )

        return {
            "Payable": payable,
            "Final Detail": final_detail,
            "Scoping": scoping,
            "Unit Budget": unit_budget,
            "Unit Master": unit_master,
        }

    def test_classify_payable_pre_settlement_logic(self):
        service = self._get_classification_service()
        racc_keys = set()

        # R106: Income (GMP + Fee + Wan Pacific)
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="Wan Pacific Real Estate Development LLC",
            amount=100,
            cost_code="1SF895",
            incurred_date="2025-01-15",
            statuses={1, 2},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date=None,
            payable_racc_keys=racc_keys,
        )
        self.assertEqual("Income", decision.category)
        self.assertEqual("R106", decision.rule_id)

        # R105: GC (GMP + GC)
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF895",
            incurred_date="2025-01-15",
            statuses={1, 5},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date=None,
            payable_racc_keys=racc_keys,
        )
        self.assertEqual("GC", decision.category)
        self.assertEqual("R105", decision.rule_id)

        # R107: ROE (GMP fallback)
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF895",
            incurred_date="2025-01-15",
            statuses={1},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date=None,
            payable_racc_keys=racc_keys,
        )
        self.assertEqual("ROE", decision.category)
        self.assertEqual("R107", decision.rule_id)

        # R102: Consulting (WTC + WB Texas)
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="WB Texas Consulting LLC",
            amount=100,
            cost_code="1SF112",
            incurred_date="2025-01-15",
            statuses={4},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date=None,
            payable_racc_keys=racc_keys,
        )
        self.assertEqual("Consulting", decision.category)
        self.assertEqual("R102", decision.rule_id)

    def test_classify_payable_post_settlement_logic(self):
        service = self._get_classification_service()
        
        # R203: TBD (Date > TBD and Status 6)
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF670",
            incurred_date="2025-04-15",
            statuses={1, 6},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date="2025-03-01",
            payable_racc_keys=set(),
        )
        self.assertEqual("TBD", decision.category)
        self.assertEqual("R203", decision.rule_id)

        # R204: RACC2 (Post-settlement and ROE feature, prioritized over EXP)
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF004",
            incurred_date="2025-04-15",
            statuses={1},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date="2025-03-01",
            payable_racc_keys=set(),
        )
        self.assertEqual("RACC2", decision.category)
        self.assertEqual("R204", decision.rule_id)

        # R202 remains ahead of R204 when a valid paired RACC key exists.
        racc_key = service._make_payable_racc_key("Other Vendor", 100, "1SF004", "2025-04-15")
        decision = service._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF004",
            incurred_date="2025-04-15",
            statuses={1},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date="2025-03-01",
            payable_racc_keys={racc_key},
        )
        self.assertEqual("RACC", decision.category)
        self.assertEqual("R202", decision.rule_id)

    def test_group_warranty_expiry_uses_latest_co_date_plus_scoping_months(self):
        service = self._get_classification_service()

        self.assertEqual(pd.Timestamp("2026-06-13"), service.group_warranty_expiry_map[305])
        self.assertEqual(pd.Timestamp("2026-04-13"), service.group_warranty_expiry_map[4])

    def test_group_warranty_expiry_reads_unit_budget_when_summary_row_precedes_headers(self):
        sheet_map = self._build_restore_ready_sheet_map()
        sheet_map["Unit Master"] = pd.DataFrame(
            [
                ["Unit Code", "Total Budget", "GC Budget", "WIP Budget", "Incurred Amount", "Settlement Amount", "Final Date", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "Budget Variance"],
                ["24407DD", 0, 0, 0, 0, 0, "2025-04-15", "2025-04-15", "2025-05-31", 2025, "", 0],
            ]
        )
        sheet_map["Unit Budget"] = pd.DataFrame(
            [
                ["", 84, "预算金额", "WIP逻辑预算", "incurred Amount", "结算金额", "结算年份", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "预算差异", "", "Group", "GMP", "Fee", "WIP"],
                ["", "Unit Code", "", "", "", "", "结算年份", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "预算差异", "", "Group", "GMP", "Fee", "WIP"],
                ["", "24408DD", "", "", "", "", 2025, "2025-04-15", "2025-05-31", 2025, "", "", "", 305, "", "", ""],
                ["", "24409DD", "", "", "", "", 2025, "2025-06-15", "2025-07-31", 2025, "", "", "", 305, "", "", ""],
            ]
        )

        service = self._get_classification_service(sheet_map)

        self.assertEqual(pd.Timestamp("2026-06-13"), service.group_warranty_expiry_map[305])

    def test_classify_final_detail_pre_exclusion(self):
        service = self._get_classification_service()
        decision = service._classify_final_detail_record(
            unit_code="14407DD", vendor="V", amount=100, cost_code="C", activity_no="A",
            incurred_date="2025-01-01", final_date="", statuses={1}, 
            actual_settlement_date="2025-02-01", tbd_acceptance_date=None, paired_racc_keys=set(),
            record_type="Sharing"
        )
        self.assertEqual("Excluded", decision.category)
        self.assertEqual("R000", decision.rule_id)

    def test_classify_final_detail_post_settlement(self):
        service = self._get_classification_service()
        
        # R201: ACC (Only Final Date)
        decision = service._classify_final_detail_record(
            unit_code="14407DD", vendor="V", amount=100, cost_code="C", activity_no="A",
            incurred_date="", final_date="2025-07-15", statuses={1}, 
            actual_settlement_date="2025-06-01", tbd_acceptance_date=None, paired_racc_keys=set()
        )
        self.assertEqual("ACC", decision.category)
        self.assertEqual("R201", decision.rule_id)


if __name__ == "__main__":
    unittest.main()
