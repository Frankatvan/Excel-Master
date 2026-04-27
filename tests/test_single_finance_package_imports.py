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
