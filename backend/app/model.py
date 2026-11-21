"""Transparent, annual sample-building scenario model. NOT measured Rutgers loads."""
import json
import math
from pathlib import Path
import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

ROOT = Path(__file__).resolve().parents[2]
if not (ROOT / "data").exists():
    ROOT = Path(__file__).resolve().parents[1]
DATA = json.loads((ROOT / "data/buildings.json").read_text())
CFG = json.loads((ROOT / "data/config.json").read_text())
P = {k: v["value"] for k, v in CFG["parameters"].items()}
KWH_TO_MMBTU = 0.003412142
THERM_TO_MMBTU = 0.1

def assumptions(overrides=None):
    a = {k: P[k] for k in ("electric_fraction", "gas_price", "roof_usable_fraction", "roof_kw_per_ft2")}
    if overrides:
        for k, v in overrides.items():
            if k not in a or not isinstance(v, (float, int)) or not math.isfinite(v):
                raise ValueError("Invalid assumption override: " + str(k))
            a[k] = float(v)
    if not (0 < a["electric_fraction"] < 1 and 0 < a["roof_usable_fraction"] <= 1 and
            0 < a["roof_kw_per_ft2"] <= 0.1 and 0 <= a["gas_price"] <= 100):
        raise ValueError("Assumptions out of valid ranges")
    return a

def baselines(a):
    items = DATA
    # The 161 kBtu/ft2 calibration source covers Busch + Livingston only.
    # College Avenue is modeled using its explicit per-use EUI proxies (assumptions),
    # not falsely calibrated to the other campuses\u0027 reported aggregate.
    reference = [b for b in items if b["campus"] in ("Busch", "Livingston")]
    w_sum = sum(b["floor_area_ft2"] * b["proxy_eui"] for b in reference)
    area_sum = sum(b["floor_area_ft2"] for b in reference)
    norm = P["campus_eui"] * area_sum / w_sum
    rows = []
    for b in items:
        eui = b["proxy_eui"] * norm if b["campus"] in ("Busch", "Livingston") else b["proxy_eui"]
        kbtu = b["floor_area_ft2"] * eui
        electric_mwh = kbtu * a["electric_fraction"] / 3412.142
        thermal_mmbtu = kbtu * (1 - a["electric_fraction"]) / 1000
        emissions = electric_mwh * P["electric_co2"] + thermal_mmbtu * P["gas_co2"]
        rows.append({**b, "normalized_eui":eui, "electric_mwh":electric_mwh,
            "thermal_mmbtu":thermal_mmbtu, "emissions_t":emissions,
            "roof_cap_kw":b["footprint_ft2"] * a["roof_usable_fraction"] * a["roof_kw_per_ft2"]})
    return rows

