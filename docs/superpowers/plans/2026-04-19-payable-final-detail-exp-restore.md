# Payable / Final Detail EXP Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a post-classification restore pass that converts a unique cross-sheet `EXP` pair into `Final Detail = ACC` and `Payable = RACC` when the pair falls inside the confirmed `Final date` business window.

**Architecture:** Keep the existing row-level classification tree unchanged, and add one shared orchestration layer that computes the initial `Payable` and `Final Detail` categories, applies a cross-sheet restore pass, then hands the adjusted categories back to the existing sheet writers. The restore pass must stay narrow: unique one-to-one match only, both sides initially `EXP`, `GMP(1)` only, and only when `Payable.Incurred Date <= Final Detail.Final Date` while `actual_settlement_date < Final Detail.Final Date`.

**Tech Stack:** Python, pandas, openpyxl, unittest, pytest

---

## File Structure

### Existing files to modify
- `check_finance.py`
  Responsibility: shared classification helpers, `Payable` / `Final Detail` category computation, and write-back paths.
- `tests/test_payable_final_detail_classification.py`
  Responsibility: unit coverage for classification and cross-sheet restore behavior.

### No new production modules required
- Keep the implementation inside `check_finance.py` for now. The file already owns the classification pipeline, and this change is a narrow extension to that flow rather than a new subsystem.

### Planned function boundaries
- Add `_compute_cross_sheet_classifications(sheet_map)` as the shared orchestrator that returns both final category lists plus merged diagnostics.
- Add `_make_exp_restore_match_key(vendor, amount, cost_code, incurred_date)` to reuse the existing cross-sheet approximation key in one named place.
- Add `_apply_exp_restore_overrides(...)` to scan the initial results and emit adjusted categories plus restore telemetry.
- Keep `_classify_payable_record(...)` and `_classify_final_detail_record(...)` unchanged except for any tiny signature or helper reuse that proves necessary during implementation.

### Test strategy
- Add one focused happy-path test proving the restore converts a unique `EXP` pair into `RACC` / `ACC`.
- Add one ambiguity test proving duplicate keys do not restore.
- Add one write-back test proving `_process_payable_py(...)` and `_process_final_detail_py(...)` still write the adjusted categories to column `A`.

### Repository note
- This workspace currently has no `.git` directory, so the usual per-task commit step becomes a documented no-op. Use the provided shell check so the execution log stays explicit.

### Task 1: Add Failing Restore Tests

**Files:**
- Modify: `tests/test_payable_final_detail_classification.py:11-336`
- Reference: `check_finance.py:825-1023`

- [x] **Step 1: Write the failing tests for unique restore and ambiguity skip**

```python
class PayableFinalDetailClassificationTests(unittest.TestCase):
    def _build_restore_ready_sheet_map(self) -> dict[str, pd.DataFrame]:
        payable = pd.DataFrame(
            [
                {
                    "Vendor": "GT Plumbing LLC",
                    "Amount": 4646.0,
                    "Incurred Date": "2025-06-30",
                    "Unit Code": "14407DD",
                    "Cost Code": "2HD300",
                }
            ]
        )

        final_detail = pd.DataFrame(
            [
                {
                    "Final Date": "2025-06-24",
                    "Incurred Date": "2025-06-30",
                    "Unit Code": "14407DD",
                    "Activity No.": "30002",
                    "Cost Code": "2HD300",
                    "Amount": 4646.0,
                    "Vendor": "GT Plumbing LLC",
                }
            ]
        )

        scoping = pd.DataFrame(
            [
                ["", "", "Group Number", "", "GMP", "Fee", "WIP", "WTC", "GC", "TBD"],
                ["", "", 300, "", 1, "", "", "", "", ""],
            ]
        )

        unit_budget = pd.DataFrame(
            [
                ["", "Unit Code", "", "", "", "", "结算年份", "C/O date", "实际结算日期", "实际结算年份", "预算差异", "TBD Acceptance Date", "Group", "GMP", "Fee", "WIP"],
                ["", "14407DD", "", "", "", "", 2025, "2025-05-15", "2025-06-01", 2025, "", "", "", "", "", ""],
            ]
        )

        return {
            "Payable": payable,
            "Final Detail": final_detail,
            "Scoping": scoping,
            "Unit Budget": unit_budget,
        }

    def test_compute_cross_sheet_classifications_restores_unique_exp_pair(self):
        categories = cf._compute_cross_sheet_classifications(self._build_restore_ready_sheet_map())

        self.assertEqual(["RACC"], categories["payable_categories"])
        self.assertEqual(["ACC"], categories["final_detail_categories"])
        self.assertEqual(1, categories["restore_extra"]["restore_hit_count"])

    def test_compute_cross_sheet_classifications_skips_ambiguous_restore_match(self):
        sheet_map = self._build_restore_ready_sheet_map()
        duplicate_row = sheet_map["Final Detail"].iloc[[1]].copy()
        sheet_map["Final Detail"] = pd.concat([sheet_map["Final Detail"], duplicate_row], ignore_index=True)

        categories = cf._compute_cross_sheet_classifications(sheet_map)

        self.assertEqual(["EXP"], categories["payable_categories"])
        self.assertEqual(["EXP", "EXP"], categories["final_detail_categories"])
        self.assertEqual(0, categories["restore_extra"]["restore_hit_count"])

    def test_process_sheet_writers_persist_restored_category_to_column_a(self):
        sheet_map = self._build_restore_ready_sheet_map()

        payable_out, payable_extra = cf._process_payable_py(sheet_map)
        final_out, final_extra = cf._process_final_detail_py(sheet_map)

        self.assertEqual("RACC", payable_out["Payable"].iloc[0, 0])
        self.assertEqual("ACC", final_out["Final Detail"].iloc[0, 0])
        self.assertEqual(1, payable_extra["restore_hit_count"])
        self.assertEqual(1, final_extra["restore_hit_count"])
```

