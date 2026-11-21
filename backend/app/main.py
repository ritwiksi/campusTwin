"""FastAPI gateway; no database or runtime energy API."""
import os
from pathlib import Path
from fastapi.staticfiles import StaticFiles
from typing import Literal
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator
from . import model, comstock, peak_detective

app = FastAPI(title="Campus Twin", version="0.1")
app.add_middleware(CORSMiddleware,allow_origins=["http://localhost:5173"],allow_methods=["GET","POST"],allow_headers=["*"])

class Assumptions(BaseModel):
    model_config=ConfigDict(extra="forbid")
    electric_fraction: float=Field(0.35,gt=0,lt=1)
    gas_price: float=Field(9,ge=0,le=100)
    roof_usable_fraction: float=Field(0.5,gt=0,le=1)
    roof_kw_per_ft2: float=Field(0.012,gt=0,le=0.1)

class Change(BaseModel):
    model_config=ConfigDict(extra="forbid")
    led: bool=False
    hvac: bool=False
    solar: bool=False
    # Retained for the legacy optimizer endpoint, not shown in Campus Twin.
    efficiency_tier: Literal[0,1,2]=0
    solar_kw: float=Field(0,ge=0)

class Plan(BaseModel):
    model_config=ConfigDict(extra="forbid")
    buildings: dict[str,Change]=Field(default_factory=dict)
    ppa_mwh: float=Field(0,ge=0)
    rng_mmbtu: float=Field(0,ge=0)

class EvaluateRequest(BaseModel):
    model_config=ConfigDict(extra="forbid")
    plan: Plan=Field(default_factory=Plan)
    assumptions: Assumptions=Field(default_factory=Assumptions)

class OptimizeRequest(BaseModel):
    model_config=ConfigDict(extra="forbid")
    budget_usd: float=Field(1000000,ge=0,le=1e10)
    objective: Literal["max_avoided","min_cost"]="max_avoided"
    target_reduction_pct: float|None=Field(None,ge=0,le=100)
    include_procurement: bool=False
    annual_premium_budget_usd:float=Field(0,ge=0)
    assumptions:Assumptions=Field(default_factory=Assumptions)

@app.get("/health")
@app.get("/api/health")
def health(): return {"status":"ok","model":f"annual {len(model.DATA)}-building sample"}

@app.get("/api/config")
def config():
    return model.CFG

@app.get("/api/buildings")
def buildings():
    return model.baselines(model.assumptions())

@app.get("/api/comstock")
def comstock_profiles():
    # Serve exactly the cached OEDI aggregate, already gzip-compressed on disk.
    # Browser fetch transparently decompresses it. No startup network calls.
    return Response(
        content=comstock.profile_bytes(),
        media_type="application/json",
        headers={
            "Content-Encoding": "gzip",
            "Cache-Control": "public, max-age=3600",
            "Vary": "Accept-Encoding",
        },
    )

@app.get("/api/analytics/peaks")
def peak_detective_report():
    return peak_detective.get_report()


@app.post("/api/evaluate")
def evaluate(payload: EvaluateRequest):
    try:return model.evaluate(payload.plan.model_dump(),payload.assumptions.model_dump())
    except ValueError as e:raise HTTPException(422,detail=str(e))

@app.post("/api/optimize")
def optimize(payload: OptimizeRequest):
    try:return model.optimize(**payload.model_dump(exclude={"assumptions"}),overrides=payload.assumptions.model_dump())
    except ValueError as e:raise HTTPException(422,detail=str(e))


@app.get("/api/runtime-config")
def runtime_config():
    # Public browser-scoped Cesium token: use URL/domain restrictions in Cesium ion.
    # It is not a private server-only credential; clients need it to stream 3D tiles.
    return {"cesium_ion_token": os.getenv("CESIUM_ION_TOKEN", "")}

# Single-origin hosting: the API and compiled Vite site share one web service.
# In local development the dist directory is absent and Vite proxies /api.
DIST_DIR = Path(__file__).resolve().parents[1] / "dist"
if DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
