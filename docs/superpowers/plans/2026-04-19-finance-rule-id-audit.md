# Finance Rule ID Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Lightly extract the finance classification core into its own module, then add auditable `Rule_ID` output to `Payable` and `Final Detail`, backed by a shared bilingual rule registry and decision structure, while preserving current classification behavior.

**Architecture:** First perform a low-risk pre-split by moving the finance classification core into `finance_classification.py`, while leaving Streamlit UI, Google Sheets sync, local draft handling, and `109` logic in `check_finance.py`. Then upgrade the extracted classification tree from raw category strings to structured decisions. The row-level classifiers will return `ClassificationDecision`, the cross-sheet restore pass will emit `R251` decisions, and the sheet writers will persist `Category` to column `A` and `Rule_ID` to column `B`. A separate bilingual manual document will mirror the same rule registry so auditors can trace each `Rule_ID` without reading Python.

**Tech Stack:** Python, pandas, dataclasses, unittest, Markdown

---

## File Structure

### Existing files to modify
- `check_finance.py`
  Responsibility: Streamlit app entrypoint, Google Sheets read/write, local draft handling, `109` logic, and outer sheet write-back integration.
- `tests/test_payable_final_detail_classification.py`
  Responsibility: unit coverage for decisions, `Rule_ID` write-back, restore `R251`, and regression safety.

### New files to create
- `finance_classification.py`
  Responsibility: finance classification core, shared rule registry, structured decisions, and cross-sheet restore orchestration.
- `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md`
  Responsibility: bilingual auditor-facing rule manual for the first 12 rules.

### Planned implementation boundaries
- Do not externalize rules to YAML in this phase.
- Do not write `reason` or `evidence` into Google Sheets in this phase.
- Do not widen the existing `EXP` restore rule beyond the current business window.
- Do not remove current issue sampling; instead, adapt it to consume `decision.warnings`.
- Do not split the Streamlit UI, Google Sheets sync layer, or `109` subsystem in this phase.

### Repository note
- This workspace currently has no `.git` directory, so every commit step in this plan becomes an explicit no-op check.

### Task 0: Light Pre-Split Of The Finance Classification Core

**Files:**
- Create: `finance_classification.py`
- Modify: `check_finance.py`
- Test: `tests/test_payable_final_detail_classification.py`

- [x] **Step 1: Create the new module and move the classification core without changing behavior**

Create `finance_classification.py` and move only these functions into it:

```python
_build_scoping_status_map
_classify_before_actual_settlement
_classify_payable_record
_classify_final_detail_record
_build_final_detail_classification_index
_apply_exp_restore_overrides
_merge_restore_extra
_build_classification_counts
_compute_cross_sheet_classifications
_compute_payable_classifications
_compute_payable_classifications_initial
_compute_final_detail_classifications
_compute_final_detail_classifications_initial
```

Also move any tightly coupled helper functions they require, if importing them from `check_finance.py` would create circular dependencies or awkward coupling. Keep this move minimal and classification-focused; do not move Streamlit, Google Sheets, draft, or `109` logic.

- [x] **Step 2: Re-export or import the moved functions in `check_finance.py`**

Near the imports in `check_finance.py`, add imports from the new module so the existing outer pipeline continues to call the same names:

```python
from finance_classification import (
    _apply_exp_restore_overrides,
    _build_classification_counts,
    _build_final_detail_classification_index,
    _build_scoping_status_map,
    _classify_before_actual_settlement,
    _classify_final_detail_record,
    _classify_payable_record,
    _compute_cross_sheet_classifications,
    _compute_final_detail_classifications,
    _compute_final_detail_classifications_initial,
    _compute_payable_classifications,
    _compute_payable_classifications_initial,
    _merge_restore_extra,
)
```

If importing all of those names is too broad, at minimum import the public classification entrypoints used later in this plan and keep the moved internals inside `finance_classification.py`.