- [x] **Step 2: Run the new tests to verify they fail**

Run: `python -m pytest tests/test_payable_final_detail_classification.py -k "restore_unique_exp_pair or ambiguous_restore_match or persist_restored_category" -v`

Expected: FAIL because `check_finance.py` does not yet expose `_compute_cross_sheet_classifications(...)`, and the existing writers still return `EXP`.

- [x] **Step 3: Record the failing surface before editing production code**

```text
Missing helper to orchestrate both sheets together:
- _compute_cross_sheet_classifications(...)

Missing restore telemetry in extra output:
- restore_hit_count
- restore_samples

Current writer behavior still writes initial categories only:
- Payable row remains EXP
- Final Detail row remains EXP
```

- [x] **Step 4: Verify only the intended test file changed**

Run: `python - <<'PY'\nfrom pathlib import Path\nprint(Path('tests/test_payable_final_detail_classification.py').exists())\nPY`

Expected: `True`

- [x] **Step 5: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

### Task 2: Implement Shared Restore Orchestration

**Files:**
- Modify: `check_finance.py:825-1023`
- Test: `tests/test_payable_final_detail_classification.py:11-336`

- [x] **Step 1: Add the shared restore key helper**

```python
def _make_exp_restore_match_key(
    vendor: Any,
    amount: Any,
    cost_code: Any,
    incurred_date: Any,
) -> Tuple[str, float, str, str]:
    return _make_payable_racc_key(
        vendor=vendor,
        amount=amount,
        cost_code=cost_code,
        incurred_date=incurred_date,
    )
```

- [x] **Step 2: Add a shared restore pass that operates on initial categories from both sheets**

