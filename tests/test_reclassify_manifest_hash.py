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
