from __future__ import annotations

import re
from collections.abc import Mapping

from .finance_mapping import ExcelSemanticMapper
from .finance_utils import column_index_to_letter


PRIMARY_109_YEAR_COLUMNS = tuple("FGHIJK")
AUDIT_109_YEAR_COLUMNS = tuple("MNOPQR")

class MappingIncompleteError(KeyError):
    pass


class FormulaTemplateResolver:
    _PLACEHOLDER_PATTERN = re.compile(r"\$\{([A-Za-z0-9_.]+)(?::(col|range))?\}")

    def resolve_formula(
        self,
        template: str,
        mappings: Mapping[str, object],
        context: Mapping[str, object] | None = None,
    ) -> str:
        if not isinstance(template, str):
            raise TypeError("template must be a string")
        if not isinstance(mappings, Mapping):
            raise TypeError("mappings must be a mapping")
        runtime_context = context if isinstance(context, Mapping) else {}

        def _replace(match: re.Match[str]) -> str:
            logical_field = match.group(1)
            explicit_mode = match.group(2)
            if logical_field == "SELF_ROW":
                return self._resolve_self_row(runtime_context)
            if logical_field == "SELF_COL":
                return self._resolve_self_col(runtime_context, explicit_mode or self._infer_mode(match, template))
            column_index = self._resolve_column_index(logical_field, mappings)
            column_letter = column_index_to_letter(column_index)
            mode = explicit_mode or self._infer_mode(match, template)
            if mode == "col":
                return f"${column_letter}"
            return f"${column_letter}:${column_letter}"

        return self._PLACEHOLDER_PATTERN.sub(_replace, template)

    def _resolve_column_index(self, logical_field: str, mappings: Mapping[str, object]) -> int:
        if "." not in logical_field:
            raise MappingIncompleteError(f"Missing sheet scope in mapping key: {logical_field}")
        sheet_name, field_name = logical_field.split(".", 1)

        resolved: object | None = None
        sheet_mapping = mappings.get(sheet_name)
        if isinstance(sheet_mapping, Mapping) and field_name in sheet_mapping:
            resolved = sheet_mapping[field_name]
        elif logical_field in mappings:
            resolved = mappings[logical_field]

        if resolved is None:
            raise MappingIncompleteError(f"Missing mapping for {logical_field}")

        try:
            column_index = int(resolved)
        except (TypeError, ValueError) as exc:
            raise MappingIncompleteError(f"Invalid mapping value for {logical_field}: {resolved}") from exc
        if column_index < 1:
            raise MappingIncompleteError(f"Invalid mapping value for {logical_field}: {resolved}")
        return column_index

    def _infer_mode(self, match: re.Match[str], template: str) -> str:
        next_char = template[match.end() : match.end() + 1]
        if next_char and (next_char.isdigit() or next_char == "$"):
            return "col"
        return "range"

    def _resolve_self_row(self, context: Mapping[str, object]) -> str:
        if "self_row" not in context:
            raise MappingIncompleteError("Missing context for SELF_ROW")
        value = context.get("self_row")
        try:
            row_number = int(value)  # type: ignore[arg-type]
        except (TypeError, ValueError) as exc:
            raise MappingIncompleteError(f"Invalid SELF_ROW value: {value}") from exc
        if row_number < 1:
            raise MappingIncompleteError(f"Invalid SELF_ROW value: {value}")
        return str(row_number)

    def _resolve_self_col(self, context: Mapping[str, object], mode: str) -> str:
        if "self_col" not in context:
            raise MappingIncompleteError("Missing context for SELF_COL")
        raw_col = str(context.get("self_col", "")).strip().upper()
        if not re.fullmatch(r"[A-Z]+", raw_col):
            raise MappingIncompleteError(f"Invalid SELF_COL value: {raw_col}")
        if mode == "range":
            return f"${raw_col}:${raw_col}"
        return f"${raw_col}"


