import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[1]


def _install_formula_sync_import_stubs(monkeypatch):
    package = types.ModuleType("aiwb_finance")
    finance_engine = types.ModuleType("aiwb_finance.finance_engine")

    class SnapshotStaleError(Exception):
        pass

    finance_engine.get_sheets_service = Mock()
    finance_engine.load_current_snapshot_formula_plan = Mock()
    finance_engine.execute_109_formula_plan = Mock()
    finance_engine.validate_snapshot_writeback_consistency = Mock()
    finance_engine.SnapshotStaleError = SnapshotStaleError

    supabase = types.ModuleType("supabase")
    supabase.create_client = Mock()
    supabase.Client = object

    monkeypatch.setitem(sys.modules, "aiwb_finance", package)
    monkeypatch.setitem(sys.modules, "aiwb_finance.finance_engine", finance_engine)
    monkeypatch.setitem(sys.modules, "supabase", supabase)


def _load_formula_sync_module(monkeypatch):
    _install_formula_sync_import_stubs(monkeypatch)
    module_path = ROOT / "api" / "formula_sync.py"
    spec = importlib.util.spec_from_file_location("root_formula_sync_worker", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class DummyWriter:
    def __init__(self):
        self.body = ""

    def write(self, data):
        self.body = data.decode("utf-8")


def _make_formula_handler(module, request_body: bytes, headers: dict[str, str] | None = None):
    handler = module.handler.__new__(module.handler)
    read = Mock(return_value=request_body)
    handler.headers = {"Content-Length": str(len(request_body)), **(headers or {})}
    handler.rfile = SimpleNamespace(read=read)
    handler.wfile = DummyWriter()
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/formula_sync HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/formula_sync"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()
    return handler


def test_formula_sync_rejects_wrong_worker_secret_before_reading_json(monkeypatch):
    formula_sync = _load_formula_sync_module(monkeypatch)
    monkeypatch.setenv("FORMULA_SYNC_WORKER_SECRET", "test-formula-secret")
    handler = _make_formula_handler(
        formula_sync,
        b"{not-json",
        {"X-AiWB-Worker-Secret": "wrong-secret"},
    )

    formula_sync.handler.do_POST(handler)

    assert handler.send_response.call_args.args[0] == 401
    assert json.loads(handler.wfile.body) == {"status": "error", "message": "Unauthorized"}
    handler.rfile.read.assert_not_called()


def test_formula_sync_returns_500_when_worker_secret_is_missing(monkeypatch):
    formula_sync = _load_formula_sync_module(monkeypatch)
    monkeypatch.delenv("FORMULA_SYNC_WORKER_SECRET", raising=False)
    monkeypatch.delenv("AIWB_WORKER_SECRET", raising=False)
    handler = _make_formula_handler(
        formula_sync,
        b"{not-json",
        {"X-AiWB-Worker-Secret": "anything"},
    )

    formula_sync.handler.do_POST(handler)

    assert handler.send_response.call_args.args[0] == 500
    assert json.loads(handler.wfile.body) == {"status": "error", "message": "Worker secret is not configured."}
    handler.rfile.read.assert_not_called()
