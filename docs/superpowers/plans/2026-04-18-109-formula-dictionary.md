# 109 Formula Dictionary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the hard-coded 109 formula plan builder in `check_finance.py` with a YAML-driven configuration while preserving the existing Streamlit preview/write flow.

**Architecture:** Keep the current single-file app structure, add a small dictionary loader plus a config-aware formula-plan builder, and leave the Google Sheets write/verify pipeline unchanged. Scope is limited to the already-confirmed yearly `F:K` AiWB formula block on sheet `109`; unresolved source mapping such as `Budget Cost Change Order` stays manual and is only surfaced as metadata.

**Tech Stack:** Python 3.11, Streamlit, pandas, PyYAML, pytest

---

### File Structure

**Files:**
- Create: `tests/test_109_formula_dictionary.py`
- Modify: `check_finance.py`
- Use existing: `docs/AiWB_公式字典_109_v1.yaml`

`check_finance.py` keeps ownership of the formula-plan generation path because the repo already centralizes workbook logic there. The new test file should focus on dictionary loading and plan generation from a small in-memory 109 grid fixture so the work stays deterministic and does not hit Google APIs.

### Task 1: Lock Down The Current 109 Behavior With Failing Tests

**Files:**
- Create: `tests/test_109_formula_dictionary.py`
- Modify: `check_finance.py`

- [x] **Step 1: Write the failing test for dictionary loading metadata**

```python
from check_finance import _load_109_formula_dictionary


def test_load_109_formula_dictionary_reads_yaml_metadata():
    cfg = _load_109_formula_dictionary()

    assert cfg["version"] == "v1"
    assert cfg["sheet"] == "109"
    assert cfg["period_axis"]["mode"] == "yearly"
    assert cfg["period_axis"]["years"] == [2021, 2022, 2023, 2024, 2025, 2026]
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_109_formula_dictionary.py::test_load_109_formula_dictionary_reads_yaml_metadata -q`
Expected: FAIL because `_load_109_formula_dictionary` does not exist yet.

- [x] **Step 3: Write the failing test for config-driven formula output**

```python
from check_finance import _build_109_formula_plan_from_grid, _load_109_formula_dictionary


def build_minimal_109_grid():
    return [
        ["", "", "", "", "", "2021", "2022", "2023", "2024", "2025", "2026"],
        ["", "", "", "Contract price", 1000],
        ["", "", "", "Budget Cost Change Order"],
        ["", "", "", "Scoping Budget Cost"],
        ["", "", "", "Cost of Goods Sold-Company"],
        ["", "", "", "Percentage of Completion"],
        ["", "", "", "Completion Rate for the Period"],
        ["", "", "", "General Conditions fee-Company"],
        ["", "", "", "Gross Profit-Company"],
        ["", "", "", "Accounts Receivable-Incurred"],
        ["", "", "", "Accounts Receivable-Audited"],
        ["", "", "", "Accounts Receivable-Company"],
        ["", "", "", "Accounts Receivable"],
        ["", "", "", "WB Home Income"],
        ["", "", "", "WB Home COGS"],
        ["", "", "", "WB Home Inventory Income"],
        ["", "", "", "WB Home Inventory"],
        ["", "", "", "WB Home Inventory Income-Reverse"],
        ["", "", "", "WB Home Inventory-Reverse"],
        ["", "", "", "WB. Home Material Margin Total"],
        ["", "", "", "Material Margin"],
        ["", "", "", "Material Margin"],
    ]


def test_build_109_formula_plan_from_grid_uses_dictionary_year_axis():
    rows = build_minimal_109_grid()

    plan, meta = _build_109_formula_plan_from_grid(rows, _load_109_formula_dictionary())

    formula_by_cell = {item["cell"]: item["formula"] for item in plan}
    assert formula_by_cell["F4"] == "=IFERROR('Unit Budget'!$C$1+SUM($F$3:F3),\"\")"
    assert formula_by_cell["K6"] == '=IFERROR(K5-J5,"")'
    assert meta["dictionary_version"] == "v1"
```

- [x] **Step 4: Run the test to verify it fails**

Run: `pytest tests/test_109_formula_dictionary.py::test_build_109_formula_plan_from_grid_uses_dictionary_year_axis -q`
Expected: FAIL because `_build_109_formula_plan_from_grid` does not yet accept a dictionary argument or return dictionary metadata.

- [x] **Step 5: Run the focused test file**

Run: `pytest tests/test_109_formula_dictionary.py -q`
Expected: FAIL with the two missing-behavior assertions above and no import/runtime errors unrelated to the feature.

### Task 2: Implement YAML Loading And Config-Aware Plan Generation

**Files:**
- Modify: `check_finance.py`
- Test: `tests/test_109_formula_dictionary.py`

