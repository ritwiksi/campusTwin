"""Pin Middlesex County ComStock 2021/AMY2018 aggregate profiles for offline demo use.

Run once on a machine with network access. A GitHub Action commits the compact,
compressed cache so Render never needs to download OEDI data at runtime.
This is real NREL-modeled county-level data, not Rutgers meter observations.
"""
from __future__ import annotations

import csv
import gzip
import io
import json
import math
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "comstock" / "middlesex_amy2018.json.gz"
DATASET = "2021/comstock_amy2018_release_1"
BASE = (
    "https://oedi-data-lake.s3.amazonaws.com/nrel-pds-building-stock/"
    "end-use-load-profiles-for-us-building-stock/"
    + DATASET
    + "/timeseries_aggregates/by_county/state=NJ/"
)
COUNTY = "g3400230"
ARCHETYPES = ("secondaryschool", "mediumoffice", "largehotel", "fullservicerestaurant")
HVAC = (
    "out.electricity.cooling.energy_consumption",
    "out.electricity.fans.energy_consumption",
    "out.electricity.heat_recovery.energy_consumption",
    "out.electricity.heat_rejection.energy_consumption",
    "out.electricity.heating.energy_consumption",
    "out.electricity.pumps.energy_consumption",
)
LIGHTING = (
    "out.electricity.interior_lighting.energy_consumption",
    "out.electricity.exterior_lighting.energy_consumption",
)
PROCESS = (
    "out.electricity.interior_equipment.energy_consumption",
    "out.electricity.refrigeration.energy_consumption",
)
TOTAL = "out.electricity.total.energy_consumption"
START = datetime(2018, 9, 1)
END = datetime(2018, 12, 1)
EXPECTED_YEAR = 365 * 96
EXPECTED_WINDOW = 91 * 96


def positive(row: dict[str, str], name: str) -> float:
    try:
        value = float(row.get(name) or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Bad ComStock value {name}: {row.get(name)}") from exc
    if not math.isfinite(value):
        raise ValueError(f"Invalid ComStock value for {name}")
    return max(value, 0.0)


def fetch(archetype: str) -> dict:
    url = f"{BASE}{COUNTY}-{archetype}.csv"
    print(f"Downloading {url}", flush=True)
    with urlopen(Request(url, headers={"User-Agent": "CampusTwin-ComStock/1.0"}), timeout=90) as response:
        payload = response.read()
    csv_rows = list(csv.DictReader(io.StringIO(payload.decode("utf-8-sig"))))
    if len(csv_rows) != EXPECTED_YEAR:
        raise ValueError(f"Unexpected {archetype} row count: {len(csv_rows)}, expected {EXPECTED_YEAR}")
    whole_year: list[tuple[datetime, list[float]]] = []
    previous = None
    for row in csv_rows:
        ts = datetime.fromisoformat(row["timestamp"]) - timedelta(minutes=15)
        if previous and ts - previous != timedelta(minutes=15):
            raise ValueError(f"Non-continuous quarter-hour timestamps: {previous} -> {ts}")
        previous = ts
        hvac = sum(positive(row, col) for col in HVAC)
        lighting = sum(positive(row, col) for col in LIGHTING)
        process = sum(positive(row, col) for col in PROCESS)
        total = positive(row, TOTAL)
        if total <= 0 and hvac + lighting + process > 0:
            raise ValueError("Nonzero end use without a positive total")
        if hvac + lighting + process > total and total > 0:
            scale = total / (hvac + lighting + process)
            hvac, lighting, process = hvac * scale, lighting * scale, process * scale
        other = max(0.0, total - hvac - lighting - process)
        whole_year.append((ts, [hvac, lighting, process, other]))
    annual = sum(sum(vals) for _, vals in whole_year)
    if annual <= 0:
        raise ValueError(f"ComStock annual electricity is zero: {archetype}")
    shares = [
        sum(values[i] for _, values in whole_year) / annual
        for i in range(4)
    ]
    selected = [
        [round(4 * value / annual, 12) for value in values]
        for ts, values in whole_year
        if START <= ts < END
    ]
    if len(selected) != EXPECTED_WINDOW:
        raise ValueError(f"Expected {EXPECTED_WINDOW} window rows for {archetype}, got {len(selected)}")
    if sum(shares) < .999999 or sum(shares) > 1.000001:
        raise ValueError(f"End uses failed to reconcile for {archetype}: {shares}")
    print(f"{archetype}: {len(selected)} intervals, annual end-use shares {[round(x,3) for x in shares]}", flush=True)
    return {
        "source_url": url,
        "annual_shares": [round(s, 9) for s in shares],
        "factors": selected,
    }


def main() -> None:
    output = {
        "dataset": DATASET,
        "county": "Middlesex County, NJ",
        "county_gisjoin": COUNTY,
        "period_start": "2018-09-01",
        "period_end": "2018-11-30",
        "interval_minutes": 15,
        "component_order": ["hvac", "lighting", "process", "other"],
        "units": "kW per annual kWh; factor * building annual electricity kWh",
        "types": {kind: fetch(kind) for kind in ARCHETYPES},
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(filename=str(OUTPUT), mode="wb", compresslevel=9, mtime=0) as target:
        target.write(json.dumps(output, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    print("Prepared", OUTPUT, OUTPUT.stat().st_size, "bytes", flush=True)


if __name__ == "__main__":
    main()
