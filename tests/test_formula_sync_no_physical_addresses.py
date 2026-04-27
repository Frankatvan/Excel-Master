import ast
import re
from pathlib import Path


ENGINE = Path("excel-master-app/api/logic/aiwb_finance/finance_engine.py")

FORMULA_SYNC_FUNCTIONS = {
    "_build_109_manual_input_ranges",
    "_build_109_units_count_formula",
    "_build_109_date_array_formula",
    "_build_109_formula_plan_from_grid",
    "_ensure_109_labels",
    "execute_109_formula_plan",
    "load_current_snapshot_formula_plan",
}

FORBIDDEN_FIXED_ADDRESS = re.compile(
    r"(?<![A-Za-z0-9_])(?:'[^']+'!|[A-Za-z0-9_ ]+!)?"
    r"(?:\$?[A-Z]{1,3}\$?[0-9]{1,5}|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|[A-Z]{1,3}[0-9]{1,5}:[A-Z]{1,3}[0-9]{1,5})"
)

ALLOWED_TRANSPORT_HELPERS = {
    "_a1_range_for_grid_write",
    "_quote_sheet_name",
}


def _function_name_stack(tree):
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    return parents


def _enclosing_function(node, parents):
    current = node
    while current in parents:
        current = parents[current]
        if isinstance(current, ast.FunctionDef):
            return current.name
    return None


def test_formula_sync_business_logic_has_no_fixed_physical_addresses():
    tree = ast.parse(ENGINE.read_text(encoding="utf-8"))
    parents = _function_name_stack(tree)
    violations = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        function_name = _enclosing_function(node, parents)
        if function_name not in FORMULA_SYNC_FUNCTIONS:
            continue
        if function_name in ALLOWED_TRANSPORT_HELPERS:
            continue
        if FORBIDDEN_FIXED_ADDRESS.search(node.value):
            violations.append((function_name, node.lineno, node.value))

    assert violations == []
