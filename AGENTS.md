# Rutgers Twin contributor commands

Exact verification: npm ci; npm run build; python -m pip install -r backend/requirements-dev.txt; python -m pytest -q backend/tests; python scripts/calibrate.py.

Local run: python -m uvicorn app.main:app --app-dir backend --reload --port 8000; npm run dev.

No live building data. Main is not the development branch. Every model parameter needs provenance. No green claims without CI evidence.
