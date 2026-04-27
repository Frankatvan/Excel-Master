# Single Python Package Before Final GMP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the duplicated finance Python logic into one canonical package, then implement Final GMP as the only GMP basis for reclassification while preserving old GMP for budget logic.

**Architecture:** Create a real importable package at `excel-master-app/api/logic/aiwb_finance/` and make all legacy `finance_*.py` entrypoints thin wrappers that re-export from that package. Reconcile existing drift before wrapping, add import and manifest tests to prevent future drift, then implement Final GMP in the single canonical logic path.

**Tech Stack:** Python 3, pandas, pytest, Next.js API serverless Python handlers, Google Sheets API, Jest/ts-jest for frontend/manual-input tests.

---

## File Structure

Canonical package:

- Create: `excel-master-app/api/logic/aiwb_finance/__init__.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_classification.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_engine.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_formatting.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_formulas.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_mapping.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_services.py`
- Create: `excel-master-app/api/logic/aiwb_finance/finance_utils.py`

Compatibility loaders and wrappers:

- Create: `aiwb_logic_loader.py`
- Create: `api/logic/aiwb_logic_loader.py`
- Modify: root `finance_classification.py`, `finance_engine.py`, `finance_formatting.py`, `finance_formulas.py`, `finance_mapping.py`, `finance_services.py`, `finance_utils.py`
- Modify: mirror `api/logic/finance_classification.py`, `api/logic/finance_engine.py`, `api/logic/finance_formatting.py`, `api/logic/finance_formulas.py`, `api/logic/finance_mapping.py`, `api/logic/finance_services.py`, `api/logic/finance_utils.py`
- Modify: production flat wrappers `excel-master-app/api/logic/finance_classification.py`, `excel-master-app/api/logic/finance_engine.py`, `excel-master-app/api/logic/finance_formatting.py`, `excel-master-app/api/logic/finance_formulas.py`, `excel-master-app/api/logic/finance_mapping.py`, `excel-master-app/api/logic/finance_services.py`, `excel-master-app/api/logic/finance_utils.py`

Runtime import updates:

- Modify: `excel-master-app/api/internal/reclassify_job.py`
- Modify: `excel-master-app/api/formula_sync.py`
- Modify: `excel-master-app/api/project_bootstrap.py`
- Modify: `excel-master-app/api/verify_api.py`
- Modify mirror API files only if still kept as local compatibility handlers: `api/formula_sync.py`, `api/project_bootstrap.py`, `api/verify_api.py`

Final GMP logic:

- Modify: `excel-master-app/api/logic/aiwb_finance/finance_services.py`
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_engine.py`
- Modify: `excel-master-app/src/lib/audit-manual-input.ts`
- Modify: `excel-master-app/src/lib/audit-dashboard.ts`
- Modify: `excel-master-app/src/lib/reclass-rules.ts`
- Modify: `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md`
- Modify: `docs/AiWB_财务人员操作说明_v1.0.md`

Tests:

- Create: `tests/test_single_finance_package_imports.py`
- Create: `tests/test_reclassify_manifest_hash.py`
- Create: `tests/test_final_gmp_classification.py`
- Modify: `tests/test_payable_final_detail_classification.py`
- Modify: `tests/test_scoping_controls.py`
- Modify: `tests/test_classification_settlement_boundary.py`
- Modify: `excel-master-app/src/__tests__/audit-manual-input.test.ts`
- Modify: `excel-master-app/src/__tests__/workbench-phase1.test.tsx`

## Task 1: Add Failing Tests For Package Canonicalization

**Files:**
- Create: `tests/test_single_finance_package_imports.py`
- Create: `tests/test_reclassify_manifest_hash.py`

- [ ] **Step 1: Write failing import canonicalization tests**

Create `tests/test_single_finance_package_imports.py`:

```python
from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CANONICAL_LOGIC_DIR = ROOT / "excel-master-app" / "api" / "logic"


