# Rutgers Twin — Campus Decarbonization Studio

A 15-building, map-first Rutgers Busch/Livingston planning tool. Based on historical Rutgers climate reports. Reuses TempleTwin's React, TypeScript, Vite, CesiumJS / Google Photorealistic 3D Tiles, FastAPI, and Docker/nginx stack — without Tiger Data, Snowflake, live energy APIs or authentication.

## Local development

First terminal (repository root):

    python -m pip install -r backend/requirements-dev.txt
    python -m uvicorn app.main:app --app-dir backend --reload --port 8000

Second terminal:

    cp .env.example .env
    # Add your VITE_CESIUM_ION_TOKEN to .env
    npm ci
    npm run dev

Open localhost:5173. Google Photorealistic 3D Tiles require a Cesium token and online access even though all model data are cached. Without a token the app shows a clearly labeled visual placeholder rather than fake 3D.

Verification:

    python -m pytest -q backend/tests
    python scripts/calibrate.py
    npm run build

Docker: export/set VITE_CESIUM_ION_TOKEN, then docker compose up --build. Open localhost:80.

## Source methodology

15 real named polygons cached in data/buildings.json were selected from the historical open-source XBus mirror of Rutgers campus maps: https://github.com/mileskrell/xbus/blob/master/geojson/Rutgers%20buildings.geojson . This is NOT a direct OSM/Overpass export; map snapshot date has not been established. Floor area, number of floors, use, and district connection are **estimates/assumptions**, stored in the data pack.

Model parameter register with source URLs, historical vintages and SOURCED / DERIVED / ASSUMPTION tags: data/config.json. Rutgers 2021 WG1 energy report: https://climatetaskforce.rutgers.edu/wp-content/uploads/sites/332/2021/01/WG1_Phase2Report.pdf . Rutgers FY2017–18 utility table: https://construction.rutgers.edu/sustainable-consumption-production-fiscal-year .

Modeled area-weighted annual site EUI is normalized to Busch/Livingston's 161 kBtu/ft²/yr; category weights derive from Mid-Atlantic CBECS as cited in WG1. The 35/65 electricity/thermal split is ASSUMED. Grid carbon 0.34 t/MWh and thermal gas 0.054 t/MMBtu are historical/blended simplifications, not current grid factors. Historical cogen fuel and electricity output must not be naively added. Solar 1.1 MWh/kW-year, installed cost $1,830/kW (2018), assumed 50% roof utilization and 0.012 kW/usable ft². Historical NJ TREC $152/MWh is NOT included in modeled annual savings. T1 15% retrofit thermal savings are assumed; T2 uses report-cited 39% electricity / 29% thermal. Assumed gas price $9/MMBtu. T2 installed cost $80M/28M ft²; T1 half assumed.

The optimizer uses scipy.optimize.milp and is exact only for the simplified annual formulation: one efficiency tier per building, rooftop solar constrained by both roof and residual electricity, capital <= budget. Offsite clean power / RNG are excluded by default, otherwise bounded by a separate annual operating-premium budget. No global real-world optimum is claimed.

## Important limits

**MODELED ESTIMATES ONLY.** Rutgers does not publish consistent metered per-building consumption. Results represent 15 selected buildings, not the university. The app is a preliminary planning tool, not an engineering study. Roof solar overlays are schematic, not engineering layouts. Utilities, costs and emission factors are historical. A calibration sanity-check script compares sample values against scaled B/L campus usage using an explicitly assumed 10M ft² B/L campus floor-area proxy; this is NOT a validation.

Endpoints: GET /api/health, GET /api/config, GET /api/buildings, POST /api/evaluate, POST /api/optimize.
