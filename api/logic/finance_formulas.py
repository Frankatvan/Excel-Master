from finance_mapping import ExcelSemanticMapper


class FinanceFormulaGenerator:
    def __init__(self, mapper: ExcelSemanticMapper, config: dict | None = None):
        self.mapper = mapper
        self.config = dict(config or getattr(mapper, "config", {}) or {})

    def _get_ref_safe(self, labels: list[str], col: str) -> str:
        for label in labels:
            try:
                return self.mapper.get_ref(label, col)
            except KeyError:
                continue
        return "IV65536" 

    def get_eac_formula(self, col: str):
        labels_cfg = self.config.get("labels", {})
        ref_initial = self._get_ref_safe([labels_cfg.get("initial_budget", "Day 1 Budget")], col)
        ref_savings = self._get_ref_safe([labels_cfg.get("budget_surplus", "Cumulative Savings (Target vs Actual)")], col)
        ref_overrun = self._get_ref_safe([labels_cfg.get("owner_overrun", "Owner-unapproved Overrun")], col)
        return f"=N({ref_initial}) - N({ref_savings}) + N({ref_overrun})"

    def get_poc_formula(self, col: str):
        labels_cfg = self.config.get("labels", {})
        ref_cogs = self._get_ref_safe([labels_cfg.get("confirmed_cogs", "Cost of Goods Sold")], col)
        ref_eac = self._get_ref_safe([labels_cfg.get("eac", "Dynamic Budget (EAC)")], col)
        return f"=IFERROR(IF(N({ref_eac})=0, 0, N({ref_cogs}) / N({ref_eac})), 0)"

    def _get_audited_or_cumulative_diff_formula(self, col: str, prev_col: str | None, audited_row: int, cumulative_row: int, current_row: int, start_audit_col: str = "M") -> str:
        """
        100% 镜像复刻用户手写的分阶段公式逻辑 (V-Final)。
        """
        year_check = f'{col}$10<Year($K$2)'
        audit_check = f'OR({col}{audited_row}<>"",{col}{audited_row}<>0)'
        audit_val = f'IFERROR({col}{audited_row},"")'

        # F 列 (起始年) - 完全匹配 F19/F30 公式
        if col == "F":
            return f'=IF({year_check},"",IFERROR(IF({audit_check},{col}{audited_row},F{cumulative_row}),""))'
        
        # G 列 (第二年) - 完全匹配 G19/G30 公式
        elif col == "G":
            cumulative_part = f'SUM($F{cumulative_row}:G{cumulative_row})'
            prev_sum_part = f'SUM($F{current_row}:F{current_row})'
            return f'=IF({year_check},"",IF({audit_check},{audit_val},IFERROR({cumulative_part}-{prev_sum_part},"")))'
            
        # M-R 列 (滚动审计区) - 完全匹配 R19/R30 公式
        else:
            prev_audit_sum_col = chr(ord(col) - 1)
            # 确定滚动求和的起始列，对于 M-Q，是 M；对于 R，是 M
            # 这里简化处理，统一使用 start_audit_col，因为逻辑上滚动求和的起点是固定的
            cumulative_part = f'SUM(${start_audit_col}{cumulative_row}:{col}{cumulative_row})'
            prev_sum_part = f'SUM(${start_audit_col}{current_row}:{prev_audit_sum_col}{current_row})'
            return f'=IF({year_check},"",IF({audit_check},{audit_val},IFERROR({cumulative_part}-{prev_sum_part},"")))'

    def get_revenue_formula(self, col: str, prev_col: str | None = None):
        labels_cfg = self.config.get("labels", {})
        audited_row = self.mapper.get_row(labels_cfg.get("revenue_audited", "general conditions fee-audited"))
        cumulative_row = self.mapper.get_row(labels_cfg.get("revenue_company", "general conditions fee-company")) # 使用更可靠的标签
        current_row = self.mapper.get_row(labels_cfg.get("revenue", "general conditions fee"))
        return self._get_audited_or_cumulative_diff_formula(col, prev_col, audited_row, cumulative_row, current_row)

    def get_confirmed_cogs_formula(self, col: str, prev_col: str | None = None):
        labels_cfg = self.config.get("labels", {})
        audited_row = self.mapper.get_row(labels_cfg.get("cogs_audited", "cost of goods sold-audited"))
        cumulative_row = self.mapper.get_row(labels_cfg.get("cogs_company", "cost of goods sold-company")) # 使用更可靠的标签
        current_row = self.mapper.get_row(labels_cfg.get("confirmed_cogs", "Cost of Goods Sold"))
        return self._get_audited_or_cumulative_diff_formula(col, prev_col, audited_row, cumulative_row, current_row)
    
        return self._get_audited_or_cumulative_diff_formula(col, prev_col, audited_row, cumulative_row, current_row)
    
    def get_roe_formula(self, col: str):
        ref_rev = self._get_ref_safe(["general conditions fee"], col)
        ref_cogs = self._get_ref_safe(["Cost of Goods Sold"], col)
        return f"=N({ref_rev}) - N({ref_cogs})"

    def get_retention_formula(self, col: str):
        ref_rev = self._get_ref_safe(["Revenue Recognized (Current Period)"], col)
        ref_rate = self._get_ref_safe(["Retention Percentage"], col)
        return f"=N({ref_rev}) * N({ref_rate})"

    def get_net_profit_formula(self, col: str):
        ref_roe = self._get_ref_safe(["ROE (Current Period)"], col)
        ref_tax_rate = self._get_ref_safe(["Corporate Tax Rate"], col)
        return f"=N({ref_roe}) * (1 - N({ref_tax_rate}))"

    # ... (其他辅助公式保持不变) ...
    def get_gc_cost_formula(self, col: str, year_ref: str):
        return f'=SUMIFS(Payable!$U:$U, Payable!$A:$A, "GC", Payable!$J:$J, {year_ref})'
    def get_accrued_warranty_formula(self, col: str):
        return "0"
    def get_actual_warranty_formula(self, col: str, year_ref: str):
        return f'=-SUMIFS(Payable!$U:$U, Payable!$A:$A, "RACC2", Payable!$J:$J, {year_ref})'
    def get_gc2_formula(self, col: str, year_ref: str):
        return f'=SUMIFS(Payable!$U:$U, Payable!$A:$A, "GC2", Payable!$J:$J, {year_ref})'
    def get_gc_income_formula(self, col: str, year_ref: str):
        return f'=SUMIFS(Payable!$U:$U, Payable!$A:$A, "GC Income", Payable!$J:$J, {year_ref})'
