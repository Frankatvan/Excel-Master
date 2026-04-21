# 109 Auto-Write And Highlights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make `109` formula sync auto-write to Google Sheets, reset and repaint `109` colors, and append a workbook log entry for each run.

**Architecture:** Keep the feature in `check_finance.py`, add a small set of `109`-specific helpers for row discovery, formula diffing, Sheet formatting, and log-sheet appends, and keep tests local with `unittest` plus mocked Sheets service objects. Scope stays limited to `109`.

**Tech Stack:** Python 3.11, Streamlit, Google Sheets API v4, pandas, PyYAML, unittest

---

### File Structure

**Files:**
- Modify: `check_finance.py`
- Modify: `tests/test_109_formula_dictionary.py`
- Use existing: `docs/AiWB_公式字典_109_v1.yaml`

### Task 1: Lock Down 109 Manual-Input And No-Op Rehighlight Behavior

**Files:**
- Modify: `tests/test_109_formula_dictionary.py`
- Modify: `check_finance.py`

- [x] **Step 1: Write the failing test for manual-input row ranges**

```python
def test_build_109_manual_input_ranges_uses_confirmed_scope_only(self):
    rows = build_minimal_109_grid()
    ranges = cf._build_109_manual_input_ranges(rows, [2021, 2022, 2023, 2024, 2025, 2026])

    self.assertEqual(["'109'!F3:K3", "'109'!F20:K20", "'109'!F21:K21", "'109'!F22:K22"], ranges)
```

- [x] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest tests.test_109_formula_dictionary.FormulaDictionaryTests.test_build_109_manual_input_ranges_uses_confirmed_scope_only -v`
Expected: FAIL because `_build_109_manual_input_ranges` does not exist yet.

- [x] **Step 3: Write the failing test for no-op recolor execution**

```python
def test_execute_109_formula_plan_rehighlights_on_noop(self):
    ...
    self.assertTrue(result["skipped_noop"])
    self.assertEqual(1, result["format_calls"])
    self.assertEqual(1, result["log_rows_appended"])
```

- [x] **Step 4: Run the test to verify it fails**

Run: `python3 -m unittest tests.test_109_formula_dictionary.FormulaDictionaryTests.test_execute_109_formula_plan_rehighlights_on_noop -v`
Expected: FAIL because formatting/logging side effects are not implemented.

### Task 2: Implement 109 Formatting And Logging Helpers

**Files:**
- Modify: `check_finance.py`
- Test: `tests/test_109_formula_dictionary.py`

- [x] **Step 1: Add helpers for 109 year columns, manual-input row lookup, and changed-cell extraction**

```python
def _year_columns_from_dictionary(config: Mapping[str, Any]) -> List[int]:
    years = [int(x) for x in dict(config.get("period_axis", {})).get("years", [2021, 2022, 2023, 2024, 2025, 2026])]
    return list(range(6, 6 + len(years)))
```

- [x] **Step 2: Add helpers to clear `109` background colors and repaint red/yellow ranges using `spreadsheets().batchUpdate(...)`**

```python
def _apply_109_formatting(...):
    # clear 109, paint manual input ranges red, changed formula cells yellow
```

- [x] **Step 3: Add helpers to ensure and append to `AiWB_109_Log`**

```python
def _append_109_log_row(...):
    # create sheet if missing, append one row
```

- [x] **Step 4: Run focused tests**

Run: `python3 -m unittest tests.test_109_formula_dictionary -v`
Expected: FAIL only on still-missing execution wiring.

### Task 3: Wire Auto-Write 109 UI And Execution Path

**Files:**
- Modify: `check_finance.py`
- Test: `tests/test_109_formula_dictionary.py`

- [x] **Step 1: Write the failing UI/execution regression test**

```python
def test_execute_109_formula_plan_reports_changed_cells_for_highlight(self):
    ...
    self.assertEqual(["F24"], result["changed_cells"])
```

- [x] **Step 2: Run the test to verify it fails**

Run: `python3 -m unittest tests.test_109_formula_dictionary.FormulaDictionaryTests.test_execute_109_formula_plan_reports_changed_cells_for_highlight -v`
Expected: FAIL because changed-cell reporting is not returned yet.

- [x] **Step 3: Update `execute_109_formula_plan`**

```python
# pre-verify current sheet state
# compute changed cells from mismatches
# write formulas only when needed
# always repaint 109 colors and append log row
```

- [x] **Step 4: Update Streamlit UI**

```python
# remove checkbox gate
# change button copy to direct sync wording
# surface updated/no-op result with changed-count and log confirmation
```

- [x] **Step 5: Run the full local test file**

Run: `python3 -m unittest tests.test_109_formula_dictionary -v`
Expected: PASS

### Self-Review Checklist

- [x] Spec coverage: auto-write, `109` clear/repaint, red manual-input ranges, yellow changed cells, workbook log page.
- [x] Placeholder scan: no `TODO`/`TBD` implementation steps remain.
- [x] Type consistency: helper names and returned keys match the execution path and tests.