- [x] **Step 3: Run the existing classification test file to verify the move is behavior-preserving**

Run:
`python3 -m unittest tests.test_payable_final_detail_classification`

Expected:
- existing tests still pass with no classification behavior changes

- [x] **Step 4: Run a lightweight syntax check**

Run:
`python3 -m py_compile check_finance.py finance_classification.py tests/test_payable_final_detail_classification.py`

Expected: success with no output

- [x] **Step 5: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

### Task 1: Add Failing Tests For Decision Objects And Rule IDs

**Files:**
- Modify: `finance_classification.py`
- Modify: `tests/test_payable_final_detail_classification.py`
- Reference: `finance_classification.py`, `check_finance.py:2052-2176`

- [x] **Step 1: Add a focused failing test for row-level decision metadata**

Append tests that expect `_classify_payable_record(...)` and `_classify_final_detail_record(...)` to return a structured object with `.category` and `.rule_id` instead of a tuple:

```python
    def test_classify_payable_returns_decision_with_rule_id(self):
        decision = cf._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF895",
            incurred_date="2025-01-15",
            statuses={1},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date=None,
            payable_racc_keys=set(),
        )

        self.assertEqual("ROE", decision.category)
        self.assertEqual("R101", decision.rule_id)

    def test_classify_final_detail_returns_decision_with_rule_id(self):
        pair_key = cf._make_final_detail_pair_key(
            vendor="GT Plumbing LLC",
            activity_no="30002",
            amount=4646,
            cost_code="2HD300",
        )

        decision = cf._classify_final_detail_record(
            unit_code="24407DD",
            vendor="GT Plumbing LLC",
            amount=4646,
            cost_code="2HD300",
            activity_no="30002",
            incurred_date="",
            final_date="2025-07-15",
            statuses={1},
            actual_settlement_date="2025-05-31",
            tbd_acceptance_date=None,
            paired_racc_keys={pair_key},
        )

        self.assertEqual("ACC", decision.category)
        self.assertEqual("R201", decision.rule_id)
```

- [x] **Step 2: Add a failing test for cross-sheet restore `R251` metadata**

```python
    def test_compute_cross_sheet_classifications_restores_with_r251_rule_id(self):
        categories = cf._compute_cross_sheet_classifications(self._build_restore_ready_sheet_map())

        self.assertEqual(["R251"], [d.rule_id for d in categories["payable_decisions"]])
        self.assertEqual(["R251"], [d.rule_id for d in categories["final_detail_decisions"]])
        self.assertEqual("RACC", categories["payable_decisions"][0].category)
        self.assertEqual("ACC", categories["final_detail_decisions"][0].category)
```

- [x] **Step 3: Add a failing writer test for `Rule_ID` in column B**

```python
    def test_process_sheet_writers_persist_rule_id_to_column_b(self):
        sheet_map = self._build_restore_ready_sheet_map()

        payable_out, _ = cf._process_payable_py(sheet_map)
        final_out, _ = cf._process_final_detail_py(sheet_map)

        self.assertEqual("R251", payable_out["Payable"].iloc[0, 1])
        self.assertEqual("R251", final_out["Final Detail"].iloc[0, 1])
```

- [x] **Step 4: Run the new tests and confirm they fail**

Run:
`python3 -m unittest tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_classify_payable_returns_decision_with_rule_id tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_classify_final_detail_returns_decision_with_rule_id tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_compute_cross_sheet_classifications_restores_with_r251_rule_id tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_process_sheet_writers_persist_rule_id_to_column_b`

Expected:
- row-level tests fail because the classifiers still return tuples
- restore decision test fails because `_compute_cross_sheet_classifications(...)` still returns category strings, not decisions
- writer test fails because column `B` is not populated with `Rule_ID`

- [x] **Step 5: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

### Task 2: Add Rule Registry And Structured Decision Returns

**Files:**
- Modify: `finance_classification.py`
- Test: `tests/test_payable_final_detail_classification.py`

