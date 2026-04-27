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
    inserted = False
    if canonical_path not in sys.path:
        sys.path.insert(0, canonical_path)
        inserted = True
    try:
        return importlib.import_module(f"aiwb_finance.{module_name}")
    finally:
        if inserted:
            sys.path.remove(canonical_path)


def reexport(globals_dict: MutableMapping[str, object], module_name: str) -> None:
    module = load_canonical(module_name)
    public_names = getattr(module, "__all__", None)
    if public_names is None:
        public_names = [name for name in vars(module) if not name.startswith("__")]
    for name in public_names:
        globals_dict[name] = getattr(module, name)
    globals_dict["__all__"] = list(public_names)
    globals_dict["__doc__"] = module.__doc__
