from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, MutableMapping, Sequence, Tuple

import pandas as pd
import streamlit as st
from googleapiclient.errors import HttpError

from finance_utils import (
    _cloud_view,
    _get_secret,
    _parse_options,
    _safe_string,
    _quote_sheet_name,
    _values_to_dataframe,
    _trim_display_and_formula_matrices,
    _build_formula_lookup_by_headers,
    _df_signature,
    _sheet_delta_stats,
    _is_internal_col,
    get_sheets_service,
)
from finance_engine import (
    UID_STATUS_COL,
    SHADOW_CONFLICT_COL,
    SHADOW_PY_PROFIT_COL,
    SHADOW_PY_TAX_COL,
    UID_PENDING_VALUE,
    DEFAULT_UID_COLUMN,
    DEFAULT_AMOUNT_COLUMN,
    DEFAULT_ENTITY_COLUMN,
    DEFAULT_GUARD_SHEET,
    DEFAULT_EXPECTED_FIRST_CELL,
    DAILY_API_QUOTA_ESTIMATE,
    load_local_cloud_snapshot,
    save_local_cloud_snapshot,
    clear_local_cloud_snapshot,
    load_local_draft,
    save_local_draft,
    clear_local_drafts,
    _prepare_sheet_df,
    _merge_draft_with_cloud,
    _find_dirty_sheets,
    run_apps_shadow_pipeline,
    generate_109_formula_plan,
    execute_109_formula_plan,
    build_commit_bundle,
    execute_commit,
    ensure_uid_anchor,
    apply_shadow_logic,
)

@st.cache_data(ttl=600, show_spinner=False)
def load_data(spreadsheet_id: str):
    service = get_sheets_service()
    meta_resp = (
        service.spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="properties(title),sheets(properties(title,index))",
        )
        .execute()
    )

    sheet_map: Dict[str, pd.DataFrame] = {}
    formula_lookup_map: Dict[str, Dict[Tuple[int, str], str]] = {}
    sheet_order: List[str] = []
    total_rows = 0

    ordered_sheets = sorted(
        meta_resp.get("sheets", []), key=lambda s: s.get("properties", {}).get("index", 0)
    )
    for sheet in ordered_sheets:
        title = sheet.get("properties", {}).get("title", "Untitled")
        sheet_order.append(title)

    ranges = [_quote_sheet_name(title) for title in sheet_order]
    display_resp = (
        service.spreadsheets()
        .values()
        .batchGet(
            spreadsheetId=spreadsheet_id,
            ranges=ranges,
            majorDimension="ROWS",
            valueRenderOption="FORMATTED_VALUE",
        )
        .execute()
    )
    display_ranges = display_resp.get("valueRanges", [])

    for idx, title in enumerate(sheet_order):
        matrix = display_ranges[idx].get("values", []) if idx < len(display_ranges) else []
        trimmed_display, _ = _trim_display_and_formula_matrices(matrix, [])
        df = _values_to_dataframe(trimmed_display)
        formula_lookup_map[title] = {}
        sheet_map[title] = df
        total_rows += len(df)

    fetched_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    import hashlib
    cache_version = hashlib.sha1(
        f"{fetched_at}|{total_rows}|{','.join(sheet_order)}".encode("utf-8")
    ).hexdigest()[:12]

    metadata = {
        "workbook_title": meta_resp.get("properties", {}).get("title", ""),
        "fetched_at": fetched_at,
        "cache_version": cache_version,
        "formula_cache_mode": "lazy",
        "sheet_order": sheet_order,
        "sheet_count": len(sheet_order),
        "total_rows": total_rows,
    }
    return sheet_map, formula_lookup_map, metadata


@st.cache_data(ttl=600, show_spinner=False)
def load_sheet_formula_lookup(spreadsheet_id: str, sheet_name: str, headers: Sequence[str]):
    service = get_sheets_service()
    resp = (
        service.spreadsheets()
        .values()
        .batchGet(
            spreadsheetId=spreadsheet_id,
            ranges=[_quote_sheet_name(sheet_name)],
            majorDimension="ROWS",
            valueRenderOption="FORMULA",
        )
        .execute()
    )
    value_ranges = resp.get("valueRanges", [])
    matrix = value_ranges[0].get("values", []) if value_ranges else []
    return _build_formula_lookup_by_headers(headers, matrix)


