"""Cached Middlesex County, New Jersey 2018 NREL ComStock load shapes.

The cache is generated from the actual OEDI county timeseries aggregates by
scripts/prepare_comstock.py and committed to source. No runtime download.
Annual electricity magnitudes remain Rutgers building estimates; load shape
and end-use shares are ComStock, not actual building interval readings.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
import gzip
import json
import math

ROOT = Path(__file__).resolve().parents[2]
if not (ROOT / "data").exists():
    ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data/comstock/middlesex_amy2018.json.gz"
INTERVALS = 91 * 96
COMPONENTS = ("hvac", "lighting", "process", "other")


def archetype_for_use(use: str) -> str:
    key = use.lower().strip()
    if key in ("housing", "residence"):
        return "largehotel"
    if key in ("office", "administration"):
        return "mediumoffice"
    if key == "dining":
        return "fullservicerestaurant"
    # ComStock 2021 does not contain a higher-education/laboratory archetype.
    # All other facilities use secondaryschool as an explicit proxy.
    return "secondaryschool"


@lru_cache(maxsize=1)
def load() -> dict:
    with gzip.open(CACHE, "rt", encoding="utf-8") as file:
        data = json.load(file)
    if data["county_gisjoin"] != "g3400230" or data["component_order"] != list(COMPONENTS):
        raise ValueError("ComStock dataset mismatch")
    for name in ("secondaryschool", "mediumoffice", "largehotel", "fullservicerestaurant"):
        d = data["types"][name]
        if len(d["factors"]) != INTERVALS:
            raise ValueError(f"Bad ComStock row count for {name}")
        if len(d["annual_shares"]) != 4 or not math.isclose(sum(d["annual_shares"]), 1, abs_tol=5e-8):
            raise ValueError(f"ComStock annual electricity shares do not reconcile for {name}")
    return data


def annual_shares(use: str) -> dict[str, float]:
    shares = load()["types"][archetype_for_use(use)]["annual_shares"]
    return dict(zip(COMPONENTS, shares))


def profile_bytes() -> bytes:
    return CACHE.read_bytes()