- [x] **Step 1: Add the shared decision dataclass and registry helper near the top of `finance_classification.py`**

```python
@dataclass(frozen=True)
class ClassificationDecision:
    category: str
    rule_id: str
    reason_zh: str
    reason_en: str
    evidence: Mapping[str, Any]
    warnings: tuple[str, ...] = ()


RULE_REGISTRY: Dict[str, Dict[str, Any]] = {
    "R101": {
        "category": "ROE",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日前，命中 GMP，归类为 ROE",
        "reason_en": "Before settlement, GMP hit, classify as ROE",
        "manual_evidence_zh": "检查实际结算日、事件日期与 GMP 状态",
        "manual_evidence_en": "Check actual settlement date, event date, and GMP status",
    },
    "R102": {
        "category": "Income",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日前，命中 GMP+Fee 且 Vendor 为 WPRED，归类为 Income",
        "reason_en": "Before settlement, GMP+Fee hit and vendor is WPRED, classify as Income",
        "manual_evidence_zh": "检查 Group 1/2 状态与 Vendor",
        "manual_evidence_en": "Check Group 1/2 status and vendor",
    },
    "R103": {
        "category": "GC",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日前，命中 GMP+GC，归类为 GC",
        "reason_en": "Before settlement, GMP+GC hit, classify as GC",
        "manual_evidence_zh": "检查 Group 1/5 状态",
        "manual_evidence_en": "Check Group 1/5 status",
    },
    "R104": {
        "category": "Consulting",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日前，命中 WTC 且 Vendor 为 Consulting 实体",
        "reason_en": "Before settlement, WTC hit and vendor is the consulting entity",
        "manual_evidence_zh": "检查 Group 4 状态与 Vendor",
        "manual_evidence_en": "Check Group 4 status and vendor",
    },
    "R105": {
        "category": "Direct",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日前，未命中 GMP 特殊路径，回落为 Direct",
        "reason_en": "Before settlement, no GMP-specific path matched, fallback to Direct",
        "manual_evidence_zh": "检查结算日前分支与 Scoping 状态",
        "manual_evidence_en": "Check before-settlement branch and scoping statuses",
    },
    "R106": {
        "category": "GC",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "Unit Code 文本命中 General Condition，优先归类为 GC",
        "reason_en": "Unit Code text hits General Condition, classify as GC by priority",
        "manual_evidence_zh": "检查 Unit Code 文本",
        "manual_evidence_en": "Check Unit Code text",
    },
    "R201": {
        "category": "ACC",
        "sheet_scope": ("Final Detail",),
        "reason_zh": "结算日后，命中 ACC 配对规则",
        "reason_en": "After settlement, ACC match rule triggered",
        "manual_evidence_zh": "检查 Final Date、Incurred Date 为空及 Group 1",
        "manual_evidence_en": "Check Final Date, blank Incurred Date, and Group 1",
    },
    "R202": {
        "category": "RACC",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日后，命中 RACC 配对规则",
        "reason_en": "After settlement, RACC match rule triggered",
        "manual_evidence_zh": "检查跨表或表内配对键",
        "manual_evidence_en": "Check cross-sheet or intra-sheet pairing keys",
    },
    "R203": {
        "category": "TBD",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日后，命中 TBD 条件，归类为 TBD",
        "reason_en": "After settlement, TBD condition matched, classify as TBD",
        "manual_evidence_zh": "检查 TBD Acceptance Date 与 Group 6",
        "manual_evidence_en": "Check TBD Acceptance Date and Group 6",
    },
    "R204": {
        "category": "EXP",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日后，未命中 ACC / RACC / TBD，回落为 EXP",
        "reason_en": "After settlement, no ACC / RACC / TBD match, fallback to EXP",
        "manual_evidence_zh": "检查实际结算日、事件日期与各分类命中结果",
        "manual_evidence_en": "Check actual settlement date, event date, and downstream classification matches",
    },
    "R205": {
        "category": "EXP",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "结算日后，TBD 日期缺失，保守回落为 EXP",
        "reason_en": "After settlement, TBD date missing, conservatively fallback to EXP",
        "manual_evidence_zh": "检查 Group 6 且 TBD Acceptance Date 缺失",
        "manual_evidence_en": "Check Group 6 with missing TBD Acceptance Date",
    },
    "R251": {
        "category": "RACC/ACC",
        "sheet_scope": ("Payable", "Final Detail"),
        "reason_zh": "因 Final Date 窗口触发 EXP 特殊还原",
        "reason_en": "EXP restored by Final Date window exception",
        "manual_evidence_zh": "检查同 Unit、唯一匹配、初始双边 EXP 与 Final Date 窗口",
        "manual_evidence_en": "Check same unit, unique match, initial EXP on both sides, and the Final Date window",
    },
}


def _decision(
    rule_id: str,
    evidence: Mapping[str, Any],
    warnings: Sequence[str] = (),
) -> ClassificationDecision:
    rule = RULE_REGISTRY[rule_id]
    return ClassificationDecision(
        category=str(rule["category"]),
        rule_id=rule_id,
        reason_zh=str(rule["reason_zh"]),
        reason_en=str(rule["reason_en"]),
        evidence=dict(evidence),
        warnings=tuple(str(item) for item in warnings),
    )
```