@st.cache_data(ttl=600, show_spinner=False)
def load_formula_lookup_bulk(
    spreadsheet_id: str,
    header_specs: Tuple[Tuple[str, Tuple[str, ...]], ...],
) -> Dict[str, Dict[Tuple[int, str], str]]:
    if not header_specs:
        return {}

    service = get_sheets_service()
    ranges = [_quote_sheet_name(sheet_name) for sheet_name, _ in header_specs]
    resp = (
        service.spreadsheets()
        .values()
        .batchGet(
            spreadsheetId=spreadsheet_id,
            ranges=ranges,
            majorDimension="ROWS",
            valueRenderOption="FORMULA",
        )
        .execute()
    )
    value_ranges = resp.get("valueRanges", [])
    out: Dict[str, Dict[Tuple[int, str], str]] = {}
    for idx, (sheet_name, headers) in enumerate(header_specs):
        matrix = value_ranges[idx].get("values", []) if idx < len(value_ranges) else []
        out[sheet_name] = _build_formula_lookup_by_headers(headers, matrix)
    return out


def _initialize_state(
    cloud_map: Mapping[str, pd.DataFrame],
    cloud_meta: Mapping[str, Any],
    uid_column: str,
    shadow_cfg: Mapping[str, Any],
) -> None:
    if "api_calls_estimated" not in st.session_state:
        st.session_state["api_calls_estimated"] = 0

    tracked_version = st.session_state.get("tracked_cloud_cache_version")
    if tracked_version != cloud_meta["cache_version"]:
        st.session_state["tracked_cloud_cache_version"] = cloud_meta["cache_version"]
        st.session_state["api_calls_estimated"] += 1

    if "original_df_map" in st.session_state and "edited_df_map" in st.session_state:
        return

    original_map: Dict[str, pd.DataFrame] = {}
    edited_map: Dict[str, pd.DataFrame] = {}
    draft_sig_map: Dict[str, str] = {}

    for sheet, cloud_df in cloud_map.items():
        base = _prepare_sheet_df(cloud_df, uid_column, shadow_cfg)
        original_map[sheet] = base.copy()

        draft_df = load_local_draft(sheet)
        if draft_df is not None:
            merged = _merge_draft_with_cloud(base, draft_df, uid_column)
            merged, _ = ensure_uid_anchor(merged, uid_column)
            merged = apply_shadow_logic(merged, **shadow_cfg)
            edited_map[sheet] = merged
        else:
            edited_map[sheet] = base.copy()

        draft_sig_map[sheet] = _df_signature(edited_map[sheet])

    st.session_state["original_df_map"] = original_map
    st.session_state["edited_df_map"] = edited_map
    st.session_state["draft_signature_map"] = draft_sig_map
    st.session_state["local_cache_version"] = cloud_meta["cache_version"]
    st.session_state["last_sync_time"] = "尚未同步"


def _reload_from_cloud(
    cloud_map: Mapping[str, pd.DataFrame],
    cloud_meta: Mapping[str, Any],
    uid_column: str,
    shadow_cfg: Mapping[str, Any],
) -> None:
    clear_local_drafts()

    original_map: Dict[str, pd.DataFrame] = {}
    edited_map: Dict[str, pd.DataFrame] = {}
    draft_sig_map: Dict[str, str] = {}

    for sheet, cloud_df in cloud_map.items():
        base = _prepare_sheet_df(cloud_df, uid_column, shadow_cfg)
        original_map[sheet] = base.copy()
        edited_map[sheet] = base.copy()
        draft_sig_map[sheet] = _df_signature(base)

    st.session_state["original_df_map"] = original_map
    st.session_state["edited_df_map"] = edited_map
    st.session_state["draft_signature_map"] = draft_sig_map
    st.session_state["local_cache_version"] = cloud_meta["cache_version"]


