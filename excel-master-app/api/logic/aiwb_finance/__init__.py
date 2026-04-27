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
