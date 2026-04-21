def _build_unit_master_rows_v2(ub_rows: Sequence[Sequence[Any]], fd_rows: Sequence[Sequence[Any]]) -> List[List[Any]]:
    if len(ub_rows) < 3:
        return []

    # 1. Identify Units in Unit Budget (Starts at Col 21, Index 20)
    # Logic: Include numeric unit codes AND 'Common' area columns
    unit_header_row = ub_rows[0]
    unit_col_start = 20 
    unit_codes = []
    for col_idx in range(unit_col_start, len(unit_header_row)):
        code = _safe_string(unit_header_row[col_idx])
        code_clean = code.strip().lower()
        if not code or code_clean in ["total", "sum"]:
            continue
        # Include if it contains digits (Unit) or contains "common" (Common Area)
        if any(c.isdigit() for c in code) or "common" in code_clean:
            unit_codes.append((col_idx, code))

    if not unit_codes:
        return []

    # 2. Extract Latest Final Dates from Final Detail (U=Unit index 20, O=Date index 14)
    unit_dates: Dict[str, date] = {}
    if len(fd_rows) > 1:
        for row in fd_rows[1:]:
            if len(row) < 21: continue
            u_code = _safe_string(row[20])
            dt_raw = row[14]
            dt = _normalize_date_value(dt_raw)
            if u_code and dt:
                # Standardize u_code to match Unit Master index if needed
                if u_code not in unit_dates or dt.date() > unit_dates[u_code]:
                    unit_dates[u_code] = dt.date()

    # 3. Aggregate Budgets from Unit Budget
    # B: Budget (O=1), C: GC (P=2), D: WIP (Q=3)
    agg: Dict[str, Dict[str, float]] = {code: {"b": 0.0, "c": 0.0, "d": 0.0} for _, code in unit_codes}
    for row in ub_rows[2:]:
        if len(row) < 17: continue
        scoping_1 = _safe_string(row[14]) # O
        scoping_2 = _safe_string(row[15]) # P
        scoping_3 = _safe_string(row[16]) # Q
        
        for col_idx, code in unit_codes:
            if col_idx < len(row):
                val = _to_float(row[col_idx]) or 0.0
                if scoping_1 == "1": agg[code]["b"] += val
                if scoping_2 == "2": agg[code]["c"] += val
                if scoping_3 == "3": agg[code]["d"] += val

    # 4. Build Output
    header = ["Unit Code", "预算金额", "GC预算金额", "WIP逻辑预算", "incurred Amount", "结算金额", "Final Date", "C/O date", "实际结算日期", "实际结算年份", "TBD Acceptance Date", "预算差异", "Group"]
    data_rows: List[List[Any]] = []
    
    for _, code in unit_codes:
        curr_row = len(data_rows) + 3
        row_out = ["" for _ in range(13)]
        row_out[0] = code # A
        row_out[1] = agg[code]["b"] # B
        row_out[2] = agg[code]["c"] # C
        row_out[3] = agg[code]["d"] # D
        
        # E: Incurred Amount (Excl Income)
        row_out[4] = f"=SUMIFS(Payable!$U:$U, Payable!$AL:$AL, $A{curr_row}, Payable!$A:$A, \"ROE\") + SUMIFS(Payable!$U:$U, Payable!$AL:$AL, $A{curr_row}, Payable!$A:$A, \"RACC\")"
        
        # F: Settlement Amount (Excl Income)
        row_out[5] = f"=SUMIFS('Final Detail'!$P:$P, 'Final Detail'!$U:$U, $A{curr_row}, 'Final Detail'!$A:$A, \"ROE\") + SUMIFS('Final Detail'!$P:$P, 'Final Detail'!$U:$U, $A{curr_row}, 'Final Detail'!$A:$A, \"ACC\")"
        
        # G: Final Date (Latest)
        row_out[6] = unit_dates.get(code, "").strftime("%Y-%m-%d") if isinstance(unit_dates.get(code), date) else ""
        
        # L: Budget Variance = B - C - F
        row_out[11] = f"=$B{curr_row}-$C{curr_row}-$F{curr_row}"
        
        data_rows.append(row_out)

    # 5. Total Row
    last_row = len(data_rows) + 2
    total_row = [""] * len(header)
    total_row[0] = "Total"
    for col_idx_1 in [2, 3, 4, 5, 6, 12]:
        col_a1 = _column_number_to_a1(col_idx_1)
        total_row[col_idx_1 - 1] = f"=SUM({col_a1}3:{col_a1}{last_row})"

    return [total_row, header] + data_rows
