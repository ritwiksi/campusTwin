"""Sanity comparison only: NOT per-building calibration or measured accuracy."""
from app.model import CFG, baselines, assumptions, KWH_TO_MMBTU
x=baselines(assumptions())
area=sum(b["floor_area_ft2"] for b in x)
share=area/CFG["parameters"]["bl_area_assumed"]["value"]
model_e=sum(b["electric_mwh"] for b in x)*1000
model_g=sum(b["thermal_mmbtu"] for b in x)/0.1
c=CFG["campus_context"]
print("Sample floor area (ESTIMATE):",round(area),"ft2")
print("B/L area (ASSUMPTION):",CFG["parameters"]["bl_area_assumed"]["value"],"ft2")
print("Illustrative sample share:",round(share*100,2),"%")
print("Sample modeled electricity kWh:",round(model_e),"/ floor-share-scaled B/L FY2018:",round(c["bl_electricity_kwh_FY2018"]*share))
print("Sample modeled thermal-equivalent therms:",round(model_g),"/ floor-share-scaled B/L FY2018 gas:",round(c["bl_gas_therms_FY2018"]*share))
print("WARNING: Historical B/L totals contain cogen electricity and fuel; these are NOT comparable independent end uses.")
