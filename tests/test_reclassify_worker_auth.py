import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


ROOT = Path(__file__).resolve().parents[1]


def _install_reclassify_import_stubs(monkeypatch):
    pandas = types.ModuleType("pandas")
    pandas.DataFrame = Mock()

    finance_engine = types.ModuleType("finance_engine")
    finance_engine.get_sheets_service = Mock()
    finance_engine.run_apps_shadow_pipeline = Mock()
    finance_engine.execute_commit = Mock()
    finance_engine.build_commit_bundle = Mock()

    finance_utils = types.ModuleType("finance_utils")
    finance_utils.get_sheets_service = Mock()

    supabase = types.ModuleType("supabase")
    supabase.create_client = Mock()
    supabase.Client = object

    monkeypatch.setitem(sys.modules, "pandas", pandas)
    monkeypatch.setitem(sys.modules, "finance_engine", finance_engine)
    monkeypatch.setitem(sys.modules, "finance_utils", finance_utils)
    monkeypatch.setitem(sys.modules, "supabase", supabase)


def _load_reclassify_module(monkeypatch):
    _install_reclassify_import_stubs(monkeypatch)
    module_path = ROOT / "api" / "reclassify.py"
    spec = importlib.util.spec_from_file_location("root_reclassify_worker", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec is not None and spec.loader is not None
    spec.loader.exec_module(module)
    return module


class DummyWriter:
    def __init__(self):
        self.body = ""

    def write(self, data):
        self.body = data.decode("utf-8")


def _make_reclassify_handler(module, request_body: bytes, headers: dict[str, str] | None = None):
    handler = module.handler.__new__(module.handler)
    read = Mock(return_value=request_body)
    handler.headers = {"Content-Length": str(len(request_body)), **(headers or {})}
    handler.rfile = SimpleNamespace(read=read)
    handler.wfile = DummyWriter()
    handler.send_response = Mock()
    handler.send_header = Mock()
    handler.end_headers = Mock()
    handler.requestline = "POST /api/reclassify HTTP/1.1"
    handler.command = "POST"
    handler.path = "/api/reclassify"
    handler.request_version = "HTTP/1.1"
    handler.client_address = ("127.0.0.1", 0)
    handler.server = Mock()
    return handler


def test_reclassify_rejects_wrong_worker_secret_before_reading_json(monkeypatch):
    reclassify = _load_reclassify_module(monkeypatch)
    monkeypatch.setenv("RECLASSIFY_WORKER_SECRET", "test-reclassify-secret")
    handler = _make_reclassify_handler(
        reclassify,
        b"{not-json",
        {"X-AiWB-Worker-Secret": "wrong-secret"},
    )

    reclassify.handler.do_POST(handler)

    assert handler.send_response.call_args.args[0] == 401
    assert json.loads(handler.wfile.body) == {"status": "error", "message": "Unauthorized"}
    handler.rfile.read.assert_not_called()


def test_reclassify_returns_500_when_worker_secret_is_missing(monkeypatch):
    reclassify = _load_reclassify_module(monkeypatch)
    monkeypatch.delenv("RECLASSIFY_WORKER_SECRET", raising=False)
    monkeypatch.delenv("AIWB_WORKER_SECRET", raising=False)
    handler = _make_reclassify_handler(
        reclassify,
        b"{not-json",
        {"X-AiWB-Worker-Secret": "anything"},
    )

    reclassify.handler.do_POST(handler)

    assert handler.send_response.call_args.args[0] == 500
    assert json.loads(handler.wfile.body) == {"status": "error", "message": "Worker secret is not configured."}
    handler.rfile.read.assert_not_called()
