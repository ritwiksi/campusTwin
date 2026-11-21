# Campus Twin — 3D Campus Digital Twin

A 26-building, map-first Rutgers Busch/Livingston/College Avenue planning tool. Based on historical Rutgers climate reports. Reuses TempleTwin's React, TypeScript, Vite, CesiumJS / Google Photorealistic 3D Tiles, FastAPI, and Docker/nginx stack.

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

26 real named polygons cached in data/buildings.json were selected from the historical open-source XBus mirror of Rutgers campus maps: https://github.com/mileskrell/xbus/blob/master/geojson/Rutgers%20buildings.geojson . This is NOT a direct OSM/Overpass export; map snapshot date has not been established. Floor area, number of floors, use, and district connection are **estimates/assumptions**, stored in the data pack.

Model parameter register with source URLs, historical vintages and SOURCED / DERIVED / ASSUMPTION tags: data/config.json. Rutgers 2021 WG1 energy report: https://climatetaskforce.rutgers.edu/wp-content/uploads/sites/332/2021/01/WG1_Phase2Report.pdf . Rutgers FY2017–18 utility table: https://construction.rutgers.edu/sustainable-consumption-production-fiscal-year .

For the Busch/Livingston subset only, modeled area-weighted annual site EUI is normalized to 161 kBtu/ft²/yr; College Avenue uses explicit per-use EUI proxies because no College Avenue calibration data are included. Category weights derive from Mid-Atlantic CBECS as cited in WG1. The 35/65 electricity/thermal split is ASSUMED. Grid carbon 0.34 t/MWh and thermal gas 0.054 t/MMBtu are historical/blended simplifications, not current grid factors. Historical cogen fuel and electricity output must not be naively added. Solar 1.1 MWh/kW-year, installed cost $1,830/kW (2018), assumed 50% roof utilization and 0.012 kW/usable ft². Historical NJ TREC $152/MWh is NOT included in modeled annual savings. T1 15% retrofit thermal savings are assumed; T2 uses report-cited 39% electricity / 29% thermal. Assumed gas price $9/MMBtu. T2 installed cost $80M/28M ft²; T1 half assumed.

The optimizer uses scipy.optimize.milp and is exact only for the simplified annual formulation: one efficiency tier per building, rooftop solar constrained by both roof and residual electricity, capital <= budget. Offsite clean power / RNG are excluded by default, otherwise bounded by a separate annual operating-premium budget. No global real-world optimum is claimed.

## NREL ComStock dataset

The pinned `2021/comstock_amy2018_release_1` **Middlesex County, NJ (GISJOIN `g3400230`)** aggregate data were downloaded from the public NREL/OEDI dataset. The September–November 2018 portion contains **8,736 consecutive 15-minute intervals per archetype**. For each interval, separate electricity end uses are retained: HVAC (heating/cooling/fans/pumps), lighting (interior/exterior), process/equipment, and other.

The compressed, offline-first cache lives in `data/comstock/middlesex_amy2018.json.gz` (~550 KB). `scripts/prepare_comstock.py` regenerates it from the source CSV files, checks every 15-minute timestamp, reconciles end-use electricity to the published total, and normalizes each 15-minute end-use profile by the **full-year county electricity total**. The normalized shape is scaled by each selected Rutgers building's **estimated annual electricity kWh** (not real building meter data).

Archetype mapping is explicit and approximate: **Residence/Housing → largehotel**, **Office/Administration → mediumoffice**, **Dining → fullservicerestaurant**, and **other uses, including laboratories and athletics → secondaryschool** because the 2021 ComStock release does not contain accurate university laboratory and sports archetypes. Do not mistake archetype proxies for occupancy-specific campus data.

Backend `GET /api/comstock` serves the compressed cache from disk; no runtime OEDI download is required. The frontend uses the cached end-use shapes for its continuous timeline and per-building breakdown. Solar does not directly lower gross building electricity; it offsets annual purchased grid electricity, with a historical annual yield estimate.

## Interventions

The building detail view has three independent switches copied from Temple Twin's layout:

- **LED:** compares ASHRAE 90.1-2004 lighting power density with the newer 90.1-2019 target, applying the ratio **only** to estimated lighting electricity. The baseline lighting MWh is now taken from the NREL ComStock archetype lighting share. No measured fixture inventory is claimed.
- **HVAC controls:** applies Temple Twin's PNNL-based maximum **6% whole-building electricity savings**, bounded by ComStock's HVAC electricity share. This is a scenario, not observed retrofit savings.
- **Solar:** fills assumed usable roof capacity, capped to residual annual electric demand, at the Rutgers-reported historical PV yield. A patterned dark-blue roof overlay is rendered in screen space **above** Google 3D imagery, independent of unreliable 3D Tiles classification. It is a schematic visualization, not a real panel layout. Solar reduces grid imports, **not building demand**.

LED and HVAC savings stack, solar acts on the remaining demand, and turning a switch off returns to the previous scenario. All three are selected per building in the Energy tab. The old Standard/Deep retrofits were removed from the UI; the legacy optimizer API is retained but not used by that interface.

## Important limits

**MODELED ESTIMATES ONLY.** Rutgers does not publish consistent metered per-building consumption. Results represent 26 selected buildings, not the university. The app is a preliminary planning tool, not an engineering study. Roof solar overlays are schematic, not engineering layouts. Utilities, costs and emission factors are historical. A calibration sanity-check script compares sample values against scaled B/L campus usage using an explicitly assumed 10M ft² B/L campus floor-area proxy; this is NOT a validation.