def run_python(code: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_canonical_aiwb_finance_package_imports_all_public_modules():
    code = f"""
import sys
from pathlib import Path
sys.path.insert(0, {str(CANONICAL_LOGIC_DIR)!r})
mods = [
    "aiwb_finance.finance_classification",
    "aiwb_finance.finance_engine",
    "aiwb_finance.finance_formatting",
    "aiwb_finance.finance_formulas",
    "aiwb_finance.finance_mapping",
    "aiwb_finance.finance_services",
    "aiwb_finance.finance_utils",
]
for name in mods:
    __import__(name)
print("ok")
"""
    result = run_python(code)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_root_legacy_imports_reexport_canonical_objects():
    code = f"""
import sys
from pathlib import Path
sys.path.insert(0, {str(ROOT)!r})
import finance_services
from aiwb_finance.finance_services import ClassificationService as CanonicalClassificationService
assert finance_services.ClassificationService is CanonicalClassificationService
import finance_classification
from aiwb_finance.finance_classification import compute_payable_classifications
assert finance_classification.compute_payable_classifications is compute_payable_classifications
print("ok")
"""
    result = run_python(code)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"


def test_api_logic_legacy_imports_reexport_canonical_objects():
    code = f"""
import sys
from pathlib import Path
sys.path.insert(0, {str(ROOT / "api" / "logic")!r})
import finance_services
from aiwb_finance.finance_services import ClassificationService as CanonicalClassificationService
assert finance_services.ClassificationService is CanonicalClassificationService
import finance_engine
from aiwb_finance.finance_engine import _build_scoping_manual_input_ranges
assert finance_engine._build_scoping_manual_input_ranges is _build_scoping_manual_input_ranges
print("ok")
"""
    result = run_python(code)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "ok"
```

- [ ] **Step 2: Write failing manifest coverage test**

Create `tests/test_reclassify_manifest_hash.py`:

```python
from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "excel-master-app" / "api" / "internal" / "reclassify_job.py"


def load_worker_module():
    spec = importlib.util.spec_from_file_location("reclassify_job_manifest_test", WORKER_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_manifest_hash_includes_classification_service_and_utils(monkeypatch):
    module = load_worker_module()
    captured_paths = []
    original_read_bytes = Path.read_bytes

    def recording_read_bytes(self: Path) -> bytes:
        captured_paths.append(self)
        return original_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", recording_read_bytes)
    digest = module._compute_code_manifest_hash()

    assert digest
    rel_paths = {
        str(path.relative_to(ROOT))
        for path in captured_paths
        if path.is_relative_to(ROOT)
    }
    assert "excel-master-app/api/logic/aiwb_finance/finance_services.py" in rel_paths
    assert "excel-master-app/api/logic/aiwb_finance/finance_utils.py" in rel_paths
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
python3 -m pytest tests/test_single_finance_package_imports.py tests/test_reclassify_manifest_hash.py -q
```

Expected: FAIL because `aiwb_finance` does not exist and the worker manifest does not include canonical package files.

- [ ] **Step 4: Commit failing tests**

```bash
git add tests/test_single_finance_package_imports.py tests/test_reclassify_manifest_hash.py
git commit -m "test: pin single finance package import contract"
```

## Task 2: Create Canonical `aiwb_finance` Package

**Files:**
- Create: `excel-master-app/api/logic/aiwb_finance/*`
- Modify: package module imports after copying

- [ ] **Step 1: Create package directory and copy current production modules**

Run:

```bash
mkdir -p excel-master-app/api/logic/aiwb_finance
cp excel-master-app/api/logic/finance_classification.py excel-master-app/api/logic/aiwb_finance/finance_classification.py
cp excel-master-app/api/logic/finance_engine.py excel-master-app/api/logic/aiwb_finance/finance_engine.py
cp excel-master-app/api/logic/finance_formatting.py excel-master-app/api/logic/aiwb_finance/finance_formatting.py
cp excel-master-app/api/logic/finance_formulas.py excel-master-app/api/logic/aiwb_finance/finance_formulas.py
cp excel-master-app/api/logic/finance_mapping.py excel-master-app/api/logic/aiwb_finance/finance_mapping.py
cp excel-master-app/api/logic/finance_services.py excel-master-app/api/logic/aiwb_finance/finance_services.py
cp excel-master-app/api/logic/finance_utils.py excel-master-app/api/logic/aiwb_finance/finance_utils.py
```

- [ ] **Step 2: Add package `__init__.py`**

Create `excel-master-app/api/logic/aiwb_finance/__init__.py`:

```python
"""Canonical AiWB finance logic package.

All legacy finance_*.py modules in the repository should re-export from this
package instead of carrying business logic copies.
"""

__all__ = [
    "finance_classification",
    "finance_engine",
    "finance_formatting",
    "finance_formulas",
    "finance_mapping",
    "finance_services",
    "finance_utils",
]
```

- [ ] **Step 3: Convert package imports to relative imports**

In `excel-master-app/api/logic/aiwb_finance/finance_classification.py`, replace:

```python
from finance_services import ClassificationService, RULE_REGISTRY, ClassificationDecision
import finance_engine as fe
import finance_utils as fu
```

with:

```python
from .finance_services import ClassificationService, RULE_REGISTRY, ClassificationDecision
from . import finance_engine as fe
from . import finance_utils as fu
```

In `excel-master-app/api/logic/aiwb_finance/finance_engine.py`, replace:

```python
from finance_mapping import MapperFactory
from finance_formulas import FinanceFormulaGenerator, FormulaTemplateResolver, MappingIncompleteError
from finance_formatting import SemanticFormattingEngine
from finance_mapping import (
```

with:

```python
from .finance_mapping import MapperFactory
from .finance_formulas import FinanceFormulaGenerator, FormulaTemplateResolver, MappingIncompleteError
from .finance_formatting import SemanticFormattingEngine
from .finance_mapping import (
```

Replace:

```python
from finance_utils import (
```

with:

```python
from .finance_utils import (
```

Replace local imports inside functions:

```python
from finance_classification import compute_payable_classifications
from finance_classification import compute_final_detail_classifications
from finance_engine import _ensure_unit_budget_actual_settlement_columns, _refresh_unit_budget_actual_settlement_columns, _sync_unit_master_sheet, _apply_unit_budget_support_formatting, _ensure_109_contract_amount_row
```

with:

```python
from .finance_classification import compute_payable_classifications
from .finance_classification import compute_final_detail_classifications
from .finance_engine import _ensure_unit_budget_actual_settlement_columns, _refresh_unit_budget_actual_settlement_columns, _sync_unit_master_sheet, _apply_unit_budget_support_formatting, _ensure_109_contract_amount_row
```

In `excel-master-app/api/logic/aiwb_finance/finance_formulas.py`, replace:

```python
from finance_mapping import ExcelSemanticMapper
from finance_utils import column_index_to_letter
```

with:

```python
from .finance_mapping import ExcelSemanticMapper
from .finance_utils import column_index_to_letter
```

In `excel-master-app/api/logic/aiwb_finance/finance_formatting.py`, replace:

```python
from finance_mapping import ExcelSemanticMapper
```

with:

```python
from .finance_mapping import ExcelSemanticMapper
```

- [ ] **Step 4: Run canonical package import test**

Run:

```bash
python3 -m pytest tests/test_single_finance_package_imports.py::test_canonical_aiwb_finance_package_imports_all_public_modules -q
```

Expected: PASS.

- [ ] **Step 5: Commit canonical package creation**

```bash
git add excel-master-app/api/logic/aiwb_finance tests/test_single_finance_package_imports.py
git commit -m "refactor: create canonical aiwb finance package"
```

## Task 3: Reconcile Current Drift Into Canonical Package

**Files:**
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_services.py`
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_formulas.py`
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_utils.py`
- Test: existing classification and date tests

- [ ] **Step 1: Preserve accepted standalone restore behavior**

Update canonical `finance_services.py` so R301/R302 metadata and restore behavior match the root version:

```python
"R301": {
    "category": "RACC",
    "reason_zh": "Restore: 结算前后窗口修正（Payable 端，独立判定）",
    "reason_en": "Restore: Settlement-window correction for Payable side (standalone)",
    "semantics": "restore_payable_racc",
    "sheet_scope": ("Payable",),
},
"R302": {
    "category": "ACC",
    "reason_zh": "Restore: 结算前后窗口修正（Final Detail 端，独立判定）",
    "reason_en": "Restore: Settlement-window correction for Final Detail side (standalone)",
    "semantics": "restore_final_detail_acc",
    "sheet_scope": ("Final Detail",),
},
```

Change `compute()` so `_apply_exp_restore_overrides(...)` returns `restore_extra`:

```python
payable_decisions, final_detail_decisions, restore_extra = self._apply_exp_restore_overrides(
    self.wsp,
    self.wsf,
    payable_decisions_initial,
    final_detail_decisions_initial,
    self.scoping_status_map,
    self.unit_schedule_map,
)
```

Use the root `finance_services.py` restore implementation as the source for `_apply_exp_restore_overrides`, including:

```python
payable_restore_hit_count
final_detail_restore_hit_count
payable_missing_final_detail_count
final_detail_missing_payable_count
restore_match_status
```

Do not bring in the `api/logic/finance_services.py` 2026 hard settlement boundary. The canonical logic should keep the actual-settlement-date boundary behavior already verified by `tests/test_classification_settlement_boundary.py`.

- [ ] **Step 2: Preserve dynamic formula year-column behavior**

Update canonical `finance_formulas.py` to keep the production/root dynamic year-column behavior:

```python
self.primary_year_columns = self._resolve_year_columns(
    self.config.get("primary_year_cols"),
    PRIMARY_109_YEAR_COLUMNS,
)
self.audit_year_columns = self._resolve_year_columns(
    self.config.get("audit_year_cols"),
    AUDIT_109_YEAR_COLUMNS,
)
self.start_year_anchor_ref = self._resolve_start_year_anchor_ref()
```

Keep `_resolve_year_columns`, `_resolve_start_year_anchor_ref`, and the `Year({self.start_year_anchor_ref})` usage.

- [ ] **Step 3: Keep production-safe utility credentials**

Ensure canonical `finance_utils.py` does not import `streamlit` and supports:

```python
GOOGLE_CREDENTIALS_JSON
GOOGLE_APPLICATION_CREDENTIALS
GOOGLE_TYPE / GOOGLE_PROJECT_ID / GOOGLE_PRIVATE_KEY / GOOGLE_CLIENT_EMAIL
```

Do not copy Streamlit-specific credential code from the root file into the canonical package.

- [ ] **Step 4: Run drift-sensitive existing tests against canonical imports after wrappers are added**

Defer this run until Task 4 wrappers exist. For now run direct package import:

```bash
python3 -m py_compile excel-master-app/api/logic/aiwb_finance/finance_services.py excel-master-app/api/logic/aiwb_finance/finance_formulas.py excel-master-app/api/logic/aiwb_finance/finance_utils.py
```

Expected: PASS.

- [ ] **Step 5: Commit drift reconciliation**

```bash
git add excel-master-app/api/logic/aiwb_finance/finance_services.py excel-master-app/api/logic/aiwb_finance/finance_formulas.py excel-master-app/api/logic/aiwb_finance/finance_utils.py
git commit -m "refactor: reconcile canonical finance logic drift"
```

## Task 4: Replace Legacy Logic Copies With Compatibility Wrappers

**Files:**
- Create: `aiwb_logic_loader.py`
- Create: `api/logic/aiwb_logic_loader.py`
- Modify: all legacy `finance_*.py` files listed in File Structure

- [ ] **Step 1: Add root compatibility loader**

Create `aiwb_logic_loader.py`:

```python
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType
from typing import MutableMapping


ROOT = Path(__file__).resolve().parent
CANONICAL_LOGIC_DIR = ROOT / "excel-master-app" / "api" / "logic"


def load_canonical(module_name: str) -> ModuleType:
    canonical_path = str(CANONICAL_LOGIC_DIR)
    if canonical_path not in sys.path:
        sys.path.insert(0, canonical_path)
    return importlib.import_module(f"aiwb_finance.{module_name}")


def reexport(globals_dict: MutableMapping[str, object], module_name: str) -> None:
    module = load_canonical(module_name)
    public_names = getattr(module, "__all__", None)
    if public_names is None:
        public_names = [name for name in vars(module) if not name.startswith("__")]
    for name in public_names:
        globals_dict[name] = getattr(module, name)
    globals_dict["__all__"] = list(public_names)
    globals_dict["__doc__"] = module.__doc__
```

- [ ] **Step 2: Add API mirror compatibility loader**

Create `api/logic/aiwb_logic_loader.py`:

```python
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType
from typing import MutableMapping


ROOT = Path(__file__).resolve().parents[2]
CANONICAL_LOGIC_DIR = ROOT / "excel-master-app" / "api" / "logic"


def load_canonical(module_name: str) -> ModuleType:
    canonical_path = str(CANONICAL_LOGIC_DIR)
    if canonical_path not in sys.path:
        sys.path.insert(0, canonical_path)
    return importlib.import_module(f"aiwb_finance.{module_name}")


def reexport(globals_dict: MutableMapping[str, object], module_name: str) -> None:
    module = load_canonical(module_name)
    public_names = getattr(module, "__all__", None)
    if public_names is None:
        public_names = [name for name in vars(module) if not name.startswith("__")]
    for name in public_names:
        globals_dict[name] = getattr(module, name)
    globals_dict["__all__"] = list(public_names)
    globals_dict["__doc__"] = module.__doc__
```

- [ ] **Step 3: Replace each root legacy module with wrapper**

For `finance_services.py`, use:

```python
from aiwb_logic_loader import reexport

reexport(globals(), "finance_services")
```

For each other root module, use the matching module name:

```python
from aiwb_logic_loader import reexport

reexport(globals(), "finance_engine")
```

Apply the same pattern to:

- `finance_classification.py`
- `finance_engine.py`
- `finance_formatting.py`
- `finance_formulas.py`
- `finance_mapping.py`
- `finance_services.py`
- `finance_utils.py`

- [ ] **Step 4: Replace each `api/logic` mirror module with wrapper**

For `api/logic/finance_services.py`, use:

```python
from aiwb_logic_loader import reexport

reexport(globals(), "finance_services")
```

Apply the same pattern to all seven mirror modules.

- [ ] **Step 5: Replace production flat modules with local wrappers**

For `excel-master-app/api/logic/finance_services.py`, use:

```python
from aiwb_finance.finance_services import *  # noqa: F401,F403
```

For the other six production flat modules, import from the matching package module.

- [ ] **Step 6: Run wrapper tests**

Run:

```bash
python3 -m pytest tests/test_single_finance_package_imports.py -q
```

Expected: PASS.

- [ ] **Step 7: Run existing Python classification/control tests**

Run:

```bash
python3 -m pytest \
  tests/test_payable_final_detail_classification.py \
  tests/test_classification_settlement_boundary.py \
  tests/test_google_serial_date_parsing.py \
  tests/test_scoping_controls.py \
  tests/test_unit_master_controls.py \
  -q
```

Expected: PASS.

- [ ] **Step 8: Commit wrappers**

```bash
git add aiwb_logic_loader.py api/logic/aiwb_logic_loader.py finance_*.py api/logic/finance_*.py excel-master-app/api/logic/finance_*.py tests/test_single_finance_package_imports.py
git commit -m "refactor: route legacy finance imports to canonical package"
```

## Task 5: Update Runtime Imports And Manifest Hash

**Files:**
- Modify: `excel-master-app/api/internal/reclassify_job.py`
- Modify: `excel-master-app/api/formula_sync.py`
- Modify: `excel-master-app/api/project_bootstrap.py`
- Modify: `excel-master-app/api/verify_api.py`
- Test: `tests/test_reclassify_manifest_hash.py`, `excel-master-app/tests/test_reclassify_job.py`

- [ ] **Step 1: Update worker dependency imports**

In `excel-master-app/api/internal/reclassify_job.py`, change `_load_worker_dependencies()` to insert `excel-master-app/api/logic` and import from canonical package:

```python
from aiwb_finance.finance_engine import MappingService, build_dashboard_summary_payload
from aiwb_finance.finance_classification import compute_final_detail_classifications, compute_payable_classifications
from aiwb_finance.finance_mapping import resolve_sheet_field_columns_with_fallback
from aiwb_finance.finance_utils import (
    _find_col_in_headers,
    _find_col_in_row,
    _get_cell,
    _normalize_amount_key,
    _normalize_text_key,
    _safe_string,
    _sheet_key,
    _values_to_dataframe,
    get_sheets_service,
)
```

- [ ] **Step 2: Update serverless API imports**

In `excel-master-app/api/formula_sync.py`, replace:

```python
from finance_engine import (
```

with:

```python
from aiwb_finance.finance_engine import (
```

In `excel-master-app/api/project_bootstrap.py`, replace:

```python
from finance_engine import get_sheets_service, initialize_project_workbook, run_validate_input_data
from finance_utils import _get_service_account_info, _safe_string
```

with:

```python
from aiwb_finance.finance_engine import get_sheets_service, initialize_project_workbook, run_validate_input_data
from aiwb_finance.finance_utils import _get_service_account_info, _safe_string
```

In `excel-master-app/api/verify_api.py`, import `aiwb_finance.finance_engine`, `aiwb_finance.finance_utils`, and `aiwb_finance.finance_services` instead of flat modules.

- [ ] **Step 3: Include canonical package files in manifest hash**

In `_compute_code_manifest_hash`, replace the candidate list with:

```python
canonical_dir = base.parents[1] / "logic" / "aiwb_finance"
candidates: List[Path] = [
    base,
    canonical_dir / "__init__.py",
    canonical_dir / "finance_classification.py",
    canonical_dir / "finance_mapping.py",
    canonical_dir / "finance_formulas.py",
    canonical_dir / "finance_engine.py",
    canonical_dir / "finance_services.py",
    canonical_dir / "finance_utils.py",
    base.parents[2] / "docs" / "finance_semantic_config.yaml",
]
```

- [ ] **Step 4: Run manifest and worker tests**

Run:

```bash
python3 -m pytest tests/test_reclassify_manifest_hash.py excel-master-app/tests/test_reclassify_job.py -q
```

Expected: PASS.

- [ ] **Step 5: Run import compile checks**

Run:

```bash
python3 -m py_compile \
  excel-master-app/api/internal/reclassify_job.py \
  excel-master-app/api/formula_sync.py \
  excel-master-app/api/project_bootstrap.py \
  excel-master-app/api/verify_api.py
```

Expected: PASS.

- [ ] **Step 6: Commit runtime import updates**

```bash
git add excel-master-app/api/internal/reclassify_job.py excel-master-app/api/formula_sync.py excel-master-app/api/project_bootstrap.py excel-master-app/api/verify_api.py tests/test_reclassify_manifest_hash.py excel-master-app/tests/test_reclassify_job.py
git commit -m "refactor: load workers from canonical finance package"
```

## Task 6: Add Final GMP Classification Tests

**Files:**
- Create: `tests/test_final_gmp_classification.py`
- Modify: `tests/test_payable_final_detail_classification.py`

- [ ] **Step 1: Write failing tests for Final GMP status source**

Create `tests/test_final_gmp_classification.py`:

```python
from __future__ import annotations

import copy

from tests.test_payable_final_detail_classification import PayableFinalDetailClassificationTests


def build_service(sheet_map):
    harness = PayableFinalDetailClassificationTests()
    return harness._get_classification_service(sheet_map)


def test_final_gmp_blank_is_non_gmp_even_when_budget_gmp_is_one():
    harness = PayableFinalDetailClassificationTests()
    sheet_map = harness._build_restore_ready_sheet_map()
    sheet_map["Scoping"].iloc[0, 4] = "GMP"
    sheet_map["Scoping"].insert(5, "Final GMP", ["Final GMP", "", "", "", "", "", ""])

    service = build_service(sheet_map)
    statuses = service.scoping_status_map[300]

    assert 1 not in statuses


def test_final_gmp_one_is_gmp_for_reclassification():
    harness = PayableFinalDetailClassificationTests()
    sheet_map = harness._build_restore_ready_sheet_map()
    sheet_map["Scoping"].insert(5, "Final GMP", ["Final GMP", "", "", 1, "", "", ""])

    service = build_service(sheet_map)
    statuses = service.scoping_status_map[300]

    assert 1 in statuses


def test_missing_final_gmp_column_uses_migration_copy_not_runtime_fallback():
    harness = PayableFinalDetailClassificationTests()
    sheet_map = harness._build_restore_ready_sheet_map()
    service = build_service(sheet_map)

    assert service.scoping_status_map[300] == {1}
```

The third test defines the temporary compatibility behavior before the Scoping schema migration is guaranteed everywhere: if the column is absent, existing sheets keep current behavior. The first test is the important business rule: once `Final GMP` exists, blank never falls back to old `GMP`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python3 -m pytest tests/test_final_gmp_classification.py -q
```

Expected: FAIL because `_build_scoping_status_map` still reads `GMP` for status `1`.

- [ ] **Step 3: Commit failing Final GMP tests**

```bash
git add tests/test_final_gmp_classification.py
git commit -m "test: pin final gmp classification basis"
```

## Task 7: Implement Final GMP Status Map

**Files:**
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_services.py`
- Test: `tests/test_final_gmp_classification.py`

- [ ] **Step 1: Update status column resolution**

In canonical `finance_services.py`, update `_build_scoping_status_map` so status `1` reads `Final GMP` when that header exists:

```python
def _build_scoping_status_map(self, wss: pd.DataFrame) -> Dict[int, set[int]]:
    group_col = self._find_col_in_row(wss, 0, "Group Number") or 2
    final_gmp_col = self._find_col_in_row(wss, 0, "Final GMP")
    status_cols = {
        1: final_gmp_col or self._find_col_in_row(wss, 0, "GMP") or 4,
        2: self._find_col_in_row(wss, 0, "Fee") or 5,
        3: self._find_col_in_row(wss, 0, "WIP") or 6,
        4: self._find_col_in_row(wss, 0, "WTC") or 7,
        5: self._find_col_in_row(wss, 0, "GC") or 8,
        6: self._find_col_in_row(wss, 0, "TBD") or 9,
    }
```

Keep the value check unchanged:

```python
if val is not None and abs(val - status_id) < 1e-9:
    statuses.add(status_id)
```

This means a present but blank `Final GMP` produces no status `1`.

- [ ] **Step 2: Run Final GMP status tests**

Run:

```bash
python3 -m pytest tests/test_final_gmp_classification.py -q
```

Expected: PASS.

- [ ] **Step 3: Run classification regression tests**

Run:

```bash
python3 -m pytest tests/test_payable_final_detail_classification.py tests/test_classification_settlement_boundary.py -q
```

Expected: PASS.

- [ ] **Step 4: Commit status map change**

```bash
git add excel-master-app/api/logic/aiwb_finance/finance_services.py tests/test_final_gmp_classification.py
git commit -m "feat: classify gmp from final gmp"
```

## Task 8: Add Scoping Final GMP Schema Migration

**Files:**
- Modify: `excel-master-app/api/logic/aiwb_finance/finance_engine.py`
- Modify: `tests/test_scoping_controls.py`

- [ ] **Step 1: Add failing pure helper tests**

Add these methods inside `class ScopingControlsTests` in `tests/test_scoping_controls.py`:

```python
    def test_ensure_scoping_final_gmp_column_inserts_after_gmp_and_copies_values(self):
        rows = [
            ["", "", "Group Number", "Group Name", "GMP", "Fee", "WIP", "WTC", "GC", "TBD", "保修月数"],
            ["", "", "101", "Group 101", "1", "", "", "", "", "", "12"],
            ["", "", "102", "Group 102", "", "2", "", "", "", "", ""],
        ]

        migrated, meta = fe._ensure_scoping_final_gmp_rows(rows)

        self.assertEqual({"inserted": True, "final_gmp_col_1based": 6}, meta)
        self.assertEqual(["GMP", "Final GMP", "Fee"], migrated[0][4:7])
        self.assertEqual(["1", "1", ""], migrated[1][4:7])
        self.assertEqual(["", "", "2"], migrated[2][4:7])

    def test_ensure_scoping_final_gmp_column_does_not_overwrite_existing_values(self):
        rows = [
            ["", "", "Group Number", "Group Name", "GMP", "Final GMP", "Fee"],
            ["", "", "101", "Group 101", "1", "", "2"],
            ["", "", "102", "Group 102", "", "1", ""],
        ]

        migrated, meta = fe._ensure_scoping_final_gmp_rows(rows)

        self.assertEqual({"inserted": False, "final_gmp_col_1based": 6}, meta)
        self.assertEqual(rows, migrated)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
python3 -m pytest tests/test_scoping_controls.py::ScopingControlsTests -q
```

Expected: FAIL because `_ensure_scoping_final_gmp_rows` does not exist.

- [ ] **Step 3: Implement pure migration helper**

Add to canonical `finance_engine.py` near Scoping layout helpers:

```python
def _find_header_index_in_rows(rows: Sequence[Sequence[Any]], header: str) -> Tuple[int | None, int | None]:
    target = _normalize_label(header)
    for row_idx, row in enumerate(rows):
        for col_idx, value in enumerate(row):
            if _normalize_label(value) == target:
                return row_idx, col_idx
    return None, None


def _ensure_scoping_final_gmp_rows(rows: Sequence[Sequence[Any]]) -> Tuple[List[List[Any]], Dict[str, Any]]:
    normalized = [list(row) for row in rows]
    if not normalized:
        return normalized, {"inserted": False, "final_gmp_col_1based": 0}

    header_row_idx, gmp_col_idx = _find_header_index_in_rows(normalized, "GMP")
    _, final_gmp_col_idx = _find_header_index_in_rows(normalized, "Final GMP")
    if final_gmp_col_idx is not None:
        return normalized, {"inserted": False, "final_gmp_col_1based": final_gmp_col_idx + 1}
    if header_row_idx is None or gmp_col_idx is None:
        return normalized, {"inserted": False, "final_gmp_col_1based": 0}

    insert_at = gmp_col_idx + 1
    for row_idx, row in enumerate(normalized):
        if len(row) < insert_at:
            row.extend([""] * (insert_at - len(row)))
        source_value = row[gmp_col_idx] if len(row) > gmp_col_idx else ""
        row.insert(insert_at, "Final GMP" if row_idx == header_row_idx else source_value)
    return normalized, {"inserted": True, "final_gmp_col_1based": insert_at + 1}
```

- [ ] **Step 4: Call migration before Scoping layout controls**

In `_apply_scoping_layout_controls`, after reading `rows`, call:

```python
migrated_rows, final_gmp_meta = _ensure_scoping_final_gmp_rows(rows)
if final_gmp_meta.get("inserted"):
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"'Scoping'!A1:{_column_number_to_a1(max(len(row) for row in migrated_rows))}{len(migrated_rows)}",
        valueInputOption="USER_ENTERED",
        body={"values": migrated_rows},
    ).execute()
    rows = migrated_rows
else:
    rows = migrated_rows
```

Add `final_gmp_meta` to the returned metadata.

- [ ] **Step 5: Update Scoping editable ranges**

Change `_build_scoping_manual_input_ranges` to discover `GMP`, `Final GMP`, and `Warranty Months` by header and return the editable status span from `GMP` through `Warranty Months`.

Expected old output in tests changes from:

```python
"'Scoping'!E4:K4"
```

to:

```python
"'Scoping'!E4:L4"
```

when `Final GMP` exists.

- [ ] **Step 6: Run Scoping tests**

Run:

```bash
python3 -m pytest tests/test_scoping_controls.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit Scoping migration**

```bash
git add excel-master-app/api/logic/aiwb_finance/finance_engine.py tests/test_scoping_controls.py
git commit -m "feat: add scoping final gmp migration"
```

## Task 9: Update Reclassification Worker To Ensure Schema Before Compute

**Files:**
- Modify: `excel-master-app/api/internal/reclassify_job.py`
- Test: `excel-master-app/tests/test_reclassify_job.py`

- [ ] **Step 1: Add worker test for schema migration call**

In `excel-master-app/tests/test_reclassify_job.py`, add a unit test that patches dependencies and verifies Scoping migration occurs before computing reclassification results. Use a fake service object that records `values().update(...)` calls and a sheet map without `Final GMP`.

Expected assertion:

```python
assert any("Scoping" in update["range"] for update in fake_service.value_updates)
```

- [ ] **Step 2: Export migration dependency**

In `_load_worker_dependencies`, import:

```python
from aiwb_finance.finance_engine import _ensure_scoping_final_gmp_rows
```

and include it in the returned dependency map.

- [ ] **Step 3: Apply schema migration in worker**

Before `compute_reclassification_results(sheet_map)` in worker request handling, add:

```python
scoping_key = deps["_sheet_key"](sheet_map, "Scoping")
scoping_rows = sheet_map[scoping_key].reset_index(drop=False).values.tolist()
migrated_rows, final_gmp_meta = deps["_ensure_scoping_final_gmp_rows"](scoping_rows)
if final_gmp_meta.get("inserted"):
    # write migrated rows, then reload the sheet map so DataFrame headers and values match live sheet
```

Use the existing Sheets API value update pattern and then call `load_reclassify_sheet_map(service, spreadsheet_id)` again before compute.

- [ ] **Step 4: Run worker tests**

Run:

```bash
python3 -m pytest excel-master-app/tests/test_reclassify_job.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit worker schema guard**

```bash
git add excel-master-app/api/internal/reclassify_job.py excel-master-app/tests/test_reclassify_job.py
git commit -m "feat: ensure final gmp before reclassification"
```

## Task 10: Update Frontend And Dashboard Scoping Readers

**Files:**
- Modify: `excel-master-app/src/lib/audit-manual-input.ts`
- Modify: `excel-master-app/src/lib/audit-dashboard.ts`
- Modify: `excel-master-app/src/pages/index.tsx`
- Test: `excel-master-app/src/__tests__/audit-manual-input.test.ts`, `excel-master-app/src/__tests__/workbench-phase1.test.tsx`

- [ ] **Step 1: Add frontend tests for Final GMP display**

In `excel-master-app/src/__tests__/audit-manual-input.test.ts`, add:

```typescript
it("reads scoping values by headers including Final GMP", () => {
  const snapshot = buildManualInputSnapshot({
    rows109: [],
    scopingRows: [
      ["", "", "Group Number", "Group Name", "GMP", "Final GMP", "Fee", "WIP", "WTC", "GC", "TBD", "Warranty Months", "Warranty Due Date", "Budget amount", "Incurred amount"],
      ["", "", "301", "Group 301", "1", "", "2", "", "", "5", "", "12", "07/12/2027", "1000", "100"],
    ],
    unitMasterRows: [],
  });

  expect(snapshot.scoping_groups).toEqual([
    expect.objectContaining({
      group: "301",
      group_name: "Group 301",
      scope_values: "GMP=1 / Final GMP=- / Fee=2 / WIP=- / WTC=- / GC=5 / TBD=-",
      warranty_months: "12",
    }),
  ]);
});
```

- [ ] **Step 2: Update manual-input Scoping extraction**

In `buildScopingGroups`, resolve columns by header:

```typescript
const gmpColumn = findColumnByHeader(headerRow, ["GMP"], 4);
const finalGmpColumn = findColumnByHeader(headerRow, ["Final GMP"], 5);
const feeColumn = findColumnByHeader(headerRow, ["Fee"], 6);
const wipColumn = findColumnByHeader(headerRow, ["WIP"], 7);
const wtcColumn = findColumnByHeader(headerRow, ["WTC"], 8);
const gcColumn = findColumnByHeader(headerRow, ["GC"], 9);
const tbdColumn = findColumnByHeader(headerRow, ["TBD"], 10);
```

Build `scope_values` as labeled text so users can distinguish budget GMP from Final GMP.

- [ ] **Step 3: Update dashboard scoping logic snapshot**

In `buildScopingLogicSnapshot`, read statuses by header instead of fixed `[4..9]`. Include both old `GMP` and `Final GMP` in the snapshot, with a key such as:

```typescript
statuses: {
  gmp: readCell(row, gmpColumn, "").trim(),
  final_gmp: readCell(row, finalGmpColumn, "").trim(),
  fee: readCell(row, feeColumn, "").trim(),
  wip: readCell(row, wipColumn, "").trim(),
  wtc: readCell(row, wtcColumn, "").trim(),
  gc: readCell(row, gcColumn, "").trim(),
  tbd: readCell(row, tbdColumn, "").trim(),
}
```

- [ ] **Step 4: Update Scoping table heading**

In `excel-master-app/src/pages/index.tsx`, change the column heading from:

```tsx
<th className="pb-3 font-medium">E-J</th>
```

to:

```tsx
<th className="pb-3 font-medium">Scoping</th>
```

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd excel-master-app && npm test -- --runInBand --runTestsByPath src/__tests__/audit-manual-input.test.ts src/__tests__/workbench-phase1.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit frontend Scoping readers**

```bash
git add excel-master-app/src/lib/audit-manual-input.ts excel-master-app/src/lib/audit-dashboard.ts excel-master-app/src/pages/index.tsx excel-master-app/src/__tests__/audit-manual-input.test.ts excel-master-app/src/__tests__/workbench-phase1.test.tsx
git commit -m "feat: show final gmp in scoping review"
```

## Task 11: Update Rule Documentation

**Files:**
- Modify: `excel-master-app/src/lib/reclass-rules.ts`
- Modify: `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md`
- Modify: `docs/AiWB_财务人员操作说明_v1.0.md`
- Test: `tests/test_payable_final_detail_classification.py`

- [ ] **Step 1: Update rule text**

Update R104, R105, R106, R107, and R204 wording from `GMP` to `Final GMP` where the rule describes classification basis.

Example:

```typescript
reason_zh: "结算前：Final GMP (1) + GC (5) + 供应商为 Wan Pacific",
reason_en: "Before Settlement: Final GMP (1) + GC (5) + Vendor is Wan Pacific",
```

Do not change Budget wording in documentation sections that explicitly describe budget calculations.

- [ ] **Step 2: Update audit manual**

In `docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md`, update the same rule sections. Keep category and sheet scope unchanged.

- [ ] **Step 3: Run manual consistency test**

Run:

```bash
python3 -m pytest tests/test_payable_final_detail_classification.py::AuditManualConsistencyTests -q
```

Expected: PASS.

- [ ] **Step 4: Commit documentation updates**

```bash
git add excel-master-app/src/lib/reclass-rules.ts docs/superpowers/specs/2026-04-19-finance-rule-id-manual.md docs/AiWB_财务人员操作说明_v1.0.md tests/test_payable_final_detail_classification.py
git commit -m "docs: explain final gmp reclassification rules"
```

## Task 12: Final Verification

**Files:**
- No code changes expected

- [ ] **Step 1: Run Python package/import verification**

Run:

```bash
python3 -m pytest \
  tests/test_single_finance_package_imports.py \
  tests/test_reclassify_manifest_hash.py \
  tests/test_final_gmp_classification.py \
  tests/test_payable_final_detail_classification.py \
  tests/test_classification_settlement_boundary.py \
  tests/test_google_serial_date_parsing.py \
  tests/test_scoping_controls.py \
  tests/test_unit_master_controls.py \
  excel-master-app/tests/test_reclassify_job.py \
  -q
```

Expected: PASS.

- [ ] **Step 2: Run Python compile checks**

Run:

```bash
python3 -m py_compile \
  excel-master-app/api/internal/reclassify_job.py \
  excel-master-app/api/formula_sync.py \
  excel-master-app/api/project_bootstrap.py \
  excel-master-app/api/verify_api.py \
  excel-master-app/api/logic/aiwb_finance/finance_classification.py \
  excel-master-app/api/logic/aiwb_finance/finance_engine.py \
  excel-master-app/api/logic/aiwb_finance/finance_formulas.py \
  excel-master-app/api/logic/aiwb_finance/finance_services.py \
  excel-master-app/api/logic/aiwb_finance/finance_utils.py
```

Expected: PASS.

- [ ] **Step 3: Run frontend tests**

Run:

```bash
cd excel-master-app && npm test -- --runInBand --runTestsByPath src/__tests__/audit-manual-input.test.ts src/__tests__/workbench-phase1.test.tsx src/__tests__/reclassify-api.test.ts
```

Expected: PASS.

- [ ] **Step 4: Confirm no unexpected legacy business logic remains**

Run:

```bash
python3 - <<'PY'
from pathlib import Path

wrapper_files = [
    "finance_classification.py",
    "finance_engine.py",
    "finance_formatting.py",
    "finance_formulas.py",
    "finance_mapping.py",
    "finance_services.py",
    "finance_utils.py",
]
for prefix in [Path("."), Path("api/logic"), Path("excel-master-app/api/logic")]:
    for name in wrapper_files:
        path = prefix / name
        text = path.read_text(encoding="utf-8")
        if "aiwb_finance" not in text and "aiwb_logic_loader" not in text:
            raise SystemExit(f"legacy business logic remains in {path}")
print("legacy wrappers ok")
PY
```

Expected: `legacy wrappers ok`.

- [ ] **Step 5: Commit verification evidence**

If no files changed, do not create an empty commit. If test snapshots or docs changed during verification, commit them:

```bash
git status --short
```

Expected: no unexpected files modified.