- [x] **Step 1: Add the minimal loader**

```python
import yaml


def _load_109_formula_dictionary(path: Path | None = None) -> Dict[str, Any]:
    dictionary_path = path or Path("docs/AiWB_公式字典_109_v1.yaml")
    with dictionary_path.open("r", encoding="utf-8") as fh:
        payload = yaml.safe_load(fh) or {}
    if not isinstance(payload, dict):
        raise RuntimeError("109公式字典格式无效。")
    return payload
```

- [x] **Step 2: Thread the dictionary into the plan builder with a backward-compatible default**

```python
def _build_109_formula_plan_from_grid(
    rows: Sequence[Sequence[Any]],
    config: Mapping[str, Any] | None = None,
) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    cfg = dict(config or _load_109_formula_dictionary())
    period_axis = dict(cfg.get("period_axis", {}))
    years = [int(x) for x in period_axis.get("years", [2021, 2022, 2023, 2024, 2025, 2026])]
    year_cols = list(range(6, 6 + len(years)))
    for offset, col_i in enumerate(year_cols):
        col = _column_number_to_a1(col_i)
        prev_col = _column_number_to_a1(col_i - 1) if offset > 0 else ""
        year_ref = f"{col}${year_row}"
        add_formula(
            col_i,
            row_budget,
            f"=IFERROR('Unit Budget'!$C$1+SUM($F${row_bco}:{col}{row_bco}),\"\")",
            "EAC分母=初始直接成本+累计Budget Cost Change Order",
        )
        add_formula(
            col_i,
            row_cr,
            f"=IFERROR({col}{row_poc},\"\")" if offset == 0 else f"=IFERROR({col}{row_poc}-{prev_col}{row_poc},\"\")",
            "Completion Rate=本期POC-上期POC",
        )
    meta = {
        "sheet": "109",
        "dictionary_version": _safe_string(cfg.get("version", "")),
        "period_mode": _safe_string(period_axis.get("mode", "")),
        "formula_count": len(plan),
        "key_rows": {k: int(v) for k, v in required_rows.items() if v is not None},
    }
```

- [x] **Step 3: Load the dictionary from the public entrypoint**

```python
def generate_109_formula_plan(spreadsheet_id: str) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    service = get_sheets_service()
    resp = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range="109!A:R")
        .execute()
    )
    rows = resp.get("values", [])
    cfg = _load_109_formula_dictionary()
    return _build_109_formula_plan_from_grid(rows, cfg)
```

- [x] **Step 4: Run the focused tests to verify green**

Run: `pytest tests/test_109_formula_dictionary.py -q`
Expected: PASS

- [x] **Step 5: Refactor only if needed**

Keep refactor limited to tiny helpers such as extracting `year_cols` or config validation. Do not change the Google Sheets write path or the Streamlit button flow in this task.

### Task 3: Expose Dictionary Provenance In The Existing UI And Add A Regression Test

**Files:**
- Modify: `check_finance.py`
- Modify: `tests/test_109_formula_dictionary.py`

- [x] **Step 1: Write the failing regression test for metadata exposure**

```python
from check_finance import _build_109_formula_plan_from_grid, _load_109_formula_dictionary


def test_109_formula_plan_meta_exposes_open_items():
    rows = build_minimal_109_grid()
    plan, meta = _build_109_formula_plan_from_grid(rows, _load_109_formula_dictionary())

    assert plan
    assert "Budget Cost Change Order source mapping" in meta["open_items"]
```

- [x] **Step 2: Run the regression test to verify it fails**

Run: `pytest tests/test_109_formula_dictionary.py::test_109_formula_plan_meta_exposes_open_items -q`
Expected: FAIL because `open_items` is not yet returned.

- [x] **Step 3: Add the minimal metadata plumbing and preview caption**

```python
meta["open_items"] = list(cfg.get("open_items", []))

st.caption(
    f"109定位行: {len(formula_plan_109_meta.get('key_rows', {}))} | "
    f"公式条数: {formula_plan_109_meta.get('formula_count', len(formula_plan_109))} | "
    f"字典版本: {formula_plan_109_meta.get('dictionary_version', 'unknown')}"
)
```

- [x] **Step 4: Run the test file again**

Run: `pytest tests/test_109_formula_dictionary.py -q`
Expected: PASS

- [x] **Step 5: Record completion status**

This workspace is not a git repository, so skip commit steps. Instead, note verification results in the implementation handoff and keep the diff limited to the files above.

### Self-Review Checklist

- [x] Plan covers the scoped requirement: YAML-driven 109 plan generation without changing the write/verify pipeline.
- [x] No placeholder steps remain.
- [x] All function names are consistent across tasks: `_load_109_formula_dictionary`, `_build_109_formula_plan_from_grid`, `generate_109_formula_plan`.
