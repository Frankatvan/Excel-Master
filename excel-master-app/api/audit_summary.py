import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import sys
from pathlib import Path
import pandas as pd

# Add logic directory to path
sys.path.append(str(Path(__file__).parent / "logic"))

try:
    from finance_utils import get_sheets_service, _values_to_dataframe
except ImportError:
    pass

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        spreadsheet_id = query.get("spreadsheet_id", [None])[0]

        if not spreadsheet_id or spreadsheet_id == "MOCK_ID":
            # For now, if MOCK_ID or missing, use a real test ID or fallback to mock
            # Replace with a real Spreadsheet ID you use for testing
            spreadsheet_id = "1N6iQ3-7H-I_p0p_Pq_G9U8U5k5l-Mv1mKz_N7D_8_8" # Example ID

        try:
            service = get_sheets_service()
            
            # 1. Fetch 109 Metadata (Project Name & Highlights)
            # 109!C2 is project name, 109!B2:K5 are indicators
            resp_109 = service.spreadsheets().values().batchGet(
                spreadsheetId=spreadsheet_id,
                ranges=["'109'!C2", "'109'!B2:K5"],
                valueRenderOption="FORMATTED_VALUE"
            ).execute()
            
            val_ranges = resp_109.get("valueRanges", [])
            project_name = val_ranges[0].get("values", [["Unknown Project"]])[0][0]
            highlights_matrix = val_ranges[1].get("values", [])
            
            # Map B2:K5 to highlights (Simplified for now)
            highlights = []
            if len(highlights_matrix) >= 2:
                headers = highlights_matrix[0]
                values = highlights_matrix[1]
                # Assuming typical layout: B=Revenue, C=Actual Cost, D=GM%, J=POC%
                # We'll map them based on headers or fixed positions for the MVP
                highlight_map = {
                    "Revenue": values[0] if len(values) > 0 else "-",
                    "Actual Cost": values[1] if len(values) > 1 else "-",
                    "Gross Margin": values[2] if len(values) > 2 else "-",
                    "POC (%)": values[8] if len(values) > 8 else "-"
                }
                highlights = [
                    {"label": "Revenue", "value": highlight_map["Revenue"], "color": "blue"},
                    {"label": "Actual Cost", "value": highlight_map["Actual Cost"], "color": "indigo"},
                    {"label": "Gross Margin", "value": highlight_map["Gross Margin"], "color": "emerald"},
                    {"label": "POC (%)", "value": highlight_map["POC (%)"], "color": "purple"}
                ]

            # 2. Fetch Unit Master (B vs D)
            resp_um = service.spreadsheets().values().get(
                spreadsheetId=spreadsheet_id,
                range="'Unit Master'!A1:D100",
                valueRenderOption="UNFORMATTED_VALUE"
            ).execute()
            um_values = resp_um.get("values", [])
            um_df = _values_to_dataframe(um_values)
            
            variances = []
            if not um_df.empty and len(um_df.columns) >= 4:
                # Column B (index 1) vs Column D (index 3)
                for _, row in um_df.iterrows():
                    item = str(row.iloc[0]) if len(row) > 0 else "N/A"
                    aiwb = str(row.iloc[1]) if len(row) > 1 else "N/A"
                    auditor = str(row.iloc[3]) if len(row) > 3 else "N/A"
                    if aiwb != auditor and aiwb != "nan" and auditor != "nan":
                        variances.append({
                            "item": item,
                            "aiwb": aiwb,
                            "auditor": auditor,
                            "status": "Mismatch"
                        })
                    elif aiwb == auditor and aiwb != "nan":
                        variances.append({
                            "item": item,
                            "aiwb": aiwb,
                            "auditor": auditor,
                            "status": "Match"
                        })

            # 3. Fetch Scoping (Filtered M/N)
            resp_scoping = service.spreadsheets().values().get(
                spreadsheetId=spreadsheet_id,
                range="'Scoping'!A1:N200",
                valueRenderOption="UNFORMATTED_VALUE"
            ).execute()
            sc_values = resp_scoping.get("values", [])
            sc_df = _values_to_dataframe(sc_values)
            
            scoping_logic = []
            if not sc_df.empty:
                # A=Group, E=Cat1, G=Cat2, M=M_val, N=N_val (approximate based on standard layout)
                for _, row in sc_df.iterrows():
                    m_val = row.iloc[12] if len(row) > 12 else None
                    n_val = row.iloc[13] if len(row) > 13 else None
                    if pd.notna(m_val) or pd.notna(n_val):
                        scoping_logic.append({
                            "group": str(row.iloc[0]),
                            "cat1": str(row.iloc[4]) if len(row) > 4 else "-",
                            "cat2": str(row.iloc[6]) if len(row) > 6 else "-",
                            "m_val": m_val if pd.notna(m_val) else None,
                            "n_val": n_val if pd.notna(n_val) else None
                        })

            # 4. Three-Table External Recon (Complex Logic)
            # Fetch essential columns for reconciliation
            recon_ranges = [
                "'Payable'!AA:AQ",      # Amount(AA), Cost State(AQ)
                "'Final Detail'!Y:AB",  # Cost State(Y), Amount(AB)
                "'Draw request report'!A:Z" # Mocking for now, adjust based on real layout
            ]
            
            resp_recon = service.spreadsheets().values().batchGet(
                spreadsheetId=spreadsheet_id,
                ranges=recon_ranges,
                valueRenderOption="UNFORMATTED_VALUE"
            ).execute()
            
            recon_data = resp_recon.get("valueRanges", [])
            
            # --- Process Payable ---
            payable_matrix = recon_data[0].get("values", [])
            payable_df = _values_to_dataframe(payable_matrix)
            p_summary = {}
            if not payable_df.empty:
                # Column index: AA is 0, AQ is 16 (if relative to AA:AQ)
                # But _values_to_dataframe assumes first row is header
                # Let's map headers: Amount, Cost State
                try:
                    # Filter for specific Cost States
                    valid_states = ["Direct", "ROE", "Income", "Consulting"]
                    # Finding columns (AA=27th, AQ=43rd)
                    # Since range is AA:AQ, index 0 is AA, index 16 is AQ
                    for _, row in payable_df.iterrows():
                        amt = _to_float(row.iloc[0])
                        state = str(row.iloc[16]) if len(row) > 16 else "Unknown"
                        if state in valid_states:
                            p_summary[state] = p_summary.get(state, 0) + amt
                except Exception: pass

            # --- Process Final Detail ---
            final_matrix = recon_data[1].get("values", [])
            final_df = _values_to_dataframe(final_matrix)
            f_summary = {}
            if not final_df.empty:
                # Range Y:AB -> Y=0, AB=3
                try:
                    valid_states = ["Direct", "ROE", "Income", "Consulting"]
                    for _, row in final_df.iterrows():
                        state = str(row.iloc[0])
                        amt = _to_float(row.iloc[3]) if len(row) > 3 else 0
                        if state in valid_states:
                            f_summary[state] = f_summary.get(state, 0) + amt
                except Exception: pass

            # --- Construct Reconciliation Table ---
            recon_table = []
            for state in ["Direct", "ROE", "Income", "Consulting"]:
                p_amt = p_summary.get(state, 0)
                f_amt = f_summary.get(state, 0)
                diff = p_amt - f_amt
                recon_table.append({
                    "state": state,
                    "payable": round(p_amt, 2),
                    "final": round(f_amt, 2),
                    "diff": round(diff, 2)
                })

            # --- Detailed Row-Level Comparison (New for Drill-down) ---
            detailed_discrepancies = {}
            # We'll create a simple map of UID -> Amount for Final Detail
            final_lookup = {}
            if not final_df.empty:
                try:
                    # Assuming Column Z is UID (index 1 in Y:AB)
                    for _, row in final_df.iterrows():
                        uid = str(row.iloc[1])
                        amt = _to_float(row.iloc[3])
                        if uid and uid != "nan":
                            final_lookup[uid] = amt
                except Exception: pass

            for state in ["Direct", "ROE", "Income", "Consulting"]:
                orphans = []
                state_rows = payable_df[payable_df.iloc[:, 16] == state] if not payable_df.empty else pd.DataFrame()
                for _, row in state_rows.iterrows():
                    # Assuming Payable Column AB is UID (index 1 in AA:AQ)
                    uid = str(row.iloc[1])
                    amt = _to_float(row.iloc[0])
                    if uid not in final_lookup or abs(final_lookup[uid] - amt) > 0.01:
                        orphans.append({
                            "uid": uid,
                            "vendor": str(row.iloc[3]) if len(row) > 3 else "Unknown", # AA:AQ index 3 is approx Vendor
                            "desc": str(row.iloc[4]) if len(row) > 4 else "N/A",
                            "amount": amt,
                            "status": "Missing in Final" if uid not in final_lookup else "Amount Mismatch"
                        })
                detailed_discrepancies[state] = orphans[:10] # Limit to top 10 for MVP

            # Construct Final Data
            data = {
                "project_name": project_name,
                "highlights": highlights,
                "audit_tabs": {
                    "external_recon": {
                        "summary": f"Reconciliation complete. Found {sum(len(v) for v in detailed_discrepancies.values())} potential discrepancies across {len(recon_table)} states.",
                        "discrepancies": recon_table,
                        "details": detailed_discrepancies
                    },
                    "mapping_consistency": {"variances": variances[:50]},
                    "scoping_logic": scoping_logic
                }
            }

            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(data, default=str).encode("utf-8"))

        except Exception as e:
            self.send_response(500)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
