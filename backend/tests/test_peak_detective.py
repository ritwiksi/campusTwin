"""Peak Detective checks that run without a Snowflake account."""
from app import peak_detective as p
import pytest


def test_local_peak_is_consistent_and_ranked():
    r = p.local_preview()
    assert r["source"] == "local"
    assert {row["campus"] for row in r["campuses"]} == set(p.CAMPUSES)
    for campus in r["campuses"]:
        assert 0 <= campus["frame"] < 8736
        assert campus["peak_kw"] > 0
        assert sum(campus["end_uses_kw"].values()) == pytest.approx(campus["peak_kw"])
        assert 0 < campus["led_hvac_reduction_at_peak_kw"] < campus["peak_kw"]
        top = campus["top_buildings"]
        assert 1 <= len(top) <= 5
        assert [b["kw"] for b in top] == sorted([b["kw"] for b in top], reverse=True)
        assert all(0 <= b["share_pct"] <= 100 for b in top)
        assert all(b["id"] in {x["id"] for x in p.model.DATA} for b in top)


def test_offline_fallback_is_not_labeled_snowflake(monkeypatch, tmp_path):
    monkeypatch.setenv("SNOWFLAKE_ENABLED", "false")
    monkeypatch.setattr(p, "SNAPSHOT", tmp_path / "absent.json")
    r = p.get_report()
    assert r["source"] == "local"
    assert "Local preview" in r["notice"]


def test_snapshot_fallback_honestly_labeled(monkeypatch, tmp_path):
    import json
    path = tmp_path / "peaks.json"
    snapshot = {**p.local_preview(), "generated_at": "2026-11-21T18:00:00Z",
                "generated_from": "snowflake"}
    path.write_text(json.dumps(snapshot))
    monkeypatch.setattr(p, "SNAPSHOT", path)
    monkeypatch.setenv("SNOWFLAKE_ENABLED", "true")
    monkeypatch.setattr(p, "query_snowflake", lambda: (_ for _ in ()).throw(RuntimeError("failed")))
    r = p.get_report()
    assert r["source"] == "snapshot"
    assert r["generated_at"] == "2026-11-21T18:00:00Z"
    assert "unavailable" in r["notice"].lower()


def test_sql_performs_real_warehouse_aggregation_and_ranking():
    sql = p.PEAK_SQL.upper()
    assert "ROW_NUMBER() OVER" in sql
    assert "SUM(DEMAND_KW)" in sql
    assert "GROUP BY CAMPUS, FRAME" in sql
    assert "COMSTOCK_PROFILES" in sql


def test_peak_endpoint_serves_a_grounded_offline_preview(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    monkeypatch.setenv("SNOWFLAKE_ENABLED", "false")
    monkeypatch.setattr(p, "SNAPSHOT", tmp_path / "absent.json")
    response = TestClient(app).get("/api/analytics/peaks")
    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "local"
    assert len(payload["campuses"]) == 3
    assert all(len(c["top_buildings"]) >= 1 for c in payload["campuses"])
