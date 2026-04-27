from __future__ import annotations

from datetime import date, datetime
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Dict, List, Mapping, Sequence, Tuple

import pandas as pd

@dataclass(frozen=True)
class ClassificationDecision:
    category: str
    rule_id: str
    reason_zh: str
    reason_en: str
    warnings: Tuple[str, ...] = field(default_factory=tuple)
    evidence: Mapping[str, Any] = field(default_factory=dict)

    def __iter__(self):
        yield self.category
        yield list(self.warnings)


RULE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "R000": {
        "category": "Excluded",
        "reason_zh": "Type 为 Sharing 的记录（仅限 Final Detail）排除在成本重分类之外",
        "reason_en": "Rows with Type='Sharing' (Final Detail only) are excluded from cost reclassification",
        "semantics": "sharing_exclusion",
        "sheet_scope": ("Final Detail",),
    },
    # 第二类：结算前逻辑 (Before Settlement / R100s)
    "R101": {
        "category": "GC",
        "reason_zh": "Unit Code 包含 General Condition 关键字",
        "reason_en": "Unit Code contains 'General Condition' keyword",
        "semantics": "gc_keyword",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R102": {
        "category": "Consulting",
        "reason_zh": "结算前：WTC (4) + 供应商为 WB Texas Consulting LLC",
        "reason_en": "Before Settlement: WTC (4) + Vendor is WB Texas Consulting LLC",
        "semantics": "wtc_consulting_wbt",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R103": {
        "category": "GC2",
        "reason_zh": "结算前：WTC (4) + 供应商非关联咨询商",
        "reason_en": "Before Settlement: WTC (4) + Non-associated consulting vendor",
        "semantics": "wtc_gc2",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R104": {
        "category": "GC Income",
        "reason_zh": "结算前：Final GMP (1) + GC (5) + 供应商为 Wan Pacific",
        "reason_en": "Before Settlement: Final GMP (1) + GC (5) + Vendor is Wan Pacific",
        "semantics": "gmp_gc_income",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R105": {
        "category": "GC",
        "reason_zh": "结算前：Final GMP (1) + GC (5) + 供应商非 Wan Pacific",
        "reason_en": "Before Settlement: Final GMP (1) + GC (5) + Vendor is not Wan Pacific",
        "semantics": "gmp_gc_standard",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R106": {
        "category": "Income",
        "reason_zh": "结算前：Final GMP (1) + Fee (2) + 供应商为 Wan Pacific",
        "reason_en": "Before Settlement: Final GMP (1) + Fee (2) + Vendor is Wan Pacific",
        "semantics": "gmp_fee_income",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R107": {
        "category": "ROE",
        "reason_zh": "结算前：标准 ROE 特征 (Final GMP/Fee)",
        "reason_en": "Before Settlement: Standard ROE features (Final GMP/Fee)",
        "semantics": "gmp_roe_standard",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R108": {
        "category": "Direct",
        "reason_zh": "结算前：未命中任何 Scoping 标识（非 GMP 成本兜底）",
        "reason_en": "Before Settlement: No Scoping status matched (Direct fallback)",
        "semantics": "non_gmp_direct",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    # 第三类：结算后逻辑 (After Settlement / R200s)
    "R201": {
        "category": "ACC",
        "reason_zh": "结算后：仅有 Final Date 且无 Incurred Date",
        "reason_en": "After Settlement: Only Final Date present with no Incurred Date",
        "semantics": "post_settlement_acc",
        "sheet_scope": ("Final Detail",),
    },
    "R202": {
        "category": "RACC",
        "reason_zh": "结算后：命中跨表或成对的 RACC 配对键",
        "reason_en": "After Settlement: Matched cross-sheet or paired RACC key",
        "semantics": "post_settlement_racc",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R203": {
        "category": "TBD",
        "reason_zh": "结算后：(有效日期 > TBD Acceptance Date) 且 (Scoping J列 = 6)",
        "reason_en": "After Settlement: (Date > TBD Acceptance Date) AND (Scoping Column J = 6)",
        "semantics": "post_settlement_tbd",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R204": {
        "category": "RACC2",
        "reason_zh": "结算后：发生日 <= 保修到期日，且符合 Final GMP/Fee ROE 特征",
        "reason_en": "After Settlement: Date <= Warranty Expiry AND matches Final GMP/Fee ROE features",
        "semantics": "post_settlement_racc2",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    "R205": {
        "category": "EXP",
        "reason_zh": "结算后支出兜底",
        "reason_en": "After Settlement: General expense fallback",
        "semantics": "post_settlement_exp",
        "sheet_scope": ("Payable", "Final Detail"),
    },
    # 第四类：跨表修正 (Restore / R300s)
    "R301": {
        "category": "RACC",
        "reason_zh": "Restore: 结算前后窗口修正（Payable 端，独立判定）",
        "reason_en": "Restore: Settlement-window correction for Payable side (standalone)",
        "semantics": "restore_payable_racc",
        "sheet_scope": ("Payable",),
    },
    "R302": {
        "category": "ACC",
        "reason_zh": "Restore: 结算前后窗口修正（Final Detail 端，独立判定）",
        "reason_en": "Restore: Settlement-window correction for Final Detail side (standalone)",
        "semantics": "restore_final_detail_acc",
        "sheet_scope": ("Final Detail",),
    },
}

class ClassificationService:
    def __init__(self, sheet_map: Mapping[str, pd.DataFrame], dependencies: Mapping[str, Callable]):
        self.deps = dependencies # 显式保存依赖字典
        for key, func in dependencies.items():
            setattr(self, f"_{key}" if not key.startswith("_") else key, func)

        self.wsp = self._ensure_column_count(sheet_map[self._sheet_key(sheet_map, "Payable")], 43)
        self.wss = self._ensure_column_count(sheet_map[self._sheet_key(sheet_map, "Scoping")], 11)
        self.wsf = self._ensure_column_count(sheet_map[self._sheet_key(sheet_map, "Final Detail")], 30)
        self.wsb = self._ensure_column_count(sheet_map[self._sheet_key(sheet_map, "Unit Budget")], 16)
        self.wsm = self._ensure_column_count(sheet_map[self._sheet_key(sheet_map, "Unit Master")], 13)

        self.scoping_status_map = self._build_scoping_status_map(self.wss)
        self.scoping_warranty_months_map = self._build_scoping_warranty_months_map(self.wss)
        self.group_warranty_expiry_map = self._build_group_warranty_expiry_map(
            self.wsb,
            self.wsm,
            self.scoping_warranty_months_map,
        )
        self.warranty_expiry_date = max(self.group_warranty_expiry_map.values()) if self.group_warranty_expiry_map else None
        self.unit_schedule_map = self._build_unit_budget_schedule_map(self.wsb, self._load_default_unit_budget_schedule_overrides())
        self.final_detail_index = self._build_final_detail_classification_index(self.wsf, self.scoping_status_map, self.unit_schedule_map)

    def _build_scoping_warranty_months_map(self, wss: pd.DataFrame) -> Dict[int, float]:
        group_col = self._find_col_in_row(wss, 0, "Group Number") or 2
        warranty_col = (
            self._find_col_in_row(wss, 0, "Warranty Months")
            or self._find_col_in_row(wss, 0, "保修月数")
            or 10
        )
        out: Dict[int, float] = {}
        for r in range(len(wss)):
            code = self._to_float(self._get_cell(wss, r, group_col))
            months = self._to_float(self._get_cell(wss, r, warranty_col))
            if code is None or months is None:
                continue
            out[int(code)] = float(months)
        return out

    def _build_group_warranty_expiry_map(
        self,
        wsb: pd.DataFrame,
        wsm: pd.DataFrame,
        warranty_months_map: Mapping[int, float],
    ) -> Dict[int, pd.Timestamp]:
        latest_co_date_by_group: Dict[int, pd.Timestamp] = {}

        def collect_latest(df: pd.DataFrame, group_default: int, co_default: int) -> None:
            group_col = (
                self._find_col_in_headers(df, "Group")
                or self._find_col_in_row(df, 0, "Group")
                or group_default
            )
            co_col = (
                self._find_col_in_headers(df, "C/O date")
                or self._find_col_in_row(df, 0, "C/O date")
                or co_default
            )
            for row_idx in range(len(df)):
                group_number = self._to_float(self._get_cell(df, row_idx, group_col))
                co_date = self._normalize_date_value(self._get_cell(df, row_idx, co_col))
                if group_number is None or co_date is None:
                    continue
                group_key = int(group_number)
                existing = latest_co_date_by_group.get(group_key)
                if existing is None or co_date > existing:
                    latest_co_date_by_group[group_key] = co_date

        collect_latest(wsm, 13, 8)
        collect_latest(wsb, 13, 8)

        out: Dict[int, pd.Timestamp] = {}
        for group_key, latest_co_date in latest_co_date_by_group.items():
            warranty_months = warranty_months_map.get(group_key)
            if warranty_months is None:
                continue
            out[group_key] = latest_co_date + pd.to_timedelta(float(warranty_months) * 30.25, unit="D")
        return out

    def compute(self) -> Dict[str, Any]:
        payable_decisions_initial, payable_extra_initial = self._compute_payable_classifications_initial(
            self.wsp, self.scoping_status_map, self.unit_schedule_map, self.final_detail_index
        )
        final_detail_decisions_initial, final_detail_extra_initial = self._compute_final_detail_classifications_initial(
            self.wsf, self.scoping_status_map, self.unit_schedule_map, self.final_detail_index
        )
        payable_decisions, final_detail_decisions, restore_extra = self._apply_exp_restore_overrides(
            self.wsp,
            self.wsf,
            payable_decisions_initial,
            final_detail_decisions_initial,
            self.scoping_status_map,
            self.unit_schedule_map,
        )
        payable_categories = self._build_decision_categories(payable_decisions)
        final_detail_categories = self._build_decision_categories(final_detail_decisions)
        payable_extra = self._merge_restore_extra(payable_extra_initial, restore_extra)
        payable_extra["classification_counts"] = self._build_classification_counts(payable_categories)
        payable_extra["decisions"] = list(payable_decisions)
        payable_extra["rule_ids"] = [decision.rule_id for decision in payable_decisions]
        final_detail_extra = self._merge_restore_extra(final_detail_extra_initial, restore_extra)
        final_detail_extra["classification_counts"] = self._build_classification_counts(final_detail_categories)
        final_detail_extra["decisions"] = list(final_detail_decisions)
        final_detail_extra["rule_ids"] = [decision.rule_id for decision in final_detail_decisions]
        return {
            "payable_decisions": payable_decisions,
            "payable_categories": payable_categories,
            "payable_extra": payable_extra,
            "final_detail_decisions": final_detail_decisions,
            "final_detail_categories": final_detail_categories,
            "final_detail_extra": final_detail_extra,
            "restore_extra": restore_extra,
        }

    def _decision(self, rule_id: str, category_override: str | None = None, warnings: Sequence[str] | None = None, evidence: Mapping[str, Any] | None = None) -> ClassificationDecision:
        if not rule_id:
             return ClassificationDecision(
                category=category_override or "",
                rule_id="",
                reason_zh="",
                reason_en="",
                warnings=tuple(warnings or ()),
                evidence=dict(evidence or {}),
            )
        if rule_id not in RULE_REGISTRY:
            raise KeyError(f"unknown rule_id: {rule_id}")
        rule = RULE_REGISTRY[rule_id]
        category = str(rule["category"]) if category_override is None else category_override
        return ClassificationDecision(
            category=category,
            rule_id=rule_id,
            reason_zh=str(rule["reason_zh"]),
            reason_en=str(rule["reason_en"]),
            warnings=tuple(warnings or ()),
            evidence=dict(evidence or {}),
        )

    def _column_values_1based(self, df: pd.DataFrame, col_idx_1: int) -> List[Any]:
        if len(df) == 0:
            return []
        col_idx_0 = col_idx_1 - 1
        if col_idx_0 < 0 or col_idx_0 >= len(df.columns):
            return [""] * len(df)
        return df.iloc[:, col_idx_0].tolist()

    def _make_final_detail_pair_key(self, vendor: Any, activity_no: Any, amount: Any, cost_code: Any) -> Tuple[str, str, float, str]:
        return (
            self._normalize_text_key(vendor),
            self._normalize_text_key(activity_no),
            abs(self._normalize_amount_key(amount)),
            self._normalize_text_key(cost_code),
        )

    def _make_payable_racc_key(self, vendor: Any, amount: Any, cost_code: Any, incurred_date: Any) -> Tuple[str, float, str, str]:
        dt = self._normalize_date_value(incurred_date)
        return (
            self._normalize_text_key(vendor),
            abs(self._normalize_amount_key(amount)),
            self._normalize_text_key(cost_code),
            dt.strftime("%Y-%m-%d") if dt is not None else "",
        )

    def _make_exp_restore_match_key(self, vendor: Any, amount: Any, cost_code: Any, incurred_date: Any) -> Tuple[str, float, str, str]:
        return self._make_payable_racc_key(vendor, amount, cost_code, incurred_date)

    def _build_scoping_status_map(self, wss: pd.DataFrame) -> Dict[int, set[int]]:
        group_col = self._find_col_in_row(wss, 0, "Group Number") or 2
        final_gmp_col = self._find_col_in_row(wss, 0, "Final GMP")
        status_cols = {
            1: final_gmp_col or self._find_col_in_row(wss, 0, "GMP") or 4,
            2: self._find_col_in_row(wss, 0, "Fee") or 5,
            3: self._find_col_in_row(wss, 0, "WIP") or 6,
            4: self._find_col_in_row(wss, 0, "WTC") or 7,
            5: self._find_col_in_row(wss, 0, "GC") or 8,
            6: self._find_col_in_row(wss, 0, "TBD") or 9,
        }
        out: Dict[int, set[int]] = {}
        for r in range(len(wss)):
            code = self._to_float(self._get_cell(wss, r, group_col))
            if code is None:
                continue
            key = int(code)
            statuses: set[int] = set()
            for status_id, col_i in status_cols.items():
                val = self._to_float(self._get_cell(wss, r, col_i))
                if val is not None and abs(val - status_id) < 1e-9:
                    statuses.add(status_id)
            out[key] = statuses
        return out

    def _classify_before_actual_settlement(self, unit_code: Any, vendor: Any, statuses: set[int]) -> Tuple[str, str]:
        if self._contains_general_condition(unit_code):
            return "GC", "R101"

        vendor_str = self._safe_string(vendor).upper()

        # P1: Consulting (WTC + WB Texas) -> R102 / R103
        if 4 in statuses:
            if "WB TEXAS" in vendor_str:
                return "Consulting", "R102"
            return "GC2", "R103"

        # P2: GC Income (GMP + GC + Wan Pacific) -> R104 / R105
        if 1 in statuses and 5 in statuses:
            if "WAN PACIFIC" in vendor_str:
                return "GC Income", "R104"
            return "GC", "R105"

        # P3: Income (GMP + Fee + Wan Pacific) -> R106
        if 1 in statuses and 2 in statuses and "WAN PACIFIC" in vendor_str:
            return "Income", "R106"

        # P4: ROE (Final GMP/Fee 兜底) -> R107
        if 1 in statuses or 2 in statuses:
            return "ROE", "R107"

        # P5: Direct (非 GMP 兜底) -> R108
        return "Direct", "R108"

    def _classify_payable_record(self, unit_code, vendor, amount, cost_code, incurred_date, statuses, actual_settlement_date, tbd_acceptance_date, payable_racc_keys):
        group_number = self._extract_tail_int(cost_code, 3)
        group_warranty_expiry = (
            self.group_warranty_expiry_map.get(int(group_number))
            if group_number is not None
            else None
        )
        evidence = {
            "unit_code": self._safe_string(unit_code),
            "vendor": self._safe_string(vendor),
            "cost_code": self._safe_string(cost_code),
            "incurred_date": self._iso_date_text(incurred_date),
            "actual_settlement_date": self._iso_date_text(actual_settlement_date),
            "group_number": str(group_number) if group_number is not None else "",
        }

        # P0: 全时段文本最高优先级 - General Condition 判定
        if self._contains_general_condition(unit_code):
            return self._decision("R101", evidence=evidence)

        actual_dt = self._normalize_date_value(actual_settlement_date)
        incurred_dt = self._normalize_date_value(incurred_date)
        tbd_dt = self._normalize_date_value(tbd_acceptance_date)

        # 仅当记录日期实际跨过结算线时，才进入结算后逻辑。
        is_after_settlement = False
        if incurred_dt is not None:
            if actual_dt is not None and incurred_dt >= actual_dt:
                is_after_settlement = True

        if not is_after_settlement:
            category, rule_id = self._classify_before_actual_settlement(unit_code, vendor, statuses)
            return self._decision(rule_id, category_override=category, evidence=evidence)

        # 第三类：结算后逻辑 (After Settlement)
        # 1. R202: RACC 配对 (Payable 端)
        if incurred_dt:
            payable_key = self._make_payable_racc_key(vendor, amount, cost_code, incurred_dt)
            if payable_key in payable_racc_keys:
                return self._decision("R202", evidence={**evidence, "racc_key": list(payable_key)})

        # 2. R203: TBD (时间 > TBD 接收日 且 Scoping J列=6)
        if incurred_dt and tbd_dt and incurred_dt > tbd_dt and 6 in statuses:
            return self._decision("R203", evidence=evidence)

        # 3. R204: RACC2 (发生日 <= 保修到期日 且符合 Final GMP/Fee ROE 特征)
        if incurred_dt and group_warranty_expiry is not None and incurred_dt <= group_warranty_expiry:
            if 1 in statuses or 2 in statuses:
                return self._decision("R204", evidence={**evidence, "warranty_expiry": self._iso_date_text(group_warranty_expiry)})

        # 4. R205: EXP 兜底
        return self._decision("R205", evidence=evidence)

    def _classify_final_detail_record(self, unit_code, vendor, amount, cost_code, activity_no, incurred_date, final_date, statuses, actual_settlement_date, tbd_acceptance_date, paired_racc_keys, record_type=None):
        group_number = self._extract_tail_int(cost_code, 3)
        group_warranty_expiry = (
            self.group_warranty_expiry_map.get(int(group_number))
            if group_number is not None
            else None
        )
        evidence = {
            "unit_code": self._safe_string(unit_code),
            "vendor": self._safe_string(vendor),
            "cost_code": self._safe_string(cost_code),
            "type": self._safe_string(record_type),
            "incurred_date": self._iso_date_text(incurred_date),
            "final_date": self._iso_date_text(final_date),
            "actual_settlement_date": self._iso_date_text(actual_settlement_date),
            "group_number": str(group_number) if group_number is not None else "",
        }

        # R000: 前置排除
        if self._normalize_text_key(record_type) == "SHARING":
            return self._decision("R000", evidence=evidence)

        # P0: 全时段文本最高优先级 - General Condition 判定
        if self._contains_general_condition(unit_code):
            return self._decision("R101", evidence=evidence)

        actual_dt = self._normalize_date_value(actual_settlement_date)
        incurred_dt = self._normalize_date_value(incurred_date)
        final_dt = self._normalize_date_value(final_date)
        tbd_dt = self._normalize_date_value(tbd_acceptance_date)
        event_dates = [dt for dt in (incurred_dt, final_dt) if dt is not None]
        event_dt = max(event_dates) if event_dates else None

        # 只要 Final Date 或 Incurred Date 任何一个实际跨过结算线，才进入结算后逻辑。
        is_after_settlement = False
        if actual_dt is not None:
            is_after_settlement = any(dt >= actual_dt for dt in event_dates)

        if not is_after_settlement:
            category, rule_id = self._classify_before_actual_settlement(unit_code, vendor, statuses)
            return self._decision(rule_id, category_override=category, evidence=evidence)

        # 第三类：结算后逻辑 (After Settlement)
        # 1. R201: ACC (仅有 Final Date)
        if final_dt is not None and incurred_dt is None:
            return self._decision("R201", evidence=evidence)

        # 2. R202: RACC 配对 (Final Detail 端)
        pair_key = self._make_final_detail_pair_key(vendor, activity_no, amount, cost_code)
        if pair_key in paired_racc_keys:
            return self._decision("R202", evidence={**evidence, "pair_key": list(pair_key)})

        # 3. R203: TBD (日期 > TBD 接收日 且 Scoping J列=6)
        if event_dt and tbd_dt and event_dt > tbd_dt and 6 in statuses:
            return self._decision("R203", evidence=evidence)

        # 4. R204: RACC2 (发生日 <= 保修到期日 且符合 Final GMP/Fee ROE 特征)
        if event_dt and group_warranty_expiry is not None and event_dt <= group_warranty_expiry:
            if 1 in statuses or 2 in statuses:
                return self._decision("R204", evidence={**evidence, "warranty_expiry": self._iso_date_text(group_warranty_expiry)})

        # 5. R205: EXP 兜底
        return self._decision("R205", evidence=evidence)

    def _payable_layout(self, df: pd.DataFrame) -> Dict[str, int | None]:
        return {
            "vendor": self._find_col_in_headers(df, "Vendor"),
            "amount": self._find_col_in_headers(df, "Amount"),
            "incurred_date": self._find_col_in_headers(df, "Incurred Date"),
            "unit_code": self._find_col_in_headers(df, "Unit Code"),
            "cost_code": self._find_col_in_headers(df, "Cost Code"),
        }

    def _final_detail_layout(self, df: pd.DataFrame) -> Dict[str, int | None]:
        return {
            "final_date": self._find_col_in_headers(df, "Final Date"),
            "incurred_date": self._find_col_in_headers(df, "Incurred Date"),
            "unit_code": self._find_col_in_headers(df, "Unit Code"),
            "activity_no": self._find_col_in_headers(df, "Activity No."),
            "cost_code": self._find_col_in_headers(df, "Cost Code"),
            "amount": self._find_col_in_headers(df, "Amount"),
            "vendor": self._find_col_in_headers(df, "Vendor"),
            "type": self._find_col_in_headers(df, "Type"),
        }

    def _resolve_unit_budget_schedule(self, schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]], unit_code: Any) -> Mapping[str, pd.Timestamp | None]:
        unit_text = self._safe_string(unit_code)
        if unit_text in schedule_map:
            return schedule_map[unit_text]
        if not self._has_digits(unit_text):
            return schedule_map.get("__COMMON_FALLBACK__", {})
        return {}

    def _build_final_detail_classification_index(self, wsf: pd.DataFrame, scoping_status_map: Mapping[int, set[int]], unit_schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]]) -> Dict[str, Any]:
        layout = self._final_detail_layout(wsf)
        unit_col = int(layout.get("unit_code") or 19)
        cost_col = int(layout.get("cost_code") or 24)
        vendor_col = int(layout.get("vendor") or 28)
        activity_col = int(layout.get("activity_no") or 21)
        amount_col = int(layout.get("amount") or 26)
        final_col = int(layout.get("final_date") or 13)
        incurred_col = int(layout.get("incurred_date") or 18)
        acc_pair_keys: set[Tuple[str, str, float, str]] = set()
        racc_pair_keys_all: set[Tuple[str, str, float, str]] = set()
        row_count = len(wsf)
        unit_codes = [self._safe_string(value) for value in self._column_values_1based(wsf, unit_col)]
        cost_codes = [self._safe_string(value) for value in self._column_values_1based(wsf, cost_col)]
        vendors = [self._safe_string(value) for value in self._column_values_1based(wsf, vendor_col)]
        activity_nos = [self._safe_string(value) for value in self._column_values_1based(wsf, activity_col)]
        amounts = self._column_values_1based(wsf, amount_col)
        final_dates = [self._normalize_date_value(value) for value in self._column_values_1based(wsf, final_col)]
        incurred_dates = [self._normalize_date_value(value) for value in self._column_values_1based(wsf, incurred_col)]
        type_col = int(layout.get("type") or 22)
        record_types = [self._safe_string(value) for value in self._column_values_1based(wsf, type_col)]

        for i in range(row_count):
            if record_types[i].upper() == "SHARING":
                continue

            unit_code = unit_codes[i]
            cost_code = cost_codes[i]
            vendor = vendors[i]
            activity_no = activity_nos[i]
            amount = amounts[i]
            final_dt = final_dates[i]
            incurred_dt = incurred_dates[i]
            event_dt = incurred_dt or final_dt
            if event_dt is None:
                continue

            actual_dt = self._resolve_unit_budget_schedule(unit_schedule_map, unit_code).get("actual_settlement_date")
            if actual_dt is None or event_dt < actual_dt:
                continue

            group_number = self._extract_tail_int(cost_code, 3)
            statuses = scoping_status_map.get(int(group_number), set()) if group_number is not None else set()
            if 1 not in statuses:
                continue

            pair_key = self._make_final_detail_pair_key(vendor, activity_no, amount, cost_code)
            if final_dt is not None and incurred_dt is None:
                acc_pair_keys.add(pair_key)
            if incurred_dt is not None and final_dt is None:
                racc_pair_keys_all.add(pair_key)

        paired_racc_keys = acc_pair_keys & racc_pair_keys_all
        payable_racc_keys: set[Tuple[str, float, str, str]] = set()
        for i in range(row_count):
            vendor = vendors[i]
            activity_no = activity_nos[i]
            amount = amounts[i]
            cost_code = cost_codes[i]
            incurred_dt = incurred_dates[i]
            final_dt = final_dates[i]
            if incurred_dt is None or final_dt is not None:
                continue
            pair_key = self._make_final_detail_pair_key(vendor, activity_no, amount, cost_code)
            if pair_key in paired_racc_keys:
                payable_racc_keys.add(self._make_payable_racc_key(vendor, amount, cost_code, incurred_dt))

        return {
            "paired_racc_keys": paired_racc_keys,
            "payable_racc_keys": payable_racc_keys,
            "acc_pair_key_count": len(acc_pair_keys),
            "paired_racc_key_count": len(paired_racc_keys),
        }

    def _compute_payable_classifications_initial(self, wsp: pd.DataFrame, scoping_status_map: Mapping[int, set[int]], unit_schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]], final_detail_index: Mapping[str, Any]) -> Tuple[List[ClassificationDecision], Dict[str, Any]]:
        layout = self._payable_layout(wsp)
        vendor_col = int(layout.get("vendor") or 10)
        amount_col = int(layout.get("amount") or 16)
        incurred_col = int(layout.get("incurred_date") or 17)
        unit_col = int(layout.get("unit_code") or 33)
        cost_col = int(layout.get("cost_code") or 34)
        classification_counts: Dict[str, int] = {}
        issue_counts: Dict[str, int] = {}
        issue_samples: List[Dict[str, Any]] = []
        decisions: List[ClassificationDecision] = []
        payable_racc_keys = set(final_detail_index.get("payable_racc_keys", set()))
        row_count = len(wsp)
        vendors = [self._safe_string(value) for value in self._column_values_1based(wsp, vendor_col)]
        incurred_dates = self._column_values_1based(wsp, incurred_col)
        cost_codes = [self._safe_string(value) for value in self._column_values_1based(wsp, cost_col)]
        unit_codes = [self._safe_string(value) for value in self._column_values_1based(wsp, unit_col)]
        amounts = self._column_values_1based(wsp, amount_col)

        for i in range(row_count):
            vendor = vendors[i]
            incurred_date = incurred_dates[i]
            cost_code = cost_codes[i]
            unit_code = unit_codes[i]
            amount_val = amounts[i]
            group_number = self._extract_tail_int(cost_code, 3)

            statuses = scoping_status_map.get(int(group_number), set()) if group_number is not None else set()
            unit_schedule = self._resolve_unit_budget_schedule(unit_schedule_map, unit_code)
            decision = self._classify_payable_record(
                unit_code=unit_code,
                vendor=vendor,
                amount=amount_val,
                cost_code=cost_code,
                incurred_date=incurred_date,
                statuses=statuses,
                actual_settlement_date=unit_schedule.get("actual_settlement_date"),
                tbd_acceptance_date=unit_schedule.get("tbd_acceptance_date"),
                payable_racc_keys=payable_racc_keys,
            )
            decisions.append(decision)
            classification_counts[decision.category or "(blank)"] = classification_counts.get(decision.category or "(blank)", 0) + 1
            for issue in decision.warnings:
                issue_counts[issue] = issue_counts.get(issue, 0) + 1
            if decision.warnings and len(issue_samples) < 20:
                issue_samples.append(
                    {
                        "sheet": "Payable",
                        "row": i + 2,
                        "unit_code": unit_code,
                        "vendor": vendor,
                        "cost_code": cost_code,
                        "category": decision.category,
                        "issues": ",".join(decision.warnings),
                    }
                )

        return decisions, {
            "processed_rows": row_count,
            "classification_counts": classification_counts,
            "issue_counts": issue_counts,
            "issue_samples": issue_samples,
        }

    def _compute_final_detail_classifications_initial(self, wsf: pd.DataFrame, scoping_status_map: Mapping[int, set[int]], unit_schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]], final_detail_index: Mapping[str, Any]) -> Tuple[List[ClassificationDecision], Dict[str, Any]]:
        layout = self._final_detail_layout(wsf)
        cost_col = int(layout.get("cost_code") or 24)
        unit_col = int(layout.get("unit_code") or 19)
        vendor_col = int(layout.get("vendor") or 28)
        amount_col = int(layout.get("amount") or 26)
        activity_col = int(layout.get("activity_no") or 21)
        final_col = int(layout.get("final_date") or 13)
        incurred_col = int(layout.get("incurred_date") or 18)
        classification_counts: Dict[str, int] = {}
        issue_counts: Dict[str, int] = {}
        issue_samples: List[Dict[str, Any]] = []
        decisions: List[ClassificationDecision] = []
        paired_racc_keys = set(final_detail_index.get("paired_racc_keys", set()))
        row_count = len(wsf)
        cost_codes = [self._safe_string(value) for value in self._column_values_1based(wsf, cost_col)]
        unit_codes = [self._safe_string(value) for value in self._column_values_1based(wsf, unit_col)]
        vendors = [self._safe_string(value) for value in self._column_values_1based(wsf, vendor_col)]
        amounts = self._column_values_1based(wsf, amount_col)
        activity_nos = [self._safe_string(value) for value in self._column_values_1based(wsf, activity_col)]
        final_dates = self._column_values_1based(wsf, final_col)
        incurred_dates = self._column_values_1based(wsf, incurred_col)
        type_col = int(layout.get("type") or 22)
        record_types = [self._safe_string(value) for value in self._column_values_1based(wsf, type_col)]

        for i in range(row_count):
            cost_code = cost_codes[i]
            unit_code = unit_codes[i]
            vendor = vendors[i]
            amount_val = amounts[i]
            activity_no = activity_nos[i]
            final_date = final_dates[i]
            incurred_date = incurred_dates[i]
            record_type = record_types[i]
            group_number = self._extract_tail_int(cost_code, 3)
            statuses = scoping_status_map.get(int(group_number), set()) if group_number is not None else set()
            unit_schedule = self._resolve_unit_budget_schedule(unit_schedule_map, unit_code)
            decision = self._classify_final_detail_record(
                unit_code=unit_code,
                vendor=vendor,
                amount=amount_val,
                cost_code=cost_code,
                activity_no=activity_no,
                incurred_date=incurred_date,
                final_date=final_date,
                statuses=statuses,
                actual_settlement_date=unit_schedule.get("actual_settlement_date"),
                tbd_acceptance_date=unit_schedule.get("tbd_acceptance_date"),
                paired_racc_keys=paired_racc_keys,
                record_type=record_type,
            )
            decisions.append(decision)
            classification_counts[decision.category or "(blank)"] = classification_counts.get(decision.category or "(blank)", 0) + 1
            for issue in decision.warnings:
                issue_counts[issue] = issue_counts.get(issue, 0) + 1
            if decision.warnings and len(issue_samples) < 20:
                issue_samples.append(
                    {
                        "sheet": "Final Detail",
                        "row": i + 2,
                        "unit_code": unit_code,
                        "vendor": vendor,
                        "cost_code": cost_code,
                        "category": decision.category,
                        "issues": ",".join(decision.warnings),
                    }
                )

        return decisions, {
            "processed_rows": row_count,
            "classification_counts": classification_counts,
            "issue_counts": issue_counts,
            "issue_samples": issue_samples,
            "paired_racc_key_count": int(final_detail_index.get("paired_racc_key_count", 0)),
        }

    def _apply_exp_restore_overrides(self, wsp: pd.DataFrame, wsf: pd.DataFrame, payable_decisions: Sequence[ClassificationDecision], final_detail_decisions: Sequence[ClassificationDecision], scoping_status_map: Mapping[int, set[int]], unit_schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]]) -> Tuple[List[ClassificationDecision], List[ClassificationDecision], Dict[str, Any]]:
        adjusted_payable = list(payable_decisions)
        adjusted_final_detail = list(final_detail_decisions)
        payable_layout = self._payable_layout(wsp)
        final_layout = self._final_detail_layout(wsf)

        payable_vendor_col = int(payable_layout.get("vendor") or 10)
        payable_amount_col = int(payable_layout.get("amount") or 16)
        payable_incurred_col = int(payable_layout.get("incurred_date") or 17)
        payable_unit_col = int(payable_layout.get("unit_code") or 33)
        payable_cost_col = int(payable_layout.get("cost_code") or 34)

        final_vendor_col = int(final_layout.get("vendor") or 28)
        final_amount_col = int(final_layout.get("amount") or 26)
        final_final_col = int(final_layout.get("final_date") or 13)
        final_incurred_col = int(final_layout.get("incurred_date") or 18)
        final_unit_col = int(final_layout.get("unit_code") or 19)
        final_cost_col = int(final_layout.get("cost_code") or 24)

        payable_candidates: Dict[Tuple[str, float, str, str], List[Dict[str, Any]]] = {}
        final_candidates: Dict[Tuple[str, float, str, str], List[Dict[str, Any]]] = {}
        payable_vendors = [self._safe_string(value) for value in self._column_values_1based(wsp, payable_vendor_col)]
        payable_amounts = self._column_values_1based(wsp, payable_amount_col)
        payable_incurred_dates = [self._normalize_date_value(value) for value in self._column_values_1based(wsp, payable_incurred_col)]
        payable_unit_codes = [self._safe_string(value) for value in self._column_values_1based(wsp, payable_unit_col)]
        payable_cost_codes = [self._safe_string(value) for value in self._column_values_1based(wsp, payable_cost_col)]

        final_vendors = [self._safe_string(value) for value in self._column_values_1based(wsf, final_vendor_col)]
        final_amounts = self._column_values_1based(wsf, final_amount_col)
        final_dates = [self._normalize_date_value(value) for value in self._column_values_1based(wsf, final_final_col)]
        final_incurred_dates = [self._normalize_date_value(value) for value in self._column_values_1based(wsf, final_incurred_col)]
        final_unit_codes = [self._safe_string(value) for value in self._column_values_1based(wsf, final_unit_col)]
        final_cost_codes = [self._safe_string(value) for value in self._column_values_1based(wsf, final_cost_col)]

        for i, decision in enumerate(payable_decisions):
            if decision.category != "EXP":
                continue
            cost_code = payable_cost_codes[i]
            group_number = self._extract_tail_int(cost_code, 3)
            statuses = scoping_status_map.get(int(group_number), set()) if group_number is not None else set()
            if 1 not in statuses:
                continue
            payable_incurred_dt = payable_incurred_dates[i]
            if payable_incurred_dt is None:
                continue
            key = self._make_exp_restore_match_key(
                payable_vendors[i],
                payable_amounts[i],
                cost_code,
                payable_incurred_dt,
            )
            payable_candidates.setdefault(key, []).append(
                {
                    "index": i,
                    "vendor": payable_vendors[i],
                    "amount": self._normalize_amount_key(payable_amounts[i]),
                    "cost_code": cost_code,
                    "unit_code": payable_unit_codes[i],
                    "payable_incurred_date": payable_incurred_dt,
                }
            )

        for i, decision in enumerate(final_detail_decisions):
            if decision.category != "EXP":
                continue
            cost_code = final_cost_codes[i]
            group_number = self._extract_tail_int(cost_code, 3)
            statuses = scoping_status_map.get(int(group_number), set()) if group_number is not None else set()
            if 1 not in statuses:
                continue
            final_dt = final_dates[i]
            final_incurred_dt = final_incurred_dates[i]
            if final_dt is None or final_incurred_dt is None:
                continue
            key = self._make_exp_restore_match_key(
                final_vendors[i],
                final_amounts[i],
                cost_code,
                final_incurred_dt,
            )
            unit_code = final_unit_codes[i]
            final_candidates.setdefault(key, []).append(
                {
                    "index": i,
                    "vendor": final_vendors[i],
                    "amount": self._normalize_amount_key(final_amounts[i]),
                    "cost_code": cost_code,
                    "unit_code": unit_code,
                    "incurred_date": final_incurred_dt,
                    "final_date": final_dt,
                    "actual_settlement_date": self._resolve_unit_budget_schedule(unit_schedule_map, unit_code).get(
                        "actual_settlement_date"
                    ),
                }
            )

        restore_hit_count = 0
        restore_samples: List[Dict[str, Any]] = []
        payable_restore_hit_count = 0
        final_detail_restore_hit_count = 0
        payable_restore_samples: List[Dict[str, Any]] = []
        final_detail_restore_samples: List[Dict[str, Any]] = []
        payable_missing_final_detail_count = 0
        payable_missing_final_detail_samples: List[Dict[str, Any]] = []
        final_detail_missing_payable_count = 0
        final_detail_missing_payable_samples: List[Dict[str, Any]] = []
        matched_keys: set[Tuple[str, float, str, str]] = set()

        for key, payable_matches in payable_candidates.items():
            if len(payable_matches) != 1:
                continue
            payable_item = payable_matches[0]
            final_matches = final_candidates.get(key, [])
            matched_final_item = None
            if len(final_matches) == 1 and final_matches[0]["unit_code"] == payable_item["unit_code"]:
                matched_final_item = final_matches[0]
                matched_keys.add(key)

            payable_incurred_dt = self._normalize_date_value(payable_item.get("payable_incurred_date"))
            restore_evidence = {
                "unit_code": payable_item["unit_code"],
                "vendor": payable_item["vendor"],
                "amount": payable_item["amount"],
                "cost_code": payable_item["cost_code"],
                "payable_key": list(key),
                "payable_incurred_date": payable_incurred_dt.strftime("%Y-%m-%d") if payable_incurred_dt is not None else "",
                "restore_match_status": "matched_to_final_detail" if matched_final_item else "payable_only",
            }
            if matched_final_item is not None:
                actual_dt = self._normalize_date_value(matched_final_item.get("actual_settlement_date"))
                final_dt = self._normalize_date_value(matched_final_item.get("final_date"))
                restore_evidence["final_detail_row"] = matched_final_item["index"] + 2
                restore_evidence["final_detail_final_date"] = final_dt.strftime("%Y-%m-%d") if final_dt is not None else ""
                restore_evidence["actual_settlement_date"] = actual_dt.strftime("%Y-%m-%d") if actual_dt is not None else ""

            adjusted_payable[payable_item["index"]] = self._decision("R301", evidence=restore_evidence)
            payable_restore_hit_count += 1
            if len(payable_restore_samples) < 20:
                payable_restore_samples.append(
                    {
                        "match_key": "|".join(str(part) for part in key),
                        "payable_row": payable_item["index"] + 2,
                        "vendor": payable_item["vendor"],
                        "amount": payable_item["amount"],
                        "cost_code": payable_item["cost_code"],
                        "unit_code": payable_item["unit_code"],
                        "payable_incurred_date": restore_evidence["payable_incurred_date"],
                        "restore_match_status": restore_evidence["restore_match_status"],
                    }
                )
            if matched_final_item is None:
                payable_missing_final_detail_count += 1
                if len(payable_missing_final_detail_samples) < 20:
                    payable_missing_final_detail_samples.append(
                        {
                            "match_key": "|".join(str(part) for part in key),
                            "payable_row": payable_item["index"] + 2,
                            "vendor": payable_item["vendor"],
                            "amount": payable_item["amount"],
                            "cost_code": payable_item["cost_code"],
                            "unit_code": payable_item["unit_code"],
                            "payable_incurred_date": restore_evidence["payable_incurred_date"],
                        }
                    )

        for key, final_matches in final_candidates.items():
            if len(final_matches) != 1:
                continue
            final_item = final_matches[0]
            payable_matches = payable_candidates.get(key, [])
            matched_payable_item = None
            if len(payable_matches) == 1 and payable_matches[0]["unit_code"] == final_item["unit_code"]:
                matched_payable_item = payable_matches[0]

            actual_dt = self._normalize_date_value(final_item.get("actual_settlement_date"))
            final_dt = self._normalize_date_value(final_item.get("final_date"))
            incurred_dt = self._normalize_date_value(final_item.get("incurred_date"))
            restore_evidence = {
                "unit_code": final_item["unit_code"],
                "vendor": final_item["vendor"],
                "amount": final_item["amount"],
                "cost_code": final_item["cost_code"],
                "payable_key": list(key),
                "payable_incurred_date": incurred_dt.strftime("%Y-%m-%d") if incurred_dt is not None else "",
                "final_detail_final_date": final_dt.strftime("%Y-%m-%d") if final_dt is not None else "",
                "actual_settlement_date": actual_dt.strftime("%Y-%m-%d") if actual_dt is not None else "",
                "restore_match_status": "matched_to_payable" if matched_payable_item else "final_detail_only",
            }
            if matched_payable_item is not None:
                restore_evidence["payable_row"] = matched_payable_item["index"] + 2

            adjusted_final_detail[final_item["index"]] = self._decision("R302", evidence=restore_evidence)
            final_detail_restore_hit_count += 1
            if len(final_detail_restore_samples) < 20:
                final_detail_restore_samples.append(
                    {
                        "match_key": "|".join(str(part) for part in key),
                        "final_detail_row": final_item["index"] + 2,
                        "vendor": final_item["vendor"],
                        "amount": final_item["amount"],
                        "cost_code": final_item["cost_code"],
                        "unit_code": final_item["unit_code"],
                        "payable_incurred_date": restore_evidence["payable_incurred_date"],
                        "final_detail_final_date": restore_evidence["final_detail_final_date"],
                        "actual_settlement_date": restore_evidence["actual_settlement_date"],
                        "restore_match_status": restore_evidence["restore_match_status"],
                    }
                )
            if matched_payable_item is None:
                final_detail_missing_payable_count += 1
                if len(final_detail_missing_payable_samples) < 20:
                    final_detail_missing_payable_samples.append(
                        {
                            "match_key": "|".join(str(part) for part in key),
                            "final_detail_row": final_item["index"] + 2,
                            "vendor": final_item["vendor"],
                            "amount": final_item["amount"],
                            "cost_code": final_item["cost_code"],
                            "unit_code": final_item["unit_code"],
                            "payable_incurred_date": restore_evidence["payable_incurred_date"],
                            "final_detail_final_date": restore_evidence["final_detail_final_date"],
                        }
                    )

        for key in matched_keys:
            payable_item = payable_candidates[key][0]
            final_item = final_candidates[key][0]
            actual_dt = self._normalize_date_value(final_item.get("actual_settlement_date"))
            final_dt = self._normalize_date_value(final_item.get("final_date"))
            payable_incurred_dt = self._normalize_date_value(payable_item.get("payable_incurred_date"))
            restore_hit_count += 1
            if len(restore_samples) < 20:
                restore_samples.append(
                    {
                        "match_key": "|".join(str(part) for part in key),
                        "payable_row": payable_item["index"] + 2,
                        "final_detail_row": final_item["index"] + 2,
                        "vendor": payable_item["vendor"],
                        "amount": payable_item["amount"],
                        "cost_code": payable_item["cost_code"],
                        "unit_code": final_item["unit_code"] or payable_item["unit_code"],
                        "payable_incurred_date": payable_incurred_dt.strftime("%Y-%m-%d") if payable_incurred_dt is not None else "",
                        "final_detail_final_date": final_dt.strftime("%Y-%m-%d") if final_dt is not None else "",
                        "actual_settlement_date": actual_dt.strftime("%Y-%m-%d") if actual_dt is not None else "",
                    }
                )

        restore_extra = {
            "restore_hit_count": restore_hit_count,
            "restore_samples": restore_samples,
            "payable_restore_hit_count": payable_restore_hit_count,
            "payable_restore_samples": payable_restore_samples,
            "final_detail_restore_hit_count": final_detail_restore_hit_count,
            "final_detail_restore_samples": final_detail_restore_samples,
            "payable_missing_final_detail_count": payable_missing_final_detail_count,
            "payable_missing_final_detail_samples": payable_missing_final_detail_samples,
            "final_detail_missing_payable_count": final_detail_missing_payable_count,
            "final_detail_missing_payable_samples": final_detail_missing_payable_samples,
        }
        return adjusted_payable, adjusted_final_detail, restore_extra

    def _merge_restore_extra(self, extra: Mapping[str, Any], restore_extra: Mapping[str, Any]) -> Dict[str, Any]:
        merged = dict(extra)
        merged.update(restore_extra)
        return merged

    def _build_classification_counts(self, categories: Sequence[str]) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for category in categories:
            key = category or "(blank)"
            counts[key] = counts.get(key, 0) + 1
        return counts

    def _build_decision_categories(self, decisions: Sequence[ClassificationDecision]) -> List[str]:
        return [decision.category for decision in decisions]

    # The lru_cache decorators need to be handled.
    # We can't use them on instance methods directly without issues.
    # For this refactoring, I will make them static methods and keep the cache.
    # This means they can't use `self`.
    @staticmethod
    @lru_cache(maxsize=8192)
    def _iso_date_text_from_parts(year: int, month: int, day: int) -> str:
        return f"{year:04d}-{month:02d}-{day:02d}"

    @lru_cache(maxsize=8192)
    def _iso_date_text_from_string(self, text: str) -> str:
        dt = self._normalize_date_value(text)
        if dt is None:
            return ""
        return self._iso_date_text_from_parts(int(dt.year), int(dt.month), int(dt.day))

    def _iso_date_text(self, value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, pd.Timestamp):
            if pd.isna(value):
                return ""
            return self._iso_date_text_from_parts(int(value.year), int(value.month), int(value.day))
        if isinstance(value, datetime):
            return self._iso_date_text_from_parts(value.year, value.month, value.day)
        if isinstance(value, date):
            return self._iso_date_text_from_parts(value.year, value.month, value.day)
        if isinstance(value, str):
            text = self._safe_string(value)
            if not text:
                return ""
            return self._iso_date_text_from_string(text)
        if pd.isna(value):
            return ""
        dt = self._normalize_date_value(value)
        if dt is None:
            return ""
        return self._iso_date_text_from_parts(int(dt.year), int(dt.month), int(dt.day))
