import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import pytest
from fastapi.testclient import TestClient
from app import model
from app.main import app

client=TestClient(app)
def test_conversions():
    assert model.KWH_TO_MMBTU==pytest.approx(0.003412142)
    assert model.THERM_TO_MMBTU==pytest.approx(.1)
def test_eui():
    rows=model.baselines(model.assumptions())
    mean=sum(b["normalized_eui"]*b["floor_area_ft2"] for b in rows)/sum(b["floor_area_ft2"] for b in rows)
    assert mean==pytest.approx(161)
def test_baseline_arithmetic():
    b=model.evaluate()["buildings"][0]
    assert b["emissions_t"]==pytest.approx(b["electric_mwh"]*.34+b["thermal_mmbtu"]*.054)
def test_solar():
    b=model.baselines(model.assumptions())[0]
    data=model.evaluate({"buildings":{b["id"]:{"solar_kw":1}}})
    row=data["buildings"][0]
    assert row["solar_mwh"]==pytest.approx(1.1)
    assert row["capex_usd"]==pytest.approx(1830)
    assert row["annual_savings_usd"]==pytest.approx(99)
def test_milp_invariants():
    x=model.optimize(1200000)
    assert x["status"]=="optimal"
    assert x["optimized"]["summary"]["capex_usd"] <=1200000+.05
    assert x["optimized"]["summary"]["emissions_t"] <= x["baseline"]["summary"]["emissions_t"]
    for b in x["optimized"]["buildings"]:
        assert b["efficiency_tier"] in (0,1,2)
        assert 0<=b["solar_kw"]<=b["roof_cap_kw"]+1e-6
    assert x["plan"]["ppa_mwh"]==0 and x["plan"]["rng_mmbtu"]==0
    assert x["plan"]==model.optimize(1200000)["plan"]
def test_zero_budget_baseline():
    x=model.optimize(0)
    assert x["status"]=="optimal"
    assert x["optimized"]["summary"]["avoided_t"]==pytest.approx(0,abs=1e-6)
def test_procurement_residual():
    x=model.optimize(100000,include_procurement=True,annual_premium_budget_usd=1000)
    assert x["status"]=="optimal"
    p=x["optimized"]
    assert x["plan"]["ppa_mwh"]<=sum(b["electric_after_mwh"] for b in p["buildings"])+1e-5
    assert x["plan"]["rng_mmbtu"]<=sum(b["thermal_after_mmbtu"] for b in p["buildings"])+1e-5
    assert p["summary"]["annual_operating_premium_usd"]<=1000+.01
def test_infeasible_is_baseline():
    x=model.optimize(0,objective="min_cost",target_reduction_pct=100)
    assert x["status"]=="infeasible"
    assert x["optimized"]["summary"]==x["baseline"]["summary"]
def test_invalid_api():
    assert client.post("/api/optimize",json={"budget_usd":-1}).status_code==422
    assert client.post("/api/evaluate",json={"plan":{"buildings":{"missing":{"solar_kw":1}}}}).status_code==422
def test_smoke():
    b=client.get("/api/buildings")
    assert b.status_code==200 and len(b.json())==15
    p=client.post("/api/evaluate",json={"plan":{"buildings":{}}})
    assert p.status_code==200
    o=client.post("/api/optimize",json={"budget_usd":250000})
    assert o.status_code==200 and o.json()["status"]=="optimal"
    assert o.json()["optimized"]["summary"]["emissions_t"]<p.json()["summary"]["emissions_t"]
