# Single Python Package Before Final GMP Design

## Background

AiWB currently keeps finance logic in three locations:

- Root modules such as `finance_services.py`, `finance_engine.py`, and `finance_utils.py`.
- API mirror modules under `api/logic/`.
- Production worker modules under `excel-master-app/api/logic/`.

The production Vercel app is rooted in `excel-master-app/`. Its Python serverless functions, including `excel-master-app/api/internal/reclassify_job.py`, load logic from `excel-master-app/api/logic/`. However, many local tests and maintenance scripts import the root modules directly, and some tests load the production worker modules explicitly.

This has created real behavioral drift. Some files are still identical across all three locations, but `finance_services.py`, `finance_utils.py`, and `finance_formulas.py` are not. Because `finance_services.py` owns the reclassification rule engine, this drift can produce different classifications depending on the entrypoint.

Before adding `Final GMP`, the finance logic must be consolidated behind one canonical Python package. Otherwise the new GMP execution basis could be implemented in one copy while another copy continues to run old logic.

## Goals

- Establish one canonical Python finance logic package used by production workers, tests, and local scripts.
- Keep existing import entrypoints working during migration through compatibility wrappers.
- Prevent future silent drift with automated consistency checks.
- Include all reclassification-critical files in the worker code manifest hash.
- Defer the `Final GMP` business change until the single-package migration is verified.

## Non-Goals

- Do not redesign reclassification rules during the package migration.
- Do not delete legacy root entrypoint files in this phase.
- Do not rewrite the Next.js API surface.
- Do not change Google Sheet data during the package migration.
- Do not implement `Final GMP` in the same patch as the package migration.

## Canonical Package

The canonical package should live under:

`excel-master-app/api/logic/`

This is the correct short-term source of truth because the current Vercel production worker already imports from that directory. The migration should make the rest of the repository point to this canonical implementation instead of maintaining copied business logic.

The package should expose the existing public module names:

- `finance_classification`
- `finance_engine`
- `finance_formatting`
- `finance_formulas`
- `finance_mapping`
- `finance_services`
- `finance_utils`

The first migration pass should add package metadata and import helpers only where needed. It should not rename all imports at once if a smaller compatibility layer can keep risk lower.

## Compatibility Entrypoints

Legacy root modules and `api/logic` modules should become thin compatibility wrappers that import and re-export from the canonical package.

Examples of legacy entrypoints that must continue to work:

- `import finance_engine`
- `from finance_services import ClassificationService`
- `from finance_classification import compute_payable_classifications`
- `api/formula_sync.py` loading `api/logic`
- local scripts that insert the repository root into `sys.path`

The wrappers must not contain business logic. If a wrapper grows beyond import path setup plus re-export, it should fail review.

`finance_utils.py` needs special handling because the current root copy imports Streamlit while the production copy must not. The canonical production-safe version should be the exported implementation for automated tests and workers. Any Streamlit-only behavior should remain in `finance_ui.py` or a UI-specific helper, not in shared finance logic.

## Current Drift To Reconcile

Before wrapping old entrypoints, the canonical package must absorb intentional fixes from the other copies:

- `finance_services.py`: review root, `api/logic`, and production worker differences. The final canonical version must preserve the accepted restore behavior and must not include the 2026 hard settlement boundary unless explicitly approved as a business rule.
- `finance_formulas.py`: reconcile dynamic year-column handling so root, API mirror, and production use one implementation.
- `finance_utils.py`: keep production-safe credential loading for serverless workers and avoid Streamlit dependency in canonical logic.

The reconciliation must be tested before replacing old files with wrappers.

## Worker Manifest Hash

`excel-master-app/api/internal/reclassify_job.py` currently computes a code manifest hash for selected files. The manifest must include all files that can affect classification:

- `finance_classification.py`
- `finance_engine.py`
- `finance_mapping.py`
- `finance_formulas.py`
- `finance_services.py`
- `finance_utils.py`
- any package metadata file required to resolve canonical imports

This makes audit runs traceable to the actual reclassification implementation.

## Final GMP Follow-Up

After the single-package migration passes tests, implement `Final GMP` as a separate business change:

- Add `Final GMP` after existing `GMP` in Scoping.
- Initialize `Final GMP` from existing `GMP` only when the column is first created.
- Treat blank `Final GMP` as non-GMP for reclassification.
- Use old `GMP` only for Budget / Day 1 / Unit Budget logic.
- Use `Final GMP` as status `1` for all reclassification decisions and restore candidate gates.
- Keep `Final GMP` manually editable after initialization.

## Testing Strategy

The migration must add tests that fail when logic copies drift again:

- A wrapper test imports root modules and canonical modules and verifies they resolve to the same public objects or behavior.
- A manifest test verifies `finance_services.py` and `finance_utils.py` are included in the reclassification worker hash.
- Existing root tests continue to pass through compatibility wrappers.
- Existing worker-specific tests continue to pass against `excel-master-app/api/logic`.

The Final GMP phase must then add behavior tests:

- Existing `GMP=1`, new `Final GMP` blank classifies as non-GMP.
- Existing `GMP=1`, new `Final GMP=1` classifies as GMP.
- Initialization copies old GMP into Final GMP only when the Final GMP column does not exist.
- Existing manually edited Final GMP values are not overwritten by validation or refresh steps.

## Risk Controls

- Do package migration and Final GMP in separate commits or at least separate review checkpoints.
- Do not remove legacy files until all scripts and tests are moved to canonical imports.
- Keep compatibility wrappers simple enough to audit by inspection.
- Run Python unit tests for both root-style imports and worker-style imports before any live sheet operation.
- Do not run any live Google Sheet mutation command as part of package migration verification.

## Approval Gate

Implementation should start only after this design is reviewed and approved. The next artifact should be a detailed implementation plan with small TDD tasks, beginning with tests that expose current drift and ending with Final GMP behavior tests.
