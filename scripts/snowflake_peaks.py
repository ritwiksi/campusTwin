"""Load ComStock into Snowflake, compute actual peak ranks in SQL, cache result.

Run with credentials defined in local .env (never commit .env):
  pip install -r scripts/requirements-snowflake.txt
  python scripts/snowflake_peaks.py
The target database and schema must already exist and be writable.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env", override=False)

import snowflake.connector
from app import comstock, model
from app.peak_detective import PEAK_SQL, SNAPSHOT, _format_rows, _now, snowflake_connection


def load_data(connection) -> None:
    original = model.evaluate()["buildings"]
    plan = {"buildings": {b["id"]: {"led": True, "hvac": True} for b in original}}
    upgraded = {b["id"]: b for b in model.evaluate(plan)["buildings"]}
    with connection.cursor() as cursor:
        cursor.execute("""
          CREATE OR REPLACE TABLE BUILDINGS (
            BUILDING_ID VARCHAR, BUILDING_NAME VARCHAR, CAMPUS VARCHAR,
            COMSTOCK_TYPE VARCHAR, ANNUAL_KWH FLOAT,
            LED_REDUCTION_FRACTION FLOAT, HVAC_REDUCTION_FRACTION FLOAT
          )
        """)
        cursor.executemany(
            """INSERT INTO BUILDINGS (
               BUILDING_ID, BUILDING_NAME, CAMPUS, COMSTOCK_TYPE, ANNUAL_KWH,
               LED_REDUCTION_FRACTION, HVAC_REDUCTION_FRACTION
             ) VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            [(b["id"], b["name"], b["campus"], b["comstock_type"],
              b["electric_mwh"] * 1000,
              upgraded[b["id"]]["led_reduction_fraction"],
              upgraded[b["id"]]["hvac_reduction_fraction"]) for b in original],
        )
        print("Loaded", len(original), "buildings with modeled baseline energy.")
        cursor.execute("""
          CREATE OR REPLACE TABLE COMSTOCK_PROFILES (
            COMSTOCK_TYPE VARCHAR, FRAME INTEGER, HVAC_FACTOR FLOAT,
            LIGHTING_FACTOR FLOAT, PROCESS_FACTOR FLOAT, OTHER_FACTOR FLOAT
          )
        """)
        data = comstock.load()
        with TemporaryDirectory(prefix="campus_twin_sf_") as tmp:
            path = Path(tmp) / "comstock_profiles.csv.gz"
            with gzip.open(path, "wt", newline="", encoding="utf-8") as file:
                writer = csv.writer(file)
                writer.writerow(("COMSTOCK_TYPE", "FRAME", "HVAC_FACTOR", "LIGHTING_FACTOR",
                                 "PROCESS_FACTOR", "OTHER_FACTOR"))
                for kind, payload in data["types"].items():
                    for frame, factors in enumerate(payload["factors"]):
                        writer.writerow((kind, frame, *factors))
            # Bulk-load 34,944 rows using the Snowflake table stage, not 35k SQL INSERTs.
            cursor.execute(
                f"PUT file://{path.resolve().as_posix()} @%COMSTOCK_PROFILES "
                "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
            )
            cursor.execute("""
              COPY INTO COMSTOCK_PROFILES FROM @%COMSTOCK_PROFILES
              FILE_FORMAT = (TYPE = CSV COMPRESSION = GZIP SKIP_HEADER = 1)
              ON_ERROR = ABORT_STATEMENT PURGE = TRUE
            """)
        cursor.execute("SELECT COUNT(*) FROM COMSTOCK_PROFILES")
        count = int(cursor.fetchone()[0])
        expected = len(data["types"]) * comstock.INTERVALS
        if count != expected:
            raise RuntimeError(f"Profile load incomplete: {count} != {expected}")
        print("Loaded", count, "ComStock profile intervals into Snowflake.")


def export_snapshot(connection) -> dict:
    with connection.cursor(snowflake.connector.DictCursor) as cursor:
        cursor.execute(PEAK_SQL)
        result = _format_rows(cursor.fetchall(), "snapshot", _now())
    result["generated_from"] = "snowflake"
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print("Snowflake query ran; exported", SNAPSHOT)
    for campus in result["campuses"]:
        print(f"  {campus['campus']}: {campus['peak_kw']:.1f} kW "
              f"at {campus['timestamp']}; top building "
              f"{campus['top_buildings'][0]['name']}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot-only", action="store_true",
                        help="Regenerate snapshot from existing Snowflake tables")
    args = parser.parse_args()
    if os.environ.get("SNOWFLAKE_WAREHOUSE", "").upper() == "COMPUTE_WH":
        print("Tip: use an XS warehouse with auto-suspend set to 60 seconds.")
    connection = snowflake_connection()
    try:
        if not args.snapshot_only:
            load_data(connection)
        export_snapshot(connection)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
