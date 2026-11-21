# Snowflake Peak Detective snapshots

The verified `peaks.json` snapshot is created by `python scripts/snowflake_peaks.py` **after it actually queries Snowflake**. Never check in fabricated results. Until that command is run, the API uses an honestly labeled local preview. Once created, commit `peaks.json` to the `rutgers-twin` branch for an offline-safe demo.