def _persist_sheet_draft_if_changed(sheet: str, df: pd.DataFrame) -> None:
    new_sig = _df_signature(df)
    sig_map = st.session_state.setdefault("draft_signature_map", {})
    old_sig = sig_map.get(sheet)
    if old_sig == new_sig:
        return

    save_local_draft(sheet, df)
    sig_map[sheet] = new_sig
    st.session_state["last_draft_saved_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _render_status_board(local_cache_version: str, cloud_meta: Mapping[str, Any]) -> None:
    st.subheader("状态看板")
    api_used = int(st.session_state.get("api_calls_estimated", 0))
    api_left = max(0, DAILY_API_QUOTA_ESTIMATE - api_used)
    last_sync = st.session_state.get("last_sync_time", "尚未同步")
    last_draft_saved = st.session_state.get("last_draft_saved_at", "尚未落盘")
    snapshot_source = _safe_string(cloud_meta.get("snapshot_source", "")) or "unknown"
    snapshot_source_text = {
        "local": "本地快照",
        "cloud": "云端拉取",
        "unknown": "未知",
    }.get(snapshot_source, snapshot_source)
    snapshot_saved_at = _safe_string(cloud_meta.get("snapshot_saved_at", ""))
    snapshot_saved_text = snapshot_saved_at if snapshot_saved_at else "未记录"
    formula_mode = _safe_string(cloud_meta.get("formula_cache_mode", "lazy")) or "lazy"
    formula_mode_text = "完整(全量公式)" if formula_mode == "full" else "极速(按需公式)"

    st.metric("本地缓存版本", local_cache_version)
    st.metric("API 剩余配额(估算)", f"{api_left}", delta=f"已用 {api_used}")
    st.metric("最后同步时间", last_sync)
    st.metric("本地草稿落盘", last_draft_saved)
    st.metric("数据来源", snapshot_source_text)
    st.metric("公式模式", formula_mode_text)

    st.caption(
        f"工作簿: {cloud_meta.get('workbook_title', '')} | "
        f"工作表数: {cloud_meta.get('sheet_count', 0)} | "
        f"总行数: {cloud_meta.get('total_rows', 0)} | "
        f"拉取时间: {cloud_meta.get('fetched_at', '')} | "
        f"快照保存: {snapshot_saved_text}"
    )


def _render_sheet_map_doc() -> None:
    with st.expander("Sheet用途与表间关系", expanded=False):
        st.write("`Scoping`：规则主数据，给 `Payable` / `Final Detail` 提供 code 汇总基准。")
        st.write("`Unit Budget`：Unit 主表。来源整合后写 `B列`，再按 Q列后 Unit 头回算 `C/D`。")
        st.write("`Payable`：写入 `C:J` 的核算输出，依赖 `Scoping` 与自身 O/V/AM 字段。")
        st.write("`Final Detail`：先写 `B:K` 明细核算，再写 `E:H` 的 Unit 汇总。")
        st.write("`Draw request report`：作为 Unit 来源之一参与 Unit 主表同步。")


def _render_diff_summary(bundle: Mapping[str, Any]) -> None:
    summary = bundle["summary"]
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("变更行", int(summary["changed_rows"]))
    m2.metric("变更单元格", int(summary["changed_cells"]))
    m3.metric("新增行", int(summary["new_rows"]))
    m4.metric("金额差异合计", f"{float(summary['amount_delta']):,.2f}")

    st.write(
        f"目标工作表: {summary['target_sheet_count']} | "
        f"待同步UID: {summary['pending_uid_updates']} | "
        f"检测到删除行: {summary['deleted_rows']}（仅审计，不执行删除）"
    )

    per_sheet_df = pd.DataFrame(bundle["per_sheet"])
    if not per_sheet_df.empty:
        st.dataframe(per_sheet_df, use_container_width=True, hide_index=True)

    st.subheader("审计预览")
    for line in bundle.get("audit_lines", [])[:30]:
        st.write(f"- {line}")


def _get_shadow_config() -> Dict[str, Any]:
    return {
        "revenue_col": str(_get_secret("SHADOW_REVENUE_COL", "Revenue")).strip(),
        "cost_col": str(_get_secret("SHADOW_COST_COL", "Cost")).strip(),
        "profit_col": str(_get_secret("SHADOW_PROFIT_COL", "Profit")).strip(),
        "tax_rate_col": str(_get_secret("SHADOW_TAX_RATE_COL", "TaxRate")).strip(),
        "tax_col": str(_get_secret("SHADOW_TAX_COL", "Tax")).strip(),
        "tolerance": float(_get_secret("SHADOW_TOLERANCE", 0.01)),
    }


def _build_editor_styler(df: pd.DataFrame) -> pd.io.formats.style.Styler:
    def style_row(row: pd.Series) -> List[str]:
        if _safe_string(row.get(SHADOW_CONFLICT_COL, "")) == "冲突":
            styles = []
            for col in row.index:
                if col in (SHADOW_CONFLICT_COL, SHADOW_PY_PROFIT_COL, SHADOW_PY_TAX_COL):
                    styles.append("background-color: #ffd8d8")
                else:
                    styles.append("")
            return styles
        return [""] * len(row)

    return df.style.apply(style_row, axis=1)


def main() -> None:
    st.set_page_config(page_title="AiWB 财务 War Room", layout="wide")
    st.markdown(
        """
<style>
    .stApp {
        zoom: 0.8;
    }
    div[data-testid="stButton"] button[kind="primary"] {
        background-color: #d92d20;
        border: 1px solid #b42318;
        color: #ffffff;
        font-weight: 700;
    }
</style>
""",
        unsafe_allow_html=True,
    )

    spreadsheet_id = str(_get_secret("SPREADSHEET_ID", os.getenv("SPREADSHEET_ID", ""))).strip()
    uid_column = str(_get_secret("UID_COLUMN", DEFAULT_UID_COLUMN)).strip()
    amount_column = str(_get_secret("AMOUNT_COLUMN", DEFAULT_AMOUNT_COLUMN)).strip()
    entity_column = str(_get_secret("ENTITY_COLUMN", DEFAULT_ENTITY_COLUMN)).strip()
    guard_sheet_name = str(_get_secret("GUARD_SHEET_NAME", DEFAULT_GUARD_SHEET)).strip()
    expected_first_cell = str(_get_secret("EXPECTED_FIRST_CELL", DEFAULT_EXPECTED_FIRST_CELL)).strip()

    operator_email_default = str(_get_secret("OPERATOR_EMAIL", os.getenv("USER_EMAIL", ""))).strip()
    operator_name_default = str(_get_secret("OPERATOR_NAME", os.getenv("USER", "unknown"))).strip()

    wbd_options = _parse_options(_get_secret("WBD_OPTIONS"), ["Pending", "Done", "Hold"])
    wbh_options = _parse_options(_get_secret("WBH_OPTIONS"), ["Open", "Closed", "N/A"])

    shadow_cfg = _get_shadow_config()

    if not spreadsheet_id:
        st.error("未配置 SPREADSHEET_ID。")
        st.stop()

    if "boot_cloud_load_requested" not in st.session_state:
        st.session_state["boot_cloud_load_requested"] = False

    force_cloud_refresh = bool(st.session_state.pop("force_cloud_refresh", False))
    has_cloud_snapshot = (
        st.session_state.get("cloud_snapshot_spreadsheet_id") == spreadsheet_id
        and "cloud_snapshot_map" in st.session_state
        and "cloud_snapshot_formula_map" in st.session_state
        and "cloud_snapshot_meta" in st.session_state
    )

    if not has_cloud_snapshot and not force_cloud_refresh:
        local_snapshot = load_local_cloud_snapshot(spreadsheet_id)
        if local_snapshot is not None:
            cloud_map, formula_lookup_map, cloud_meta = local_snapshot
            st.session_state["cloud_snapshot_spreadsheet_id"] = spreadsheet_id
            st.session_state["cloud_snapshot_map"] = cloud_map
            st.session_state["cloud_snapshot_formula_map"] = formula_lookup_map
            st.session_state["cloud_snapshot_meta"] = cloud_meta
            has_cloud_snapshot = True

    if not has_cloud_snapshot and not force_cloud_refresh and not st.session_state["boot_cloud_load_requested"]:
        st.title("AiWB 财务 War Room")
        if st.button("开始加载 Google Sheets 数据", type="primary", use_container_width=True):
            st.session_state["boot_cloud_load_requested"] = True
            st.rerun()
        st.stop()

    if force_cloud_refresh or not has_cloud_snapshot:
        try:
            with st.spinner("正在拉取 Google Sheets 数据..."):
                cloud_map, formula_lookup_map, cloud_meta = load_data(spreadsheet_id)
                cloud_meta["snapshot_source"] = "cloud"
                cloud_meta["snapshot_saved_at"] = datetime.now(timezone.utc).isoformat()
        except HttpError as err:
            st.error(f"加载工作簿失败: {err}")
            st.stop()
        except Exception as err:
            st.error(f"初始化失败: {err}")
            st.stop()

        st.session_state["cloud_snapshot_spreadsheet_id"] = spreadsheet_id
        st.session_state["cloud_snapshot_map"] = cloud_map
        st.session_state["cloud_snapshot_formula_map"] = formula_lookup_map
        st.session_state["cloud_snapshot_meta"] = cloud_meta
        save_local_cloud_snapshot(spreadsheet_id, cloud_map, formula_lookup_map, cloud_meta)
        st.session_state["boot_cloud_load_requested"] = False
    else:
        cloud_map = st.session_state["cloud_snapshot_map"]
        formula_lookup_map = st.session_state["cloud_snapshot_formula_map"]
        cloud_meta = st.session_state["cloud_snapshot_meta"]

    _initialize_state(cloud_map, cloud_meta, uid_column, shadow_cfg)

    original_map: MutableMapping[str, pd.DataFrame] = st.session_state["original_df_map"]
    edited_map: MutableMapping[str, pd.DataFrame] = st.session_state["edited_df_map"]

    sheet_order = [name for name in cloud_meta.get("sheet_order", []) if name in edited_map]
    if not sheet_order:
        st.warning("无工作表。")
        st.stop()

    active_sheet = st.session_state.get("active_sheet", sheet_order[0])
    if active_sheet not in sheet_order: active_sheet = sheet_order[0]
    st.session_state["active_sheet"] = active_sheet

    formula_map_state: Dict[str, Dict[Tuple[int, str], str]] = st.session_state.setdefault("formula_lookup_map", {})
    if not formula_map_state.get(active_sheet):
        active_headers = [str(c) for c in _cloud_view(edited_map.get(active_sheet, pd.DataFrame())).columns.tolist()]
        if active_headers:
            try:
                with st.spinner(f"正在加载 {active_sheet} 公式..."):
                    formula_map_state[active_sheet] = load_sheet_formula_lookup(spreadsheet_id, active_sheet, tuple(active_headers))
                st.session_state["formula_lookup_map"] = formula_map_state
            except Exception:
                formula_map_state[active_sheet] = {}

    if "left_panel_collapsed" not in st.session_state: st.session_state["left_panel_collapsed"] = False
    l_ratio, r_ratio = (0.13, 3.87) if st.session_state["left_panel_collapsed"] else (1.08, 2.92)
    left_col, right_col = st.columns([l_ratio, r_ratio], gap="large")

    with left_col:
        if st.session_state["left_panel_collapsed"]:
            if st.button(">>", use_container_width=True):
                st.session_state["left_panel_collapsed"] = False
                st.rerun()
        else:
            st.title("AiWB 财务 War Room")
            if st.button("<< 收起左栏", use_container_width=True):
                st.session_state["left_panel_collapsed"] = True
                st.rerun()

            st.subheader("控制区")
            st.text_input("操作人邮箱", value=st.session_state.get("operator_email", operator_email_default), key="operator_email_input")
            st.text_input("操作人显示名", value=st.session_state.get("operator_name", operator_name_default), key="operator_name_input")

            if st.button("从云端重载", use_container_width=True):
                _reload_from_cloud(cloud_map, cloud_meta, uid_column, shadow_cfg)
                st.rerun()

            if st.button("强制刷新缓存", use_container_width=True):
                load_data.clear(); clear_local_cloud_snapshot()
                st.session_state["force_cloud_refresh"] = True
                st.rerun()

            if st.button("运行核算流水线", use_container_width=True):
                try:
                    new_map, pipeline_report, _ = run_apps_shadow_pipeline(edited_map, uid_column, shadow_cfg)
                    edited_map.update(new_map); st.session_state["pipeline_report"] = pipeline_report
                    for s, df in new_map.items(): _persist_sheet_draft_if_changed(s, df)
                    st.rerun()
                except Exception as e: st.error(f"失败: {e}")

            if st.button("同步109公式", type="primary", use_container_width=True):
                try:
                    service = get_sheets_service()
                    plan_109, meta_109 = generate_109_formula_plan(service, spreadsheet_id)
                    result_109 = execute_109_formula_plan(spreadsheet_id, plan_109)
                    st.session_state["formula_plan_109_result"] = result_109
                    st.rerun()
                except Exception as e: st.error(f"失败: {e}")

            dirty_sheets = _find_dirty_sheets(st.session_state["original_df_map"], edited_map)
            st.write(f"待同步: {len(dirty_sheets)}")
            sync_scope = st.radio("范围", options=["当前 Sheet", "所有待同步"], horizontal=True)

            if st.button("同步至 Google Sheet", type="primary", use_container_width=True):
                targets = [active_sheet] if sync_scope == "当前 Sheet" else dirty_sheets
                if targets:
                    bundle = build_commit_bundle(st.session_state["original_df_map"], edited_map, targets, uid_column, amount_column, entity_column)
                    st.session_state["pending_commit"] = {"target_sheets": targets, "bundle": bundle}
                    st.session_state["show_confirm"] = True

            st.markdown("---")
            _render_status_board(st.session_state["local_cache_version"], cloud_meta)

    with right_col:
        for i in range(0, len(sheet_order), 4):
            cols = st.columns(min(4, len(sheet_order) - i))
            for j, s in enumerate(sheet_order[i:i+4]):
                if cols[j].button(s, key=f"btn_{s}", type="primary" if s == active_sheet else "secondary", use_container_width=True):
                    st.session_state["active_sheet"] = s; st.rerun()

        active_df = edited_map.get(active_sheet, pd.DataFrame()).copy()
        active_df, _ = ensure_uid_anchor(active_df, uid_column)
        active_df = apply_shadow_logic(active_df, **shadow_cfg)

        visible_cols = [c for c in active_df.columns if not _is_internal_col(str(c))]
        formula_text = st.session_state.get("formula_lookup_map", {}).get(active_sheet, {}).get((0, visible_cols[0] if visible_cols else ""), "无")
        st.subheader(f"编辑: {active_sheet}")

        editor_output = st.data_editor(
            _build_editor_styler(active_df),
            key=f"editor_{active_sheet}",
            num_rows="dynamic",
            height=800,
            use_container_width=True,
            hide_index=True,
            disabled=[UID_STATUS_COL, SHADOW_CONFLICT_COL, SHADOW_PY_PROFIT_COL, SHADOW_PY_TAX_COL],
        )

        editor_output, _ = ensure_uid_anchor(editor_output, uid_column)
        editor_output = apply_shadow_logic(editor_output, **shadow_cfg)
        edited_map[active_sheet] = editor_output
        _persist_sheet_draft_if_changed(active_sheet, editor_output)

        if st.session_state.get("show_confirm"):
            commit_data = st.session_state["pending_commit"]
            st.warning(f"确认同步 {commit_data['target_sheets']}?")
            if st.button("确定同步", type="primary"):
                service = get_sheets_service()
                execute_commit(service, spreadsheet_id, commit_data["bundle"], guard_sheet_name, expected_first_cell)
                st.session_state["show_confirm"] = False
                st.success("同步成功"); st.rerun()

if __name__ == "__main__":
    main()
