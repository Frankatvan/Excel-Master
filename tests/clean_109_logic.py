def _build_109_formula_plan_from_grid(
    rows: Sequence[Sequence[Any]],
    config: Mapping[str, Any] | None = None,
) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    if not rows:
        raise RuntimeError("109工作表为空，无法生成公式清单。")

    cfg = dict(config or _load_109_formula_dictionary())
    label_rows = _find_rows_by_item_label(rows, item_col_1=3)
    year_row = _find_year_header_row_109(rows)

    row_contract_amount = _first_present_row(label_rows, "contract amount")
    surplus_row_candidates = label_rows.get("budget surplus", [])
    row_surplus_tp = surplus_row_candidates[0] if len(surplus_row_candidates) > 0 else None
    row_surplus_eac = surplus_row_candidates[1] if len(surplus_row_candidates) > 1 else None
    
    row_contract_change = row_surplus_tp
    if row_contract_amount is None and row_contract_change is not None and row_contract_change > 1:
        row_contract_amount = row_contract_change - 1
        
    row_contract_price = _first_present_row(label_rows, "contract change amount", "contract price")
    if row_contract_price is None:
        row_contract_price = _choose_contract_price_row(rows, label_rows)
    
    row_contract_price_day1 = _find_contract_price_day1_row(rows)
    row_poc = (label_rows.get("percentage of completion") or [None])[0]
    row_cr = (label_rows.get("completion rate for the period") or [None])[0]
    row_initial_budget = (label_rows.get("day 1 budget") or [None])[0]
    row_overrun = (label_rows.get("owner-unapproved overrun") or [None])[0]
    row_budget = _first_present_row(label_rows, "dynamic budget (eac)", "scoping budget cost")
    row_cogs_aud = (label_rows.get("cost of goods sold-audited") or [None])[0]
    row_cogs = (label_rows.get("cost of goods sold") or [None])[0]
    row_revenue_company = (label_rows.get("general conditions fee-company") or [None])[0]
    row_revenue_aud = (label_rows.get("general conditions fee-audited") or [None])[0]
    row_revenue = (label_rows.get("general conditions fee") or [None])[0]
    row_gp_company = (label_rows.get("gross profit-company") or [None])[0]
    row_gp = (label_rows.get("gross profit") or [None])[0]
    row_ar_incurred = (label_rows.get("accounts receivable-incurred") or [None])[0]
    row_ar_aud = (label_rows.get("accounts receivable-audited") or [None])[0]
    row_ar_company = (label_rows.get("accounts receivable-company") or [None])[0]
    row_ar = (label_rows.get("accounts receivable") or [None])[0]
    row_wbh_income = (label_rows.get("wb home income") or [None])[0]
    row_wbh_cogs = (label_rows.get("wb home cogs") or [None])[0]
    row_inv_income = (label_rows.get("wb home inventory income") or [None])[0]
    row_inv = (label_rows.get("wb home inventory") or [None])[0]
    row_inv_income_rev = (label_rows.get("wb home inventory income-reverse") or [None])[0]
    row_inv_rev = (label_rows.get("wb home inventory-reverse") or [None])[0]
    row_wbh_total = (label_rows.get("wb. home material margin total") or [None])[0]
    row_main_mm, row_inv_mm = _find_material_margin_rows_109(label_rows, row_wbh_cogs, row_inv)

    required_rows = {
        "年度表头(2021-2026)": year_row,
        "Contract Amount": row_contract_amount,
        "Contract price": row_contract_price,
        "Contract price (Day1)": row_contract_price_day1,
        "Contract Change Order": row_surplus_tp,
        "Percentage of Completion": row_poc,
        "Completion Rate for the Period": row_cr,
        "Initial Budget": row_initial_budget,
        "Owner-unapproved Overrun": row_overrun,
        "Budget Cost(分母EAC)": row_budget,
        "General Conditions fee-Company": row_revenue_company,
        "Gross Profit-Company": row_gp_company,
        "Accounts Receivable-Incurred": row_ar_incurred,
        "Accounts Receivable-Audited": row_ar_aud,
        "Accounts Receivable-Company": row_ar_company,
        "Accounts Receivable": row_ar,
        "WB Home Income": row_wbh_income,
        "WB Home COGS": row_wbh_cogs,
        "WB Home Inventory Income": row_inv_income,
        "WB Home Inventory": row_inv,
        "WB Home Inventory Income-Reverse": row_inv_income_rev,
        "WB Home Inventory-Reverse": row_inv_rev,
        "WB. Home Material Margin Total": row_wbh_total,
        "Material Margin(main)": row_main_mm,
        "Material Margin(inventory)": row_inv_mm,
    }
    missing = [name for name, row_i in required_rows.items() if row_i is None]
    if missing:
        raise RuntimeError("109关键行定位失败: " + "、".join(missing))

    plan: List[Dict[str, str]] = []

    def add_cell_formula(cell: str, formula: str, logic: str) -> None:
        plan.append({
            "sheet": SHEET_109_NAME,
            "cell": cell,
            "range": f"{_quote_sheet_name(SHEET_109_NAME)}!{cell}",
            "formula": formula,
            "logic": logic,
        })

    def add_formula(col_i: int, row_i: int, formula: str, logic: str) -> None:
        col = _column_number_to_a1(col_i)
        plan.append({
            "sheet": SHEET_109_NAME,
            "cell": f"{col}{row_i}",
            "range": f"{_quote_sheet_name(SHEET_109_NAME)}!{col}{row_i}",
            "formula": formula,
            "logic": logic,
        })

    start_year_expr = "YEAR($K$2)"
    add_cell_formula("K2", _build_109_date_array_formula("MIN"), "Start date=外部来源主日期最早值")
    add_cell_formula("K3", _build_109_date_array_formula("MAX"), "End date=外部来源主日期最晚值")
    add_cell_formula("C5", '=IFERROR(COUNTA(FILTER(\'Unit Budget\'!$B$3:$B,REGEXMATCH(\'Unit Budget\'!$B$3:$B,"[0-9]"))),0)', "Units汇总")
    add_cell_formula("C3", '=IFERROR($E$3-$E$5,"")', "Budget(Day1)")
    add_cell_formula("E3", "=SUMIFS('Unit Budget'!$T:$T,'Unit Budget'!$O:$O,1)", "Contract price (Day1)")
    add_cell_formula("E4", '=IFERROR($E$3-$E$5,"")', "Budget cost Day1")
    add_cell_formula("E5", "=SUMIFS('Unit Budget'!$T:$T,'Unit Budget'!$P:$P,2)", "GC fee Day1")
    add_cell_formula("E12", '=IFERROR(ROUND(MAX(F12:K12),8),"")', "POC Total")
    add_cell_formula("E13", '=IFERROR(ROUND(SUM(F13:K13),8),"")', "Completion Rate Total")
    add_cell_formula("A12", "累计完工百分比", "Label")
    add_cell_formula("A13", "当期完工比例", "Label")
    
    add_formula(1, row_contract_amount, "合同金额", "A列") # type: ignore[arg-type]
    add_formula(1, row_surplus_tp, "预算结余", "A列") # type: ignore[arg-type]
    add_formula(1, row_contract_price, "合同变动金额", "A列") # type: ignore[arg-type]
    add_formula(1, row_revenue_company, "当期计算收入", "A列") # type: ignore[arg-type]
    
    add_formula(5, row_contract_amount, f'=IFERROR(SUM(F{row_contract_amount}:K{row_contract_amount}),"")', "Total") # type: ignore[arg-type]
    add_formula(5, row_surplus_tp, f'=IFERROR(SUM(F{row_surplus_tp}:K{row_surplus_tp}),"")', "Total") # type: ignore[arg-type]

    for offset, col_i in enumerate(range(6, 12)):  # F:K
        col = _column_number_to_a1(col_i)
        prev_col = _column_number_to_a1(col_i - 1) if offset > 0 else ""
        year_ref = f"{col}${year_row}"

        # Row 14: Contract Amount
        add_formula(col_i, row_contract_amount, f'=IF({col}$10={start_year_expr},-$E$3,0)', "Contract Amount") # type: ignore[arg-type]
        
        # Row 15 & 24: Budget Surplus
        add_formula(col_i, row_surplus_tp, f"=SUMIFS('Unit Master'!$K:$K,'Unit Master'!$I:$I,{year_ref})", "Surplus TP") # type: ignore[arg-type]
        if row_surplus_eac:
            add_formula(col_i, row_surplus_eac, f"=SUMIFS('Unit Master'!$K:$K,'Unit Master'!$I:$I,{year_ref})", "Surplus EAC") # type: ignore[arg-type]
            
        # Row 16: Contract Change Amount (Cumulative)
        if offset == 0:
            contract_price_formula = f'=IF({col}$10<{start_year_expr},"",IF({col}$10={start_year_expr},{col}{row_contract_amount}+{col}{row_surplus_tp},""))'
        else:
            contract_price_formula = f'=IF({col}$10<{start_year_expr},"",IF({col}$10={start_year_expr},{col}{row_contract_amount}+{col}{row_surplus_tp},IFERROR({prev_col}{row_contract_price}+{col}{row_surplus_tp},"")))'
        add_formula(col_i, row_contract_price, contract_price_formula, "Cumulative TP") # type: ignore[arg-type]

        # Row 23: Initial Budget (Numeric 0 fallback)
        add_formula(col_i, row_initial_budget, f"=IF({col}$10={start_year_expr},$C$3,0)", "Initial Budget") # type: ignore[arg-type]
        
        # Row 26: Dynamic Budget (EAC) - I26 = I23 - I24 + I25 + SUM(F26:H26)
        sur_ref = row_surplus_eac if row_surplus_eac else row_surplus_tp
        if offset == 0:
            budget_formula = f"={col}{row_initial_budget}-{col}{sur_ref}+{col}{row_overrun}"
        else:
            budget_formula = f"={col}{row_initial_budget}-{col}{sur_ref}+{col}{row_overrun}+SUM($F${row_budget}:{prev_col}{row_budget})"
        add_formula(col_i, row_budget, budget_formula, "Cumulative EAC") # type: ignore[arg-type]

        # Row 27: COGS (Payable + Audit)
        add_formula(col_i, row_cogs, f"=IFERROR(SUMIFS(Payable!$AB:$AB,Payable!$E:$E,1,Payable!$J:$J,{year_ref})-SUMIFS(Payable!$AB:$AB,Payable!$E:$E,1,Payable!$O:$O,\"WB Home LLC\",Payable!$J:$J,{year_ref})+IF({col}{row_cogs_aud}=\"\",0,{col}{row_cogs_aud}),\"\")", "COGS") # type: ignore[arg-type]

        # Row 12: POC = SUM(COGS) / Row 26
        add_formula(col_i, row_poc, f"=IFERROR(ROUND(SUM($F${row_cogs}:{col}{row_cogs})/{col}{row_budget},8),\"\")", "POC") # type: ignore[arg-type]

        # Row 13: CR
        if offset == 0:
            cr_formula = f"=IFERROR(ROUND({col}{row_poc},8),\"\")"
        else:
            cr_formula = f"=IFERROR(ROUND({col}{row_poc}-{prev_col}{row_poc},8),\"\")"
        add_formula(col_i, row_cr, cr_formula, "CR") # type: ignore[arg-type]

        # Row 17: Revenue Company
        if offset == 0:
            rev_formula = f'=IF({col}$10<{start_year_expr},"",IFERROR({col}{row_contract_price}*{col}{row_poc},""))'
        else:
            rev_formula = f'=IF({col}$10<{start_year_expr},"",IF({col}$10={start_year_expr},IFERROR({col}{row_contract_price}*{col}{row_poc},""),IFERROR({col}{row_contract_price}*{col}{row_poc}-SUM($F${row_revenue_company}:{prev_col}{row_revenue_company}),"")))'
        add_formula(col_i, row_revenue_company, rev_formula, "Revenue Calculation") # type: ignore[arg-type]

        # GP and AR
        add_formula(col_i, row_gp_company, f"=IFERROR({col}{row_revenue_company}-{col}{row_cogs},\"\")", "GP Company") # type: ignore[arg-type]
        add_formula(col_i, row_ar_incurred, f"=IFERROR(-{col}{row_revenue_company},\"\")", "AR Incurred") # type: ignore[arg-type]

        # WB Home and Display rows follow same patterns...
        add_formula(col_i, row_wbh_income, f"=IFERROR(SUMIFS(Payable!$AB:$AB,Payable!$E:$E,1,Payable!$C:$C,\"WBH\",Payable!$J:$J,{year_ref}),\"\")", "WBH Income") # type: ignore[arg-type]
        add_formula(col_i, row_main_mm, f"=IFERROR({col}{row_wbh_income}-{col}{row_wbh_cogs},\"\")", "Main MM") # type: ignore[arg-type]
        add_formula(col_i, row_inv_mm, f"=IFERROR({col}{row_inv_income}-{col}{row_inv},\"\")", "Inv MM") # type: ignore[arg-type]

        if offset == 0:
            inv_income_rev_formula = "=\"\""
            inv_rev_formula = "=\"\""
            ar_formula = f"=IFERROR({col}{row_ar_company},\"\")"
        else:
            inv_income_rev_formula = f"=IF({prev_col}{row_inv_income}=\"\",\"\",-{prev_col}{row_inv_income})"
            inv_rev_formula = f"=IF({prev_col}{row_inv}=\"\",\"\",-{prev_col}{row_inv})"
            ar_formula = f"=IFERROR({prev_col}{row_ar}+{col}{row_ar_company},\"\")"

        add_formula(col_i, row_inv_income_rev, inv_income_rev_formula, "Inv Income Rev") # type: ignore[arg-type]
        add_formula(col_i, row_inv_rev, inv_rev_formula, "Inv Rev") # type: ignore[arg-type]
        add_formula(col_i, row_wbh_total, f"=IFERROR({col}{row_main_mm}+{col}{row_inv_mm}+IF({col}{row_inv_income_rev}=\"\",0,{col}{row_inv_income_rev})+IF({col}{row_inv_rev}=\"\",0,{col}{row_inv_rev}),\"\")", "WBH Total") # type: ignore[arg-type]
        add_formula(col_i, row_ar_company, f"=IF({col}{row_ar_aud}=\"\",{col}{row_ar_incurred},{col}{row_ar_aud})", "AR Company") # type: ignore[arg-type]
        add_formula(col_i, row_ar, ar_formula, "AR Final") # type: ignore[arg-type]

        # Display Sync
        if row_revenue and row_revenue_aud:
            if offset == 0:
                rev_display = f'=IF({col}{row_revenue_aud}<>"",{col}{row_revenue_aud},IF({col}$10<{start_year_expr},"",IFERROR(SUM($F${row_revenue_company}:{col}{row_revenue_company}),"")))'
            else:
                rev_display = f'=IF({col}{row_revenue_aud}<>"",{col}{row_revenue_aud},IF({col}$10<{start_year_expr},"",IFERROR(SUM($F${row_revenue_company}:{col}{row_revenue_company})-SUM($F${row_revenue}:{prev_col}{row_revenue}),"")))'
            add_formula(col_i, row_revenue, rev_display, "Revenue Display") # type: ignore[arg-type]
        
        if row_gp and row_revenue and row_cogs:
            add_formula(col_i, row_gp, f"=IFERROR({col}{row_revenue}-{col}{row_cogs},\"\")", "GP Display") # type: ignore[arg-type]

    # Summary cells
    add_cell_formula("G3", f"=IFERROR($E${row_revenue},\"\")", "Summary Revenue")
    add_cell_formula("G5", f"=IFERROR($E${row_gp},\"\")", "Summary GP")
    add_cell_formula("I5", f"=IFERROR($E${row_main_mm},\"\")", "Summary WB Home")

    return plan, {"key_rows": {k: int(v) for k, v in required_rows.items() if v is not None}}
