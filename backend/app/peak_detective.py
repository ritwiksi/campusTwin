"""Peak Detective: Snowflake SQL analysis with offline, honestly labeled fallbacks.

The queries analyze BASELINE modeled Rutgers demand, not measured meter readings.
No query or database failure is allowed to break the regular Campus Twin demo.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import lru_cache
import json
import os
from pathlib import Path

from . import comstock, model

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "data/snowflake_snapshots/peaks.json"
CAMPUSES = ("Busch", "Livingston", "College Avenue")

# All campus peak identification, end-use aggregation and building contribution
# ranking below take place IN SNOWFLAKE when Snowflake is enabled or a snapshot
# is exported. The app never labels a locally computed preview as Snowflake.
PEAK_SQL = """
WITH building_loads AS (
  SELECT b.CAMPUS,
         p.FRAME,
         b.BUILDING_ID,
         b.BUILDING_NAME,
         b.ANNUAL_KWH * p.HVAC_FACTOR AS HVAC_KW,
         b.ANNUAL_KWH * p.LIGHTING_FACTOR AS LIGHTING_KW,
         b.ANNUAL_KWH * p.PROCESS_FACTOR AS PROCESS_KW,
         b.ANNUAL_KWH * p.OTHER_FACTOR AS OTHER_KW,
         b.ANNUAL_KWH * (
           p.HVAC_FACTOR + p.LIGHTING_FACTOR + p.PROCESS_FACTOR + p.OTHER_FACTOR
         ) AS DEMAND_KW,
         b.ANNUAL_KWH * (
           p.HVAC_FACTOR * b.HVAC_REDUCTION_FRACTION
           + p.LIGHTING_FACTOR * b.LED_REDUCTION_FRACTION
         ) AS LED_HVAC_REDUCTION_KW
  FROM BUILDINGS b
  JOIN COMSTOCK_PROFILES p ON p.COMSTOCK_TYPE = b.COMSTOCK_TYPE
),
campus_loads AS (
  SELECT CAMPUS, FRAME,
         SUM(DEMAND_KW) AS PEAK_KW,
         SUM(HVAC_KW) AS CAMPUS_HVAC_KW,
         SUM(LIGHTING_KW) AS CAMPUS_LIGHTING_KW,
         SUM(PROCESS_KW) AS CAMPUS_PROCESS_KW,
         SUM(OTHER_KW) AS CAMPUS_OTHER_KW,
         SUM(LED_HVAC_REDUCTION_KW) AS LED_HVAC_REDUCTION_KW
  FROM building_loads
  GROUP BY CAMPUS, FRAME
),
ranked_peaks AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY CAMPUS ORDER BY PEAK_KW DESC, FRAME ASC) AS PEAK_RANK
  FROM campus_loads
),
contributors AS (
  SELECT b.*, p.PEAK_KW, p.CAMPUS_HVAC_KW, p.CAMPUS_LIGHTING_KW,
         p.CAMPUS_PROCESS_KW, p.CAMPUS_OTHER_KW,
         p.LED_HVAC_REDUCTION_KW AS CAMPUS_LED_HVAC_REDUCTION_KW,
         ROW_NUMBER() OVER (
           PARTITION BY b.CAMPUS ORDER BY b.DEMAND_KW DESC, b.BUILDING_ID ASC
         ) AS CONTRIBUTOR_RANK
  FROM building_loads b
  JOIN ranked_peaks p
    ON b.CAMPUS = p.CAMPUS AND b.FRAME = p.FRAME AND p.PEAK_RANK = 1
)
SELECT CAMPUS, FRAME, PEAK_KW, CAMPUS_HVAC_KW, CAMPUS_LIGHTING_KW,
       CAMPUS_PROCESS_KW, CAMPUS_OTHER_KW, CAMPUS_LED_HVAC_REDUCTION_KW,
       BUILDING_ID, BUILDING_NAME, DEMAND_KW, HVAC_KW, LIGHTING_KW,
       PROCESS_KW, OTHER_KW, CONTRIBUTOR_RANK
FROM contributors
WHERE CONTRIBUTOR_RANK <= 5
ORDER BY CAMPUS, CONTRIBUTOR_RANK
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _frame_date(frame: int) -> str:
    return (datetime(2018, 9, 1) + timedelta(minutes=15 * frame)).isoformat(timespec="minutes")


def _base_report(source: str, generated_at: str | None = None) -> dict:
    return {
        "source": source,
        "generated_at": generated_at,
        "description": "Modeled baseline ComStock electricity peaks across 26 selected Rutgers buildings, not measured campus demand",
        "campuses": [],
    }