```python
def _apply_exp_restore_overrides(
    wsf: pd.DataFrame,
    wsp: pd.DataFrame,
    scoping_status_map: Mapping[int, set[int]],
    unit_schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]],
    payable_categories: Sequence[str],
    final_detail_categories: Sequence[str],
) -> Dict[str, Any]:
    payable_layout = _payable_layout(wsp)
    final_layout = _final_detail_layout(wsf)
    payable_hits: Dict[Tuple[str, float, str, str], List[int]] = {}
    final_hits: Dict[Tuple[str, float, str, str], List[int]] = {}

    for i in range(len(wsp)):
        vendor = _safe_string(_get_cell(wsp, i, int(payable_layout.get("vendor") or 10)))
        amount = _get_cell(wsp, i, int(payable_layout.get("amount") or 16))
        cost_code = _safe_string(_get_cell(wsp, i, int(payable_layout.get("cost_code") or 34)))
        incurred_date = _get_cell(wsp, i, int(payable_layout.get("incurred_date") or 17))
        key = _make_exp_restore_match_key(vendor, amount, cost_code, incurred_date)
        if key[-1]:
            payable_hits.setdefault(key, []).append(i)

    for i in range(len(wsf)):
        vendor = _safe_string(_get_cell(wsf, i, int(final_layout.get("vendor") or 28)))
        amount = _get_cell(wsf, i, int(final_layout.get("amount") or 26))
        cost_code = _safe_string(_get_cell(wsf, i, int(final_layout.get("cost_code") or 24)))
        incurred_date = _get_cell(wsf, i, int(final_layout.get("incurred_date") or 18))
        key = _make_exp_restore_match_key(vendor, amount, cost_code, incurred_date)
        if key[-1]:
            final_hits.setdefault(key, []).append(i)

    new_payable = list(payable_categories)
    new_final = list(final_detail_categories)
    restore_samples: List[Dict[str, Any]] = []
    restore_hit_count = 0

    for key, payable_rows in payable_hits.items():
        final_rows = final_hits.get(key, [])
        if len(payable_rows) != 1 or len(final_rows) != 1:
            continue

        payable_row = payable_rows[0]
        final_row = final_rows[0]
        if new_payable[payable_row] != "EXP" or new_final[final_row] != "EXP":
            continue

        cost_code = _safe_string(_get_cell(wsp, payable_row, int(payable_layout.get("cost_code") or 34)))
        group_number = _extract_tail_int(cost_code, 3)
        statuses = scoping_status_map.get(int(group_number), set()) if group_number is not None else set()
        if 1 not in statuses:
            continue

        unit_code = _safe_string(_get_cell(wsf, final_row, int(final_layout.get("unit_code") or 19)))
        schedule = _resolve_unit_budget_schedule(unit_schedule_map, unit_code)
        actual_dt = _normalize_date_value(schedule.get("actual_settlement_date"))
        final_dt = _normalize_date_value(_get_cell(wsf, final_row, int(final_layout.get("final_date") or 13)))
        incurred_dt = _normalize_date_value(_get_cell(wsp, payable_row, int(payable_layout.get("incurred_date") or 17)))
        if actual_dt is None or final_dt is None or incurred_dt is None:
            continue
        if not (actual_dt < final_dt and incurred_dt <= final_dt):
            continue

        new_payable[payable_row] = "RACC"
        new_final[final_row] = "ACC"
        restore_hit_count += 1
        if len(restore_samples) < 20:
            restore_samples.append(
                {
                    "sheet": "CrossSheet",
                    "row": f"Payable:{payable_row + 2}|Final Detail:{final_row + 2}",
                    "unit_code": unit_code,
                    "vendor": _safe_string(_get_cell(wsf, final_row, int(final_layout.get("vendor") or 28))),
                    "cost_code": cost_code,
                    "amount": _get_cell(wsp, payable_row, int(payable_layout.get("amount") or 16)),
                    "incurred_date": incurred_dt.strftime("%Y-%m-%d"),
                    "final_date": final_dt.strftime("%Y-%m-%d"),
                    "from_category": "EXP/EXP",
                    "to_category": "RACC/ACC",
                    "restore_reason": "exp_restored_by_final_date_window",
                }
            )

    return {
        "payable_categories": new_payable,
        "final_detail_categories": new_final,
        "restore_hit_count": restore_hit_count,
        "restore_samples": restore_samples,
    }
```

- [x] **Step 3: Add the shared orchestrator and make the sheet-specific functions consume it**

First, rename the current full bodies of:
- `_compute_payable_classifications(...)`
- `_compute_final_detail_classifications(...)`

to:
- `_compute_payable_classifications_initial(...)`
- `_compute_final_detail_classifications_initial(...)`

without changing their internal rule behavior. Use the current implementations from `check_finance.py:891-953` and `check_finance.py:956-1023` as the bodies for those renamed helpers. After that rename, add the wrappers below:

```python
def _compute_cross_sheet_classifications(sheet_map: Mapping[str, pd.DataFrame]) -> Dict[str, Any]:
    wsp = _ensure_column_count(sheet_map[_sheet_key(sheet_map, "Payable")], 43)
    wsf = _ensure_column_count(sheet_map[_sheet_key(sheet_map, "Final Detail")], 30)
    wss = _ensure_column_count(sheet_map[_sheet_key(sheet_map, "Scoping")], 10)
    wsb = _ensure_column_count(sheet_map[_sheet_key(sheet_map, "Unit Budget")], 16)

    scoping_status_map = _build_scoping_status_map(wss)
    unit_schedule_map = _build_unit_budget_schedule_map(wsb, _load_default_unit_budget_schedule_overrides())
    final_detail_index = _build_final_detail_classification_index(wsf, scoping_status_map, unit_schedule_map)

    payable_categories, payable_extra = _compute_payable_classifications_initial(
        wsp, wsf, scoping_status_map, unit_schedule_map, final_detail_index
    )
    final_detail_categories, final_detail_extra = _compute_final_detail_classifications_initial(
        wsf, scoping_status_map, unit_schedule_map, final_detail_index
    )
    restore_extra = _apply_exp_restore_overrides(
        wsf=wsf,
        wsp=wsp,
        scoping_status_map=scoping_status_map,
        unit_schedule_map=unit_schedule_map,
        payable_categories=payable_categories,
        final_detail_categories=final_detail_categories,
    )

    return {
        "payable_categories": restore_extra["payable_categories"],
        "final_detail_categories": restore_extra["final_detail_categories"],
        "payable_extra": {
            **payable_extra,
            "restore_hit_count": restore_extra["restore_hit_count"],
            "restore_samples": restore_extra["restore_samples"],
        },
        "final_detail_extra": {
            **final_detail_extra,
            "restore_hit_count": restore_extra["restore_hit_count"],
            "restore_samples": restore_extra["restore_samples"],
        },
        "restore_extra": {
            "restore_hit_count": restore_extra["restore_hit_count"],
            "restore_samples": restore_extra["restore_samples"],
        },
    }

def _compute_payable_classifications(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[List[str], Dict[str, Any]]:
    shared = _compute_cross_sheet_classifications(sheet_map)
    return list(shared["payable_categories"]), dict(shared["payable_extra"])

def _compute_final_detail_classifications(sheet_map: Mapping[str, pd.DataFrame]) -> Tuple[List[str], Dict[str, Any]]:
    shared = _compute_cross_sheet_classifications(sheet_map)
    return list(shared["final_detail_categories"]), dict(shared["final_detail_extra"])
```