def evaluate(plan=None, overrides=None):
    a = assumptions(overrides)
    plan = plan or {}
    if not isinstance(plan, dict):
        raise ValueError("plan must be a mapping")
    buildings_plan = plan.get("buildings", {})
    if not isinstance(buildings_plan, dict):
        raise ValueError("buildings must be a mapping")
    rows = baselines(a)
    known = {b["id"] for b in rows}
    if set(buildings_plan) - known:
        raise ValueError("Unknown building ID(s): " + ", ".join(sorted(set(buildings_plan) - known)))
    results = []
    for b in rows:
        change = buildings_plan.get(b["id"], {})
        tier = change.get("efficiency_tier", 0)
        solar_kw = change.get("solar_kw", 0)
        if type(tier) is not int or tier not in (0, 1, 2):
            raise ValueError("efficiency_tier must be 0, 1, or 2")
        if not isinstance(solar_kw, (int, float)) or not math.isfinite(solar_kw) or solar_kw < 0 or solar_kw > b["roof_cap_kw"] + 1e-6:
            raise ValueError("solar_kw must be within the building's roof capacity")
        ef = 0 if tier == 0 else (P["retrofit_t1_elec"] if tier == 1 else P["retrofit_t2_elec"])
        tf = 0 if tier == 0 else (P["retrofit_t1_thermal"] if tier == 1 else P["retrofit_t2_thermal"])
        e_after = b["electric_mwh"] * (1 - ef)
        t_after = b["thermal_mmbtu"] * (1 - tf)
        solar_mwh = solar_kw * P["solar_yield"]
        if solar_mwh > e_after + 1e-5:
            raise ValueError("Solar production cannot exceed residual modeled electricity demand")
        capex = solar_kw * P["solar_cost"] + (
            (P["retrofit_t2_cost"] * b["floor_area_ft2"]) * (P["retrofit_t1_cost_fraction"] if tier == 1 else 1)
            if tier else 0)
        bill_savings = (b["electric_mwh"] - (e_after - solar_mwh)) * P["electric_price"] + (b["thermal_mmbtu"] - t_after) * a["gas_price"]
        results.append({**b, "efficiency_tier":tier, "solar_kw":solar_kw, "solar_mwh":solar_mwh,
            "electric_after_mwh":e_after - solar_mwh, "thermal_after_mmbtu":t_after,
            "capex_usd":capex, "annual_savings_usd":bill_savings,
            "after_emissions_t":(e_after - solar_mwh) * P["electric_co2"] + t_after * P["gas_co2"]})
    residual_e = sum(b["electric_after_mwh"] for b in results)
    residual_t = sum(b["thermal_after_mmbtu"] for b in results)
    ppa = plan.get("ppa_mwh", 0)
    rng = plan.get("rng_mmbtu", 0)
    for name, val, max_v in (("ppa_mwh", ppa, residual_e), ("rng_mmbtu", rng, residual_t)):
        if not isinstance(val, (float, int)) or not math.isfinite(val) or val < 0 or val > max_v + 1e-5:
            raise ValueError(name + " must be nonnegative and cannot exceed residual demand")
    baseline = sum(b["emissions_t"] for b in results)
    emissions = sum(b["after_emissions_t"] for b in results) - ppa * P["electric_co2"] - rng * P["gas_co2"]
    capex = sum(b["capex_usd"] for b in results)
    premium = ppa * P["ppa_premium"] + rng * P["rng_premium"]
    annual_savings = sum(b["annual_savings_usd"] for b in results) - premium
    avoided = max(0, baseline - max(0, emissions))
    return {"buildings": results, "summary":{"baseline_emissions_t":baseline, "emissions_t":max(0, emissions),
        "avoided_t":avoided, "reduction_pct":100 * avoided / baseline if baseline else 0,
        "capex_usd":capex, "annual_operating_premium_usd":premium,
        "annual_savings_usd":annual_savings,
        "simple_payback_years":capex / annual_savings if annual_savings > 0 else None,
        "annualized_cost_per_tonne_usd":(capex/20 + premium)/avoided if avoided > 0 else None,
        "ppa_mwh":ppa, "rng_mmbtu":rng},
        "assumptions":a, "model_label":"MODELED ESTIMATE", "scope":"15-building sample, not the entire Rutgers campus"}

