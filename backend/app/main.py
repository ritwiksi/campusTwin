"""FastAPI gateway; no database or runtime energy API."""
from typing import Literal
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, model_validator
from . import model

app = FastAPI(title="Rutgers Twin", version="0.1")
app.add_middleware(CORSMiddleware,allow_origins=["http://localhost:5173"],allow_methods=["GET","POST"],allow_headers=["*"])

class Assumptions(BaseModel):
    model_config=ConfigDict(extra="forbid")
    electric_fraction: float=Field(0.35,gt=0,lt=1)
    gas_price: float=Field(9,ge=0,le=100)
    roof_usable_fraction: float=Field(0.5,gt=0,le=1)
    roof_kw_per_ft2: float=Field(0.012,gt=0,le=0.1)

class Change(BaseModel):
    model_config=ConfigDict(extra="forbid")
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
def health(): return {"status":"ok","model":"annual 15-building sample"}

@app.get("/api/config")
def config():
    return model.CFG

@app.get("/api/buildings")
def buildings():
    return model.baselines(model.assumptions())

@app.post("/api/evaluate")
def evaluate(payload: EvaluateRequest):
    try:return model.evaluate(payload.plan.model_dump(),payload.assumptions.model_dump())
    except ValueError as e:raise HTTPException(422,detail=str(e))

@app.post("/api/optimize")
def optimize(payload: OptimizeRequest):
    try:return model.optimize(**payload.model_dump(exclude={"assumptions"}),overrides=payload.assumptions.model_dump())
    except ValueError as e:raise HTTPException(422,detail=str(e))
