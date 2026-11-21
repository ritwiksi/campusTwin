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
    rows=[b for b in model.baselines(model.assumptions()) if b["campus"] in ("Busch","Livingston")]
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
    assert b.status_code==200 and len(b.json())==26
    assert sum(row["campus"]=="College Avenue" for row in b.json())==11
    p=client.post("/api/evaluate",json={"plan":{"buildings":{}}})
    assert p.status_code==200
    o=client.post("/api/optimize",json={"budget_usd":250000})
    assert o.status_code==200 and o.json()["status"]=="optimal"
    assert o.json()["optimized"]["summary"]["emissions_t"]<p.json()["summary"]["emissions_t"]

def test_led_scenario_matches_temple_lpd_ratio():
    from app import led
    base=model.evaluate()["buildings"][0]
    result=model.evaluate({"buildings":{base["id"]:{"led":True}}})["buildings"][0]
    inputs=led.assumptions(base["use"],base["floor_area_ft2"],base["electric_mwh"],lighting_share=model.comstock.annual_shares(base["use"])["lighting"])
    expected=inputs["led_lighting_baseline_mwh"] * (1-inputs["led_target_lpd_w_ft2"]/inputs["led_reference_lpd_w_ft2"])
    assert result["led_saved_mwh"]==pytest.approx(expected)
    assert result["gross_electric_after_mwh"]==pytest.approx(base["electric_mwh"]-expected)
    assert result["thermal_after_mmbtu"]==pytest.approx(base["thermal_mmbtu"])
    assert result["after_emissions_t"]<base["emissions_t"]
    assert result["solar_kw"]==0

def test_hvac_scenario_matches_six_percent_benchmark():
    base=model.evaluate()["buildings"][1]
    result=model.evaluate({"buildings":{base["id"]:{"hvac":True}}})["buildings"][1]
    assert result["hvac_saved_mwh"]==pytest.approx(base["electric_mwh"]*.06)
    assert result["gross_electric_after_mwh"]==pytest.approx(base["electric_mwh"]*.94)
    assert result["thermal_after_mmbtu"]==pytest.approx(base["thermal_mmbtu"])

def test_solar_toggle_shows_capacity_and_displaces_grid_only():
    base=model.evaluate()["buildings"][0]
    result=model.evaluate({"buildings":{base["id"]:{"solar":True}}})["buildings"][0]
    assert result["solar_kw"]>0
    assert result["solar_kw"]<=base["roof_cap_kw"]
    assert result["solar_mwh"]==pytest.approx(result["solar_kw"]*model.P["solar_yield"])
    assert result["gross_electric_after_mwh"]==pytest.approx(base["electric_mwh"])
    assert result["electric_after_mwh"]==pytest.approx(base["electric_mwh"]-result["solar_mwh"])

def test_combined_scenarios_add_and_turn_off_without_sticking():
    base=model.evaluate()["buildings"][0]
    active={"led":True,"hvac":True,"solar":True}
    altered=model.evaluate({"buildings":{base["id"]:active}})["buildings"][0]
    assert altered["led_saved_mwh"]>0
    assert altered["hvac_saved_mwh"]>0
    assert altered["solar_kw"]>0
    assert altered["gross_electric_after_mwh"]==pytest.approx(
        base["electric_mwh"]-altered["led_saved_mwh"]-altered["hvac_saved_mwh"])
    assert altered["electric_after_mwh"]==pytest.approx(altered["gross_electric_after_mwh"]-altered["solar_mwh"])
    assert altered["after_emissions_t"]<base["emissions_t"]
    off=model.evaluate({"buildings":{base["id"]:{"led":False,"hvac":False,"solar":False}}})["buildings"][0]
    assert off["after_emissions_t"]==pytest.approx(base["emissions_t"])
    assert off["solar_kw"]==0

def test_api_intervention_switches_validate():
    b=client.get("/api/buildings").json()[0]
    reply=client.post("/api/evaluate",json={"plan":{"buildings":{b["id"]:{"led":True,"hvac":True,"solar":True}}}})
    assert reply.status_code==200,reply.text
    row=next(x for x in reply.json()["buildings"] if x["id"]==b["id"])
    assert row["led"] and row["hvac"] and row["solar"] and row["solar_kw"]>0
    assert client.post("/api/evaluate",json={"plan":{"buildings":{b["id"]:{"led":"not boolean"}}}}).status_code==422

def test_comstock_cache_is_real_middlesex_county_and_complete():
    from app import comstock
    dataset = comstock.load()
    assert dataset["county_gisjoin"] == "g3400230"
    assert dataset["period_start"] == "2018-09-01"
    assert dataset["period_end"] == "2018-11-30"
    assert dataset["interval_minutes"] == 15
    assert dataset["component_order"] == ["hvac","lighting","process","other"]
    for kind, rows in dataset["types"].items():
        assert len(rows["factors"]) == 91*96, kind
        assert rows["source_url"].startswith("https://oedi-data-lake.s3.amazonaws.com/")
        assert sum(rows["annual_shares"]) == pytest.approx(1,abs=5e-8)
        assert len(rows["factors"][0]) == 4
        assert all(v >= 0 for v in rows["factors"][0])
        assert max(sum(r) for r in rows["factors"][:96]) > min(sum(r) for r in rows["factors"][:96])

def test_comstock_building_uses_are_explicit_and_no_unknown_archetypes():
    from app import comstock
    types=set(comstock.load()["types"])
    rows=model.baselines(model.assumptions())
    assert set(r["comstock_type"] for r in rows) <= types
    assert comstock.archetype_for_use("Dining") == "fullservicerestaurant"
    assert comstock.archetype_for_use("Residence") == "largehotel"
    assert comstock.archetype_for_use("Research") == "secondaryschool"
    assert comstock.archetype_for_use("Office") == "mediumoffice"

def test_comstock_led_hvac_savings_stay_in_their_end_use():
    b=model.evaluate()["buildings"][0]
    shares=b["comstock_annual_shares"]
    result=model.evaluate({"buildings":{b["id"]:{"led":True,"hvac":True}}})["buildings"][0]
    expected_led=b["electric_mwh"]*shares["lighting"]*result["led_reduction_fraction"]
    expected_hvac=min(b["electric_mwh"]*.06,b["electric_mwh"]*shares["hvac"])
    assert result["led_saved_mwh"]==pytest.approx(expected_led)
    assert result["hvac_saved_mwh"]==pytest.approx(expected_hvac)
    assert result["hvac_reduction_fraction"]==pytest.approx(expected_hvac/(b["electric_mwh"]*shares["hvac"]))
    assert result["gross_electric_after_mwh"]==pytest.approx(b["electric_mwh"]-expected_led-expected_hvac)

def test_comstock_profile_endpoint():
    response=client.get("/api/comstock")
    assert response.status_code==200
    assert response.headers["content-encoding"]=="gzip"
    data=response.json()
    assert data["county_gisjoin"]=="g3400230"
    assert len(data["types"]["secondaryschool"]["factors"])==8736