- [x] **Step 2: Convert `_classify_payable_record(...)` to return `ClassificationDecision`**

Replace raw tuple returns with `_decision(...)`, preserving current behavior. For example:

```python
def _classify_payable_record(
    unit_code: Any,
    vendor: Any,
    amount: Any,
    cost_code: Any,
    incurred_date: Any,
    statuses: set[int],
    actual_settlement_date: Any,
    tbd_acceptance_date: Any,
    payable_racc_keys: set[Tuple[str, float, str, str]],
) -> ClassificationDecision:
    if _contains_general_condition(unit_code):
        return _decision("R106", {"unit_code": _safe_string(unit_code)})

    actual_dt = _normalize_date_value(actual_settlement_date)
    if actual_dt is None:
        rule_id = "R102" if 1 in statuses and 2 in statuses and _safe_string(vendor) == "Wan Pacific Real Estate Development LLC" else \
                  "R103" if 1 in statuses and 5 in statuses else \
                  "R101" if 1 in statuses else \
                  "R104" if 4 in statuses and _safe_string(vendor) == "WB Texas Consulting LLC" else \
                  "R105"
        return _decision(
            rule_id,
            {
                "unit_code": _safe_string(unit_code),
                "vendor": _safe_string(vendor),
                "statuses": sorted(statuses),
                "actual_settlement_date": "",
                "incurred_date": _format_iso_date_or_blank(incurred_date),
            },
            warnings=("assumed_unsettled_missing_actual_settlement_date",),
        )

    incurred_dt = _normalize_date_value(incurred_date)
    if incurred_dt is None:
        return _decision(
            "R204",
            {
                "unit_code": _safe_string(unit_code),
                "vendor": _safe_string(vendor),
                "statuses": sorted(statuses),
                "actual_settlement_date": actual_dt.strftime("%Y-%m-%d"),
                "incurred_date": "",
            },
            warnings=("missing_incurred_date",),
        )
```

Continue the same pattern for `R101`, `R102`, `R103`, `R104`, `R105`, `R202`, `R203`, `R204`, and `R205`.

- [x] **Step 3: Convert `_classify_final_detail_record(...)` to return `ClassificationDecision`**

Preserve the current branch behavior while mapping to `R106`, `R101`, `R102`, `R103`, `R104`, `R105`, `R201`, `R202`, `R203`, `R204`, and `R205`. For the `ACC`/`RACC` branches, include evidence payloads that capture the key matching fields:

```python
return _decision(
    "R201",
    {
        "unit_code": _safe_string(unit_code),
        "vendor": _safe_string(vendor),
        "activity_no": _safe_string(activity_no),
        "amount": _normalize_amount_key(amount),
        "cost_code": _safe_string(cost_code),
        "final_date": _format_iso_date_or_blank(final_date),
        "incurred_date": _format_iso_date_or_blank(incurred_date),
    },
)
```

Use the analogous evidence structure for `R202`.

- [x] **Step 4: Run the new decision tests and any impacted existing cases**

Run:
`python3 -m unittest tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_classify_payable_returns_decision_with_rule_id tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_classify_final_detail_returns_decision_with_rule_id`

Expected: PASS

- [x] **Step 5: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

### Task 3: Upgrade Cross-Sheet Restore And Sheet Writers To Decisions

**Files:**
- Modify: `finance_classification.py`
- Modify: `check_finance.py:2052-2176`
- Modify: `tests/test_payable_final_detail_classification.py`

- [x] **Step 1: Refactor initial classification helpers to produce decision lists**

Change `_compute_payable_classifications_initial(...)` and `_compute_final_detail_classifications_initial(...)` to accumulate `ClassificationDecision` instead of plain categories:

```python
decisions: List[ClassificationDecision] = []

for i in range(len(wsp)):
    decision = _classify_payable_record(...)
    decisions.append(decision)
    classification_counts[decision.category or "(blank)"] = (
        classification_counts.get(decision.category or "(blank)", 0) + 1
    )
    for issue in decision.warnings:
        issue_counts[issue] = issue_counts.get(issue, 0) + 1
```

Return:

```python
return decisions, {
    "processed_rows": len(wsp),
    "classification_counts": classification_counts,
    "issue_counts": issue_counts,
    "issue_samples": issue_samples,
}
```

- [x] **Step 2: Make `_apply_exp_restore_overrides(...)` return adjusted decisions with `R251`**

Replace string mutation with `ClassificationDecision` mutation:

```python
def _apply_exp_restore_overrides(
    wsp: pd.DataFrame,
    wsf: pd.DataFrame,
    payable_decisions: Sequence[ClassificationDecision],
    final_detail_decisions: Sequence[ClassificationDecision],
    scoping_status_map: Mapping[int, set[int]],
    unit_schedule_map: Mapping[str, Mapping[str, pd.Timestamp | None]],
) -> Tuple[List[ClassificationDecision], List[ClassificationDecision], int, List[Dict[str, Any]]]:
    adjusted_payable = list(payable_decisions)
    adjusted_final_detail = list(final_detail_decisions)
    ...
    if payable_item["unit_code"] != final_item["unit_code"]:
        continue
    if adjusted_payable[payable_item["index"]].category != "EXP":
        continue
    if adjusted_final_detail[final_item["index"]].category != "EXP":
        continue
    ...
    shared_evidence = {
        "unit_code": final_item["unit_code"],
        "vendor": payable_item["vendor"],
        "amount": payable_item["amount"],
        "cost_code": payable_item["cost_code"],
        "payable_key": key,
        "payable_incurred_date": payable_incurred_dt.strftime("%Y-%m-%d"),
        "final_detail_final_date": final_dt.strftime("%Y-%m-%d"),
        "actual_settlement_date": actual_dt.strftime("%Y-%m-%d"),
    }
    adjusted_payable[payable_item["index"]] = _decision("R251", {**shared_evidence, "restored_category": "RACC"})
    adjusted_final_detail[final_item["index"]] = _decision("R251", {**shared_evidence, "restored_category": "ACC"})
```

- [x] **Step 3: Upgrade `_compute_cross_sheet_classifications(...)` to return decisions and final counts**