class FinanceFormulaGenerator:
    def __init__(self, mapper: ExcelSemanticMapper, config: dict | None = None):
        self.mapper = mapper
        self.config = dict(config or getattr(mapper, "config", {}) or {})
        self.formula_resolver = FormulaTemplateResolver()
        self.formula_mappings = self._resolve_formula_mappings()
        self.formula_sheet_titles = self._resolve_formula_sheet_titles()
        self.primary_year_columns = self._resolve_year_columns(
            self.config.get("primary_year_cols"),
            PRIMARY_109_YEAR_COLUMNS,
        )
        self.audit_year_columns = self._resolve_year_columns(
            self.config.get("audit_year_cols"),
            AUDIT_109_YEAR_COLUMNS,
        )
        self.start_year_anchor_ref = self._resolve_start_year_anchor_ref()

    def _resolve_formula_mappings(self) -> dict:
        configured = self.config.get("formula_mappings")
        if not isinstance(configured, Mapping):
            return {}

        mappings: dict[str, object] = {}
        for sheet_name, sheet_mapping in configured.items():
            if isinstance(sheet_mapping, Mapping):
                target = mappings.setdefault(str(sheet_name), {})
                target.update(sheet_mapping)
            else:
                mappings[str(sheet_name)] = sheet_mapping
        return mappings

    def _resolve_formula_sheet_titles(self) -> dict[str, str]:
        configured = self.config.get("formula_sheet_titles")
        if not isinstance(configured, Mapping):
            return {}
        out: dict[str, str] = {}
        for scope, title in configured.items():
            scope_key = str(scope).strip()
            title_value = str(title).strip()
            if scope_key and title_value:
                out[scope_key] = title_value
        return out

    def _resolve_year_columns(self, configured: object, fallback: tuple[str, ...]) -> tuple[str, ...]:
        if not isinstance(configured, (list, tuple)):
            return tuple(fallback)
        resolved: list[str] = []
        for item in configured:
            col = str(item).strip().upper()
            if re.fullmatch(r"[A-Z]+", col):
                resolved.append(col)
        if not resolved:
            return tuple(fallback)
        return tuple(resolved)

    def _resolve_start_year_anchor_ref(self) -> str:
        configured = str(self.config.get("start_year_anchor_cell", "")).strip().upper()
        if configured:
            match = re.fullmatch(r"\$?([A-Z]+)\$?([0-9]+)", configured)
            if match:
                return f"${match.group(1)}${match.group(2)}"
        return "$K$2"

    def _quote_sheet_title(self, sheet_title: str) -> str:
        if re.fullmatch(r"[A-Za-z0-9_]+", sheet_title):
            return sheet_title
        escaped = sheet_title.replace("'", "''")
        return f"'{escaped}'"

    def _resolve_generic_column(self, col: str | None) -> str:
        candidate = str(col or self.config.get("data_start_col") or "F").strip().upper()
        if not re.fullmatch(r"[A-Z]+", candidate):
            raise ValueError(f"Invalid column letter: {candidate}")
        return candidate

    def _resolve_label_text(self, label_key: str) -> str:
        labels_cfg = self.config.get("labels", {})
        if isinstance(labels_cfg, Mapping):
            mapped = labels_cfg.get(label_key)
            if mapped:
                return str(mapped)
        return str(label_key)

    def generate_generic_formula(self, label_key: str, col: str | None = None) -> str:
        key = str(label_key).strip()
        if not key:
            raise ValueError("label_key is required")

        col_letter = self._resolve_generic_column(col)
        default_ref = self.mapper.get_ref(self._resolve_label_text(key), col_letter)

        formulas_cfg = self.config.get("formulas", {})
        formula_spec = formulas_cfg.get(key) if isinstance(formulas_cfg, Mapping) else None
        if not isinstance(formula_spec, Mapping):
            return f"=N({default_ref})"

        template = str(formula_spec.get("template", "")).strip()
        if not template:
            return f"=N({default_ref})"

        resolved = template
        refs = formula_spec.get("refs", [])
        if isinstance(refs, (list, tuple)):
            for ref_key in refs:
                token = str(ref_key).strip()
                if not token:
                    continue
                token_ref = self.mapper.get_ref(self._resolve_label_text(token), col_letter)
                resolved = resolved.replace("{" + token + "}", token_ref)

        for token in re.findall(r"\{([A-Za-z0-9_]+)\}", resolved):
            token_ref = self.mapper.get_ref(self._resolve_label_text(token), col_letter)
            resolved = resolved.replace("{" + token + "}", token_ref)

        compact = re.sub(r"\s+", "", resolved)
        if re.fullmatch(r"=[A-Z]+[0-9]+", compact):
            return f"=N({compact[1:]})"
        return resolved

    def _get_ref_safe(self, labels: list[str], col: str) -> str:
        for label in labels:
            try:
                return self.mapper.get_ref(label, col)
            except KeyError:
                continue
        return "IV65536"

    def _get_row_safe(self, labels: list[str]) -> int:
        for label in labels:
            try:
                return self.mapper.get_row(label)
            except KeyError:
                continue
        raise KeyError(labels[0] if labels else "unknown")

    def _block_start_col(self, col: str) -> str:
        if col in self.primary_year_columns:
            return self.primary_year_columns[0]
        if col in self.audit_year_columns:
            return self.audit_year_columns[0]
        return col

    def _prev_col_in_block(self, col: str) -> str | None:
        start_col = self._block_start_col(col)
        if col == start_col:
            return None
        block = self.primary_year_columns if start_col in self.primary_year_columns else self.audit_year_columns
        if col not in block:
            return None
        idx = block.index(col)
        if idx == 0:
            return None
        prev_col = block[idx - 1]
        if len(prev_col) != 1:
            return None
        return prev_col

    def is_primary_109_year_col(self, col: str) -> bool:
        return col in self.primary_year_columns

    def is_audit_109_year_col(self, col: str) -> bool:
        return col in self.audit_year_columns

    def get_eac_formula(self, col: str):
        labels_cfg = self.config.get("labels", {})
        ref_initial = self._get_ref_safe(
            [
                labels_cfg.get("initial_budget", "Day 1 Budget"),
                "Initial Budget (Original Contract Sum)",
                "Initial Budget",
            ],
            col,
        )
        ref_savings = self._get_ref_safe(
            [
                labels_cfg.get("budget_surplus", "Budget Surplus"),
                "Budget Surplus",
                "Cumulative Savings (Target vs Actual)",
            ],
            col,
        )
        ref_overrun = self._get_ref_safe([labels_cfg.get("owner_overrun", "Owner-unapproved Overrun")], col)
        row_eac = self._get_row_safe([labels_cfg.get("eac", "Dynamic Budget (EAC)")])
        base = f"N({ref_initial}) - N({ref_savings}) + N({ref_overrun})"
        prev_col = self._prev_col_in_block(col)
        if prev_col and self.is_primary_109_year_col(col):
            return f"={base}+{prev_col}{row_eac}"
        return f"={base}"

    def get_cumulative_direct_cost_formula(self, col: str):
        labels_cfg = self.config.get("labels", {})
        row_total_roe = self._get_row_safe(["Total ROE Cost"])
        row_accrued = self._get_row_safe(["Accrued Expenses"])
        row_current = self._get_row_safe([labels_cfg.get("cumulative_direct_cost", "Cumulative Direct Cost")])
        prev_col = self._prev_col_in_block(col)
        if prev_col and self.is_primary_109_year_col(col):
            return f"={col}{row_total_roe}+{col}{row_accrued}+{prev_col}{row_current}"
        return f"={col}{row_total_roe}+{col}{row_accrued}"

    def get_cogs_company_formula(self, col: str):
        row_total_roe = self._get_row_safe(["Total ROE Cost"])
        row_roe_wb_home = self._get_row_safe(["ROE Cost - WB Home"])
        row_roe_wpred = self._get_row_safe(["ROE Cost - WPRED"])
        row_gc_income = self._get_row_safe(["GC Income"])
        row_gc_cost = self._get_row_safe(["GC Cost", "Total GC Cost"])
        row_accrued_warranty = self._get_row_safe(["Accrued Warranty Expenses"])
        row_wb_home_cogs = self._get_row_safe(["WB Home COGS"])
        return (
            f'=IFERROR({col}{row_total_roe}-{col}{row_roe_wb_home}-{col}{row_roe_wpred}'
            f'-{col}{row_gc_income}+{col}{row_gc_cost}+{col}{row_accrued_warranty}+{col}{row_wb_home_cogs},"")'
        )

    def get_poc_formula(self, col: str):
        labels_cfg = self.config.get("labels", {})
        ref_cumulative_cost = self._get_ref_safe(
            [
                labels_cfg.get("cumulative_direct_cost", "Cumulative Direct Cost"),
                "Cumulative Total Cost (Actual)",
            ],
            col,
        )
        ref_eac = self._get_ref_safe([labels_cfg.get("eac", "Dynamic Budget (EAC)")], col)
        return f"=IFERROR(IF(N({ref_eac})=0, 0, N({ref_cumulative_cost}) / N({ref_eac})), 0)"

    def _get_override_or_rollforward_formula(
        self,
        col: str,
        check_row: int,
        override_row: int,
        computed_row: int,
        current_row: int,
        start_col: str | None = None,
    ) -> str:
        start = start_col or self._block_start_col(col)
        prev_col = self._prev_col_in_block(col)
        year_check = f"{col}$10<Year({self.start_year_anchor_ref})"
        override_check = f'OR({col}{check_row}<>"",{col}{check_row}<>0)'
        if prev_col is None:
            return (
                f'=IF({year_check},"",IF({override_check},'
                f'IFERROR({col}{override_row},""),IFERROR({col}{computed_row},"")))'
            )
        return (
            f'=IF({year_check},"",IF({override_check},'
            f'IFERROR({col}{override_row},""),'
            f'IFERROR(SUM(${start}{computed_row}:{col}{computed_row})-'
            f'SUM(${start}{current_row}:{prev_col}{current_row}),"")))'
        )

    def get_revenue_formula(self, col: str, prev_col: str | None = None):
        labels_cfg = self.config.get("labels", {})
        audited_row = self._get_row_safe([labels_cfg.get("revenue_audited", "General Conditions fee-Audited"), "General Conditions fee-Audited"])
        computed_row = self._get_row_safe([labels_cfg.get("revenue_company", "General Conditions fee-Company"), "General Conditions fee-Company"])
        current_row = self._get_row_safe([labels_cfg.get("revenue", "General Conditions fee"), "General Conditions fee"])
        return self._get_override_or_rollforward_formula(
            col,
            check_row=audited_row,
            override_row=audited_row,
            computed_row=computed_row,
            current_row=current_row,
        )

    def get_confirmed_cogs_formula(self, col: str, prev_col: str | None = None):
        labels_cfg = self.config.get("labels", {})
        audited_row = self._get_row_safe(
            [
                labels_cfg.get("cogs_audited", "Cost of Goods Sold-Audited"),
                "Cost of Goods Sold-Audited",
                "Audit Adjustment (Current Period)",
            ]
        )
        computed_row = self._get_row_safe([labels_cfg.get("cogs_company", "Cost of Goods Sold-Company"), "Cost of Goods Sold-Company"])
        current_row = self._get_row_safe([labels_cfg.get("confirmed_cogs", "Cost of Goods Sold"), "Cost of Goods Sold"])
        return self._get_override_or_rollforward_formula(
            col,
            check_row=audited_row,
            override_row=audited_row,
            computed_row=computed_row,
            current_row=current_row,
        )

    def get_gross_profit_company_formula(self, col: str):
        row_revenue_company = self._get_row_safe(["General Conditions fee-Company"])
        row_cogs_company = self._get_row_safe(["Cost of Goods Sold-Company"])
        return f'=IFERROR({col}{row_revenue_company}+{col}{row_cogs_company},"")'

    def get_gross_profit_audited_formula(self, col: str):
        row_revenue_audited = self._get_row_safe(["General Conditions fee-Audited"])
        row_cogs_audited = self._get_row_safe(["Cost of Goods Sold-Audited", "Audit Adjustment (Current Period)"])
        return f'=IFERROR({col}{row_revenue_audited}+{col}{row_cogs_audited},"")'

    def get_gross_profit_formula(self, col: str):
        row_revenue_audited = self._get_row_safe(["General Conditions fee-Audited"])
        row_gp_audited = self._get_row_safe(["Gross Profit-Audit", "Gross Profit-Audited"])
        row_gp_company = self._get_row_safe(["Gross Profit-Company"])
        row_gp = self._get_row_safe(["Gross Profit"])
        return self._get_override_or_rollforward_formula(
            col,
            check_row=row_revenue_audited,
            override_row=row_gp_audited,
            computed_row=row_gp_company,
            current_row=row_gp,
        )

    def get_roe_formula(self, col: str):
        ref_rev = self._get_ref_safe(["General Conditions fee", "general conditions fee"], col)
        ref_cogs = self._get_ref_safe(["Cost of Goods Sold", "cost of goods sold"], col)
        return f"=N({ref_rev}) - N({ref_cogs})"

    def get_retention_formula(self, col: str):
        ref_rev = self._get_ref_safe(["Revenue Recognized (Current Period)"], col)
        ref_rate = self._get_ref_safe(["Retention Percentage"], col)
        return f"=N({ref_rev}) * N({ref_rate})"

    def get_net_profit_formula(self, col: str):
        ref_roe = self._get_ref_safe(["ROE (Current Period)"], col)
        ref_tax_rate = self._get_ref_safe(["Corporate Tax Rate"], col)
        return f"=N({ref_roe}) * (1 - N({ref_tax_rate}))"

    def get_gc_cost_formula(self, col: str, year_ref: str):
        return self._build_payable_sumifs_formula("GC", year_ref)

    def get_income_total_formula(self, col: str, year_ref: str):
        return self._build_payable_sumifs_formula("Income", year_ref)

    def get_accrued_warranty_formula(self, col: str):
        return "0"

    def get_actual_warranty_formula(self, col: str, year_ref: str):
        return self._build_payable_sumifs_formula("RACC2", year_ref)

    def get_gc2_formula(self, col: str, year_ref: str):
        return self._build_payable_sumifs_formula("GC2", year_ref)

    def get_gc_income_formula(self, col: str, year_ref: str):
        return self._build_payable_sumifs_formula("GC Income", year_ref)

    def _build_payable_sumifs_formula(self, cost_state: str, year_ref: str) -> str:
        payable_sheet = self.formula_sheet_titles.get("Payable", "Payable")
        payable_ref = f"{self._quote_sheet_title(payable_sheet)}!"
        template = f'=SUMIFS({payable_ref}${{Payable.amount}}, {payable_ref}${{Payable.cost_code}}, "__COST_STATE__", {payable_ref}${{Payable.year}}, __YEAR_REF__)'
        formula_template = template.replace("__COST_STATE__", cost_state).replace("__YEAR_REF__", year_ref)
        return self.formula_resolver.resolve_formula(
            formula_template,
            self.formula_mappings,
        )
