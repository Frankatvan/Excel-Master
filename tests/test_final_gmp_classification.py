from __future__ import annotations

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