```python
def _build_classification_counts_from_decisions(
    decisions: Sequence[ClassificationDecision],
) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for decision in decisions:
        counts[decision.category or "(blank)"] = counts.get(decision.category or "(blank)", 0) + 1
    return counts


def _compute_cross_sheet_classifications(sheet_map: Mapping[str, pd.DataFrame]) -> Dict[str, Any]:
    ...
    payable_decisions_initial, payable_extra = _compute_payable_classifications_initial(...)
    final_detail_decisions_initial, final_detail_extra = _compute_final_detail_classifications_initial(...)
    payable_decisions, final_detail_decisions, restore_hit_count, restore_samples = _apply_exp_restore_overrides(...)

    payable_extra = dict(payable_extra)
    final_detail_extra = dict(final_detail_extra)
    payable_extra["classification_counts"] = _build_classification_counts_from_decisions(payable_decisions)
    final_detail_extra["classification_counts"] = _build_classification_counts_from_decisions(final_detail_decisions)
    payable_extra["restore_hit_count"] = restore_hit_count
    payable_extra["restore_samples"] = restore_samples
    final_detail_extra["restore_hit_count"] = restore_hit_count
    final_detail_extra["restore_samples"] = restore_samples

    return {
        "payable_decisions": payable_decisions,
        "final_detail_decisions": final_detail_decisions,
        "payable_categories": [decision.category for decision in payable_decisions],
        "final_detail_categories": [decision.category for decision in final_detail_decisions],
        "payable_extra": payable_extra,
        "final_detail_extra": final_detail_extra,
        "restore_extra": {
            "restore_hit_count": restore_hit_count,
            "restore_samples": restore_samples,
        },
    }
```

- [x] **Step 4: Update sheet writers to persist `Rule_ID` in column B**

In `_process_payable_py(...)`:

```python
    cross_sheet = _compute_cross_sheet_classifications(out)
    payable_decisions = list(cross_sheet["payable_decisions"])
    if len(payable_decisions) == len(wsp):
        first_col = wsp.columns[0]
        wsp[first_col] = [decision.category for decision in payable_decisions]
        wsp = _set_cell(wsp, 0, 2, "Rule_ID") if len(wsp) == 0 else wsp
        second_col_name = wsp.columns[1] if len(wsp.columns) > 1 else None
        if second_col_name is None:
            wsp = _ensure_column_count(wsp, 2)
            second_col_name = wsp.columns[1]
        wsp[second_col_name] = [decision.rule_id for decision in payable_decisions]
```

Use the same pattern in `_process_final_detail_py(...)`.

If the DataFrame already has a second column, overwrite it with the computed `Rule_ID` values for consistency in this phase.

- [x] **Step 5: Run the restore and writer tests**

Run:
`python3 -m unittest tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_compute_cross_sheet_classifications_restores_with_r251_rule_id tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_process_sheet_writers_persist_rule_id_to_column_b tests.test_payable_final_detail_classification.PayableFinalDetailClassificationTests.test_compute_cross_sheet_classifications_skips_restore_when_units_differ`

Expected: PASS

- [x] **Step 6: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

### Task 4: Create The Bilingual Audit Manual And Run Final Verification

**Files:**
- Create: `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md`
- Modify: `tests/test_payable_final_detail_classification.py`
- Verify: `check_finance.py`, `finance_classification.py`

- [x] **Step 1: Create the bilingual manual covering the first 12 rules**

Create `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md` with this structure:

```markdown
# Finance Rule ID Manual

日期：`2026-04-19`

## R101
- Category: `ROE`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算日前，命中 GMP，归类为 ROE
- English Reason: Before settlement, GMP hit, classify as ROE
- 中文证据说明：检查实际结算日、事件日期与 GMP 状态
- English Evidence: Check actual settlement date, event date, and GMP status
- 典型字段 / Key Fields: `Unit Code`, `Cost Code`, `Incurred Date`, `statuses`

## R102
- Category: `Income`
- Sheet Scope: `Payable / Final Detail`
- 中文判定依据：结算日前，命中 GMP+Fee 且 Vendor 为 WPRED，归类为 Income
- English Reason: Before settlement, GMP+Fee hit and vendor is WPRED, classify as Income
- 中文证据说明：检查 Group 1/2 状态与 Vendor
- English Evidence: Check Group 1/2 status and vendor
- 典型字段 / Key Fields: `Vendor`, `Cost Code`, `statuses`
```