def optimize(budget_usd, objective="max_avoided", target_reduction_pct=None,
             include_procurement=False, annual_premium_budget_usd=0, overrides=None):
    if not math.isfinite(budget_usd) or budget_usd < 0 or budget_usd > 1e10:
        raise ValueError("budget_usd must be between 0 and $10B")
    if not math.isfinite(annual_premium_budget_usd) or annual_premium_budget_usd < 0:
        raise ValueError("annual_premium_budget_usd must be nonnegative")
    if objective not in ("max_avoided", "min_cost"):
        raise ValueError("Invalid objective")
    if objective == "min_cost" and (target_reduction_pct is None or not 0 <= target_reduction_pct <= 100):
        raise ValueError("Target percentage between 0 and 100 required")
    a = assumptions(overrides)
    rows = baselines(a)
    n = len(rows)
    # Per building: tier1 binary, tier2 binary, solar kW continuous.
    # Final variables: campus PPA MWh and RNG MMBtu.
    size = 3*n + 2
    ppa_i, rng_i = 3*n, 3*n+1
    lower, upper = np.zeros(size), np.zeros(size)
    integrality = np.zeros(size)
    capital = np.zeros(size)
    avoided = np.zeros(size)
    for i,b in enumerate(rows):
        j = 3*i
        upper[j:j+2] = 1
        integrality[j:j+2] = 1
        upper[j+2] = min(b["roof_cap_kw"], b["electric_mwh"]/P["solar_yield"])
        capital[j] = b["floor_area_ft2"]*P["retrofit_t2_cost"]*P["retrofit_t1_cost_fraction"]
        capital[j+1] = b["floor_area_ft2"]*P["retrofit_t2_cost"]
        capital[j+2] = P["solar_cost"]
        avoided[j] = b["electric_mwh"] * P["retrofit_t1_elec"] * P["electric_co2"] + b["thermal_mmbtu"]*P["retrofit_t1_thermal"]*P["gas_co2"]
        avoided[j+1] = b["electric_mwh"] * P["retrofit_t2_elec"] * P["electric_co2"] + b["thermal_mmbtu"]*P["retrofit_t2_thermal"]*P["gas_co2"]
        avoided[j+2] = P["solar_yield"]*P["electric_co2"]
    upper[ppa_i] = sum(b["electric_mwh"] for b in rows) if include_procurement else 0
    upper[rng_i] = sum(b["thermal_mmbtu"] for b in rows) if include_procurement else 0
    avoided[ppa_i] = P["electric_co2"]
    avoided[rng_i] = P["gas_co2"]
    # Ax <= rhs: mutually exclusive tiers, solar cannot exceed residual grid,
    # procurement cannot exceed residual demands, capex & annual premium separately.
    A, ub = [], []
    def add(coeff, rhs):
        A.append(coeff)
        ub.append(rhs)
    for i,b in enumerate(rows):
        j=3*i
        one=np.zeros(size);one[j]=one[j+1]=1
        add(one,1)
        one=np.zeros(size)
        one[j]=b["electric_mwh"]*P["retrofit_t1_elec"]
        one[j+1]=b["electric_mwh"]*P["retrofit_t2_elec"]
        one[j+2]=P["solar_yield"]
        add(one,b["electric_mwh"])
    one=np.zeros(size)
    for i,b in enumerate(rows):
        j=3*i
        one[j]=b["electric_mwh"]*P["retrofit_t1_elec"]
        one[j+1]=b["electric_mwh"]*P["retrofit_t2_elec"]
        one[j+2]=P["solar_yield"]
    one[ppa_i]=1
    add(one,sum(b["electric_mwh"] for b in rows))
    one=np.zeros(size)
    for i,b in enumerate(rows):
        j=3*i
        one[j]=b["thermal_mmbtu"]*P["retrofit_t1_thermal"]
        one[j+1]=b["thermal_mmbtu"]*P["retrofit_t2_thermal"]
    one[rng_i]=1
    add(one,sum(b["thermal_mmbtu"] for b in rows))
    add(capital.copy(),budget_usd)
    one=np.zeros(size);one[ppa_i]=P["ppa_premium"];one[rng_i]=P["rng_premium"]
    add(one,annual_premium_budget_usd)
    if objective=="min_cost":
        add(-avoided.copy(), -(target_reduction_pct/100)*sum(b["emissions_t"] for b in rows))
        c = capital/20 + one
    else:
        c = -avoided
    baseline=evaluate(overrides=overrides)
    try:
        res=milp(c=c, integrality=integrality,bounds=Bounds(lower,upper),
                 constraints=LinearConstraint(np.array(A),-np.inf,np.array(ub)),
                 options={"time_limit":15,"mip_rel_gap":0})
    except Exception as exc:
        return {"status":"error","message":str(exc),"plan":{"buildings":{}},"baseline":baseline,"optimized":baseline}
    if res.status != 0 or res.x is None:
        return {"status":"infeasible" if res.status==2 else "solver_failed",
                "message":str(res.message),"plan":{"buildings":{}},"baseline":baseline,"optimized":baseline}
    plan={"buildings":{}}
    for i,b in enumerate(rows):
        j=3*i
        tier=1 if res.x[j]>.5 else 2 if res.x[j+1]>.5 else 0
        solar=max(0,float(res.x[j+2]))
        solar=min(solar,b["roof_cap_kw"],b["electric_mwh"]*(1-(P["retrofit_t1_elec"] if tier==1 else P["retrofit_t2_elec"] if tier==2 else 0))/P["solar_yield"])
        if tier or solar>1e-6:
            plan["buildings"][b["id"]]={"efficiency_tier":tier,"solar_kw":solar}
    plan["ppa_mwh"]=max(0,float(res.x[ppa_i]))
    plan["rng_mmbtu"]=max(0,float(res.x[rng_i]))
    try:
        optimized=evaluate(plan,overrides)
    except ValueError as exc:
        return {"status":"solver_failed","message":"Post-solve validation: "+str(exc),"plan":{"buildings":{}},"baseline":baseline,"optimized":baseline}
    if optimized["summary"]["emissions_t"]>baseline["summary"]["emissions_t"]+1e-6 or optimized["summary"]["capex_usd"]>budget_usd+0.05:
        return {"status":"solver_failed","message":"Post-solve budget/emissions verification failed",
                "plan":{"buildings":{}},"baseline":baseline,"optimized":baseline}
    return {"status":"optimal","message":"Exact MILP optimum for this simplified annual model; not a global engineering optimum.",
            "plan":plan,"baseline":baseline,"optimized":optimized}
