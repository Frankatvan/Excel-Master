from __future__ import annotations

import finance_ui
from finance_engine import (
    build_project_ledger_semantic_context,
    build_budgetco_semantic_summary_context,
    update_109_semantic_logic,
)

# 显式导出供集成测试使用
__all__ = [
    "build_project_ledger_semantic_context",
    "build_budgetco_semantic_summary_context",
    "update_109_semantic_logic",
]

if __name__ == "__main__":
    finance_ui.main()