Continue the same pattern through:
- `R103`
- `R104`
- `R105`
- `R106`
- `R201`
- `R202`
- `R203`
- `R204`
- `R205`
- `R251`

For `R251`, the evidence section must explicitly mention:
- same unit
- unique match
- initial `EXP` on both sides
- Final Date window
- retained cross-sheet key

- [x] **Step 2: Add a final regression test that row-level categories remain unchanged**

Append a narrow regression that checks one known case per major branch still resolves to the same category as before, while now exposing `rule_id`:

```python
    def test_existing_category_outcomes_are_preserved_after_rule_id_upgrade(self):
        payable_decision = cf._classify_payable_record(
            unit_code="14403DD",
            vendor="Other Vendor",
            amount=100,
            cost_code="1SF895",
            incurred_date="2025-01-15",
            statuses={1},
            actual_settlement_date="2025-02-01",
            tbd_acceptance_date=None,
            payable_racc_keys=set(),
        )
        final_decision = cf._classify_final_detail_record(
            unit_code="24407DD",
            vendor="GT Plumbing LLC",
            amount=4646,
            cost_code="2HD300",
            activity_no="30002",
            incurred_date="",
            final_date="2025-07-15",
            statuses={1},
            actual_settlement_date="2025-05-31",
            tbd_acceptance_date=None,
            paired_racc_keys={cf._make_final_detail_pair_key("GT Plumbing LLC", "30002", 4646, "2HD300")},
        )

        self.assertEqual("ROE", payable_decision.category)
        self.assertEqual("ACC", final_decision.category)
```

- [x] **Step 3: Run the full classification test file**

Run:
`python3 -m unittest tests.test_payable_final_detail_classification`

Expected:
- all existing classification tests still pass
- new decision/rule-id/writer/manual-support tests pass

- [x] **Step 4: Run a lightweight syntax check**

Run:
`python3 -m py_compile check_finance.py tests/test_payable_final_detail_classification.py`

Expected: success with no output

Also run:
`python3 -m py_compile finance_classification.py`

Expected: success with no output

- [x] **Step 5: Verify the manual file exists**

Run:
`python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md').exists())\nPY`

Expected: `True`

- [x] **Step 6: Skip commit explicitly because this workspace is not a git repository**

Run: `test ! -d .git && echo "skip commit: no git repo"`

Expected: `skip commit: no git repo`

## Self-Review

### Spec coverage
- Finance classification core is lightly extracted before the audit upgrade: covered by Task 0.
- Sheet output restricted to `Category + Rule_ID`: covered by Task 3 Step 4.
- Shared `Rule_ID` system across `Payable` and `Final Detail`: covered by Task 2 Step 1 registry and Task 3 Step 2 restore upgrade.
- Bilingual audit manual: covered by Task 4 Step 1.
- First phase limited to the minimum 12 rules: covered by Task 2 Step 1 registry and Task 4 Step 1 manual.
- `ACC / RACC / R251` preserve evidence tracing: covered by Task 2 Step 3 and Task 3 Step 2.
- Existing category behavior remains intact: covered by Task 4 Step 2 and the full test run in Task 4 Step 3.

### Placeholder scan
- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Every code-changing step includes concrete code.
- Every verification step includes an exact command and expected outcome.

### Type consistency
- Shared types and helpers remain consistent throughout:
  - `finance_classification.py`
  - `ClassificationDecision`
  - `RULE_REGISTRY`
  - `_decision(...)`
  - `_compute_cross_sheet_classifications(...)`
- The final payload shape stays consistent:
  - `payable_decisions`
  - `final_detail_decisions`
  - `payable_extra`
  - `final_detail_extra`
  - `restore_extra`