The app uses Temple Twin's original light-green visual system and exact daily W/ft² z-score heatmap color formula. Its September–November 2018 15-minute demand shapes are now drawn from NREL's real ComStock 2021 AMY2018 **Middlesex County, NJ** archetype aggregates, not analytic/cosine curves. The displayed annual magnitude is still calibrated to estimated Rutgers building use; the ComStock series are simulations of commercial building archetypes and are NOT Rutgers interval meter readings. Campus buttons reposition a single Cesium scene among Busch, Livingston, and College Avenue. LED/HVAC interventions modify the corresponding ComStock end-use curves, while Solar reduces annual grid import and creates schematic rooftop panels. Rooftop solar generation is not yet weather-resolved on the timeline.

Endpoints: GET /api/health, GET /api/config, GET /api/buildings, **GET /api/comstock**, POST /api/evaluate, POST /api/optimize.

## Publish for the hackathon 

Single Render Free Web Service using `Dockerfile.render` and `render.yaml`:

[Deploy Campus Twin to Render](https://render.com/deploy?repo=https://github.com/ritwiksi/campusTwin/tree/rutgers-twin)

1. Sign into Render and approve connecting this public GitHub branch.
2. Select the Free web-service instance defined in render.yaml. It uses **one container** to host both React assets and the FastAPI model on the same origin, without a database.
3. In Render's environment-variable prompt enter `CESIUM_ION_TOKEN` using a freshly rotated **public/browser access token** from your Cesium ion account. The token is delivered to the browser at runtime by `GET /api/runtime-config`; restrict permitted URLs/domains in Cesium ion. Never commit it to GitHub or paste a private account credential into the app.
4. Deploy. Confirm `/api/health` returns JSON and `/api/buildings` shows the sample; in Energy, select a building and toggle LED, HVAC, and Solar to see the map and figures change.

The 3D layer still requires Cesium ion/Google Photorealistic 3D Tiles network access. A Free Render instance sleeps after 15 minutes idle and can take about a minute to wake; open the URL well before presenting. The public Cesium token is necessarily visible to browsers; minimize scope. `Dockerfile.render` does not put the token in a frontend build argument.

Development can still use `VITE_CESIUM_ION_TOKEN` from a local untracked `.env`; on Render the production variable is `CESIUM_ION_TOKEN`, not the Vite build variable. The regular two-container `docker-compose.yml` remains for local Docker use.

## Snowflake Peak Detective (optional sponsor feature)

The **Find peak** button in the Energy overview runs a modeled campus electricity peak investigation. It jumps the 15-minute timeline to the maximum **baseline** aggregate demand in the 91-day NREL ComStock window, shows the five largest building contributors, and outlines the top three on the map. The feature also calculates potential reductions **at that baseline peak interval** if LED+HVAC upgrades were applied to all included buildings. This is not an estimate of the new post-upgrade peak, and solar is excluded because current solar output is annual-only.

**Real Snowflake computation:** the query in `backend/app/peak_detective.py` joins the 34,944 quarter-hour/end-use profile rows to 26 modeled building annual electric baselines; in-warehouse SQL computes more than 200,000 building-interval demand values, aggregates campus time series, identifies maximum demand using a window function, and ranks building contributions. It does not use Cortex or an LLM.

### Run Snowflake and generate the real snapshot

1. In Snowflake, create or choose a database, writable schema, and an XS warehouse with auto-suspend around 60 seconds. For example, use database `CAMPUS_TWIN` and schema `RUTGERS_TWIN`. Your role needs USAGE on these objects and CREATE TABLE, INSERT, SELECT, and table-stage access.
2. Copy `.env.example` to local untracked `.env`. Fill `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, `SNOWFLAKE_ROLE`, and either `SNOWFLAKE_PASSWORD` for password login or `SNOWFLAKE_AUTHENTICATOR=externalbrowser` for your own SSO-enabled local login. Do not paste passwords into chat or commit `.env`.
3. Run `python -m pip install -r scripts/requirements-snowflake.txt`.
4. Run `python scripts/snowflake_peaks.py`. This idempotently loads `BUILDINGS` and `COMSTOCK_PROFILES` into Snowflake using compressed staged CSV, **runs the analysis in Snowflake**, then writes `data/snowflake_snapshots/peaks.json` with a generation timestamp and provenance marker. Check the printed peak values.
5. Commit the generated `data/snowflake_snapshots/peaks.json` to `rutgers-twin` so Render serves the verified Snowflake snapshot with no runtime credentials or dependencies. To refresh an existing loaded dataset, run `python scripts/snowflake_peaks.py --snapshot-only`.

**Fail-safe behavior:** `SNOWFLAKE_ENABLED=false` is the production default. The endpoint `GET /api/analytics/peaks` reads a verified Snowflake snapshot when one exists; otherwise it runs a distinctly labeled **Local model preview — not Snowflake**. If enabled for live Snowflake and the query fails, the endpoint falls back to the timestamped snapshot (or local preview). The app's core 3D map, timeline, ComStock data, and interventions are independent of Snowflake. If you really enable live mode on the backend, install the optional Snowflake connector there and use a non-interactive server credential; browser SSO is only for a local snapshot-generation session.

**Tests:** `python -m pytest -q backend/tests` checks local energy accounting, rank ordering, offline operation, and snapshot/failure labels. Real Snowflake execution must be verified in your own account before you describe the sponsor feature as executed. No Snowflake-generated snapshot has been fabricated.