- [x] **Step 4: Run the focused restore tests and verify they pass**

Run: `python -m pytest tests/test_payable_final_detail_classification.py -k "restore_unique_exp_pair or ambiguous_restore_match or persist_restored_category" -v`

Expected: PASS for all three restore-focused tests.

- [x] **Step 5: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

### Task 3: Preserve Existing Classification Behavior And Telemetry

**Files:**
- Modify: `tests/test_payable_final_detail_classification.py:67-335`
- Modify: `check_finance.py:891-1023,1850-1945`

- [x] **Step 1: Add regression assertions proving non-restore behavior stays intact**

```python
    def test_compute_cross_sheet_classifications_does_not_restore_when_payable_is_tbd(self):
        sheet_map = self._build_restore_ready_sheet_map()
        sheet_map["Payable"].loc[0, "Cost Code"] = "1SF670"
        sheet_map["Final Detail"].loc[0, "Cost Code"] = "1SF670"
        sheet_map["Unit Budget"].iat[1, 11] = "2025-06-15"
        sheet_map["Scoping"] = pd.DataFrame(
            [
                ["", "", "Group Number", "", "GMP", "Fee", "WIP", "WTC", "GC", "TBD"],
                ["", "", 670, "", "", "", "", "", "", 6],
            ]
        )

        categories = cf._compute_cross_sheet_classifications(sheet_map)

        self.assertEqual(["TBD"], categories["payable_categories"])
        self.assertEqual(["TBD"], categories["final_detail_categories"])
        self.assertEqual(0, categories["restore_extra"]["restore_hit_count"])
```

Implementation note: this test guards the real boundary by forcing both initial categories into a valid non-`EXP` outcome through normal rules. Restore must never overwrite those results.

- [x] **Step 2: Merge restore telemetry into the existing sheet extra payloads**

```python
return categories, {
    "processed_rows": len(wsp),
    "classification_counts": classification_counts,
    "issue_counts": issue_counts,
    "issue_samples": issue_samples,
    "restore_hit_count": int(shared["restore_extra"]["restore_hit_count"]),
    "restore_samples": list(shared["restore_extra"]["restore_samples"]),
}
```

Apply the same merge pattern to the `Final Detail` extra payload, preserving `paired_racc_key_count`.

- [x] **Step 3: Run the full classification test file**

Run: `python -m pytest tests/test_payable_final_detail_classification.py -v`

Expected: PASS for both the pre-existing classification tests and the new restore tests.

- [x] **Step 4: Run a lightweight syntax check on the modified module**

Run: `python -m py_compile check_finance.py tests/test_payable_final_detail_classification.py`

Expected: command exits with code `0` and prints nothing.

- [x] **Step 5: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

## Self-Review

### Spec coverage
- Restore only runs after initial classification: covered by Task 2 Step 3 shared orchestrator.
- Restore only touches unique one-to-one `EXP` pairs: covered by Task 1 tests and Task 2 Step 2 implementation.
- Restore requires `GMP(1)`, `actual_settlement_date < Final Detail.Final Date`, and `Payable.Incurred Date <= Final Detail.Final Date`: covered by Task 2 Step 2 implementation.
- Result categories must be `Payable = RACC`, `Final Detail = ACC`: covered by Task 1 happy-path test and Task 2 Step 2 implementation.
- Non-`EXP` categories must remain untouched: covered by Task 3 Step 1 regression test.
- Restore telemetry must be exposed: covered by Task 1 write-back test and Task 3 Step 2 payload merge.

### Placeholder scan
- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Each code-changing step contains concrete code blocks.
- Each validation step contains an exact command and expected outcome.

### Type consistency
- Shared helper names are used consistently across tasks:
  - `_make_exp_restore_match_key`
  - `_apply_exp_restore_overrides`
  - `_compute_cross_sheet_classifications`
- The restore payload keys stay consistent throughout:
  - `restore_hit_count`
  - `restore_samples`
