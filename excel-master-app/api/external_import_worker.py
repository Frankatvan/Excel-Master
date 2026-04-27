from __future__ import annotations

import sys
from pathlib import Path


api_dir = Path(__file__).resolve().parent
logic_dir = api_dir / "logic"
logic_path = str(logic_dir)
if logic_path not in sys.path:
    sys.path.insert(0, logic_path)

from aiwb_finance.external_import_worker import handler as ExternalImportWorkerHandler  # noqa: E402


class handler(ExternalImportWorkerHandler):
    pass