def _format_rows(rows: list[dict], source: str, generated_at: str | None) -> dict:
    report = _base_report(source, generated_at)
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        r = {str(k).lower(): v for k, v in row.items()}
        grouped.setdefault(str(r["campus"]), []).append(r)
    for campus in CAMPUSES:
        group = grouped.get(campus)
        if not group:
            raise ValueError("Snowflake returned no peak for " + campus)
        head = group[0]
        peak_kw = float(head["peak_kw"])
        frame = int(head["frame"])
        if not 0 <= frame < comstock.INTERVALS or peak_kw <= 0:
            raise ValueError("Invalid Snowflake peak")
        ranking = sorted(group, key=lambda r: int(r["contributor_rank"]))
        report["campuses"].append({
            "campus": campus,
            "frame": frame,
            "timestamp": _frame_date(frame),
            "peak_kw": peak_kw,
            "led_hvac_reduction_at_peak_kw": float(head["campus_led_hvac_reduction_kw"]),
            "end_uses_kw": {
                "hvac": float(head["campus_hvac_kw"]),
                "lighting": float(head["campus_lighting_kw"]),
                "equipment": float(head["campus_process_kw"]),
                "other": float(head["campus_other_kw"]),
            },
            "top_buildings": [{
                "id": str(r["building_id"]),
                "name": str(r["building_name"]),
                "kw": float(r["demand_kw"]),
                "share_pct": 100.0 * float(r["demand_kw"]) / peak_kw,
                "hvac_kw": float(r["hvac_kw"]),
                "lighting_kw": float(r["lighting_kw"]),
            } for r in ranking],
        })
    return report


def snowflake_connection():
    # Reuses Temple Twin's Snowflake Python connector + env-based connection
    # convention, not its unrelated Cortex text-completion functionality.
    import snowflake.connector
    required = ("SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD",
                "SNOWFLAKE_WAREHOUSE", "SNOWFLAKE_DATABASE", "SNOWFLAKE_SCHEMA",
                "SNOWFLAKE_ROLE")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise RuntimeError("Missing Snowflake configuration: " + ", ".join(missing))
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        password=os.environ["SNOWFLAKE_PASSWORD"],
        warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
        database=os.environ["SNOWFLAKE_DATABASE"],
        schema=os.environ["SNOWFLAKE_SCHEMA"],
        role=os.environ["SNOWFLAKE_ROLE"],
        login_timeout=8, network_timeout=10,
        session_parameters={"QUERY_TAG": "campus_twin_peak_detective"},
    )


def query_snowflake() -> dict:
    import snowflake.connector
    connection = snowflake_connection()
    try:
        with connection.cursor(snowflake.connector.DictCursor) as cursor:
            cursor.execute(PEAK_SQL)
            report = _format_rows(cursor.fetchall(), "live", _now())
    finally:
        connection.close()
    return report


@lru_cache(maxsize=1)
def local_preview() -> dict:
    """Exact same static baseline formula, as a LOCAL preview only.

    Local results never claim to originate from Snowflake. This fallback keeps
    the normal app demo working until a real Snowflake snapshot is generated.
    """
    profiles = comstock.load()["types"]
    original = model.evaluate()["buildings"]
    full_plan = {"buildings": {b["id"]: {"led": True, "hvac": True} for b in original}}
    upgraded = {b["id"]: b for b in model.evaluate(full_plan)["buildings"]}
    report = _base_report("local")
    for campus in CAMPUSES:
        members = [b for b in original if b["campus"] == campus]
        peak_kw, peak_frame = -1.0, -1
        for frame in range(comstock.INTERVALS):
            total = sum(
                b["electric_mwh"] * 1000 * sum(profiles[b["comstock_type"]]["factors"][frame])
                for b in members
            )
            if total > peak_kw:
                peak_kw, peak_frame = total, frame
        contributions = []
        end_uses = [0.0, 0.0, 0.0, 0.0]
        potential = 0.0
        for b in members:
            factors = profiles[b["comstock_type"]]["factors"][peak_frame]
            components = [b["electric_mwh"] * 1000 * f for f in factors]
            end_uses = [a + v for a, v in zip(end_uses, components)]
            up = upgraded[b["id"]]
            potential += components[0] * up["hvac_reduction_fraction"]
            potential += components[1] * up["led_reduction_fraction"]
            demand = sum(components)
            contributions.append({
                "id": b["id"], "name": b["name"],
                "kw": demand,
                "share_pct": 100 * demand / peak_kw,
                "hvac_kw": components[0], "lighting_kw": components[1],
            })
        contributions.sort(key=lambda c: (-c["kw"], c["id"]))
        report["campuses"].append({
            "campus": campus, "frame": peak_frame, "timestamp": _frame_date(peak_frame),
            "peak_kw": peak_kw, "led_hvac_reduction_at_peak_kw": potential,
            "end_uses_kw": dict(zip(("hvac", "lighting", "equipment", "other"), end_uses)),
            "top_buildings": contributions[:5],
        })
    return report


def get_report() -> dict:
    enabled = os.environ.get("SNOWFLAKE_ENABLED", "false").lower() in ("true", "1", "yes")
    live_failed = False
    if enabled:
        try:
            return query_snowflake()
        except Exception:
            # Never expose connector errors, secrets, or call the data live.
            live_failed = True
    if SNAPSHOT.exists():
        try:
            report = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
            if not isinstance(report.get("campuses"), list) or len(report["campuses"]) != 3:
                raise ValueError("Incomplete peak snapshot")
            if not report.get("generated_at") or report.get("generated_from") != "snowflake":
                raise ValueError("Snapshot missing Snowflake provenance")
            report["source"] = "snapshot"
            if live_failed:
                report["notice"] = "Snowflake unavailable; showing a saved Snowflake result."
            return report
        except (OSError, ValueError, KeyError, TypeError):
            pass
    report = local_preview().copy()
    report["notice"] = ("Snowflake unavailable; " if live_failed else "") + (
        "Local preview only. Run the Snowflake loader to generate a verified snapshot."
    )
    return report
