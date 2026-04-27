from __future__ import annotations

import os
import sys

import finance_engine as fe


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_fetch_project_main_sheet_title_falls_back_when_project_sequence_column_missing(monkeypatch):
    def _fake_supabase(**kwargs):
        query = kwargs.get("query") or {}
        selected = str(query.get("select") or "")
        if selected == "sheet_109_title,project_sequence":
            raise RuntimeError("column projects.project_sequence does not exist")
        if selected == "sheet_109_title":
            return [{"sheet_109_title": "999"}]
        return []

    monkeypatch.setattr(fe, "_supabase_rest_request_json", _fake_supabase)

    resolved = fe._fetch_project_main_sheet_title(project_id="project-999")

    assert resolved == "999"


def test_fetch_project_sequence_falls_back_to_main_sheet_title(monkeypatch):
    def _fake_supabase(**kwargs):
        raise RuntimeError("column projects.project_sequence does not exist")

    monkeypatch.setattr(fe, "_supabase_rest_request_json", _fake_supabase)
    monkeypatch.setattr(fe, "_fetch_project_main_sheet_title", lambda **_kwargs: "999")

    resolved = fe._fetch_project_sequence(project_id="project-999")

    assert resolved == "999"
