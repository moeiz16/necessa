# Necessa developer tasks. Everything runs without Docker or local models.
PY      := backend/.venv/bin/python
NPM     := npm --prefix frontend

.PHONY: help setup setup-backend setup-frontend dev api web seed data ingest ingest-fixtures \
        compile eval test test-backend test-frontend lint fmt typecheck clean

help:            ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: setup-backend setup-frontend  ## Install backend + frontend dependencies
	@test -f .env || cp .env.example .env

setup-backend:   ## Create the Python venv and install the API
	python3 -m venv backend/.venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e "backend[dev]"

setup-frontend:  ## Install the web app
	$(NPM) install

dev:             ## Run API (:8000) and web (:3000) together
	@$(MAKE) -j2 api web

api:             ## Run the FastAPI server with reload
	cd backend && .venv/bin/python -m uvicorn app.main:app --reload --port 8000

web:             ## Run the Next.js dev server
	$(NPM) run dev

seed:            ## Create tables and seed the demo organization (synthetic data)
	cd backend && .venv/bin/python -m app.cli db init && .venv/bin/python -m app.cli seed demo

data:            ## Download CMS MCD exports (requires ACCEPT_CMS_LICENSE=true)
	cd backend && .venv/bin/python -m app.cli ingest download

ingest:          ## Ingest the focus scope into Postgres/SQLite + Qdrant
	cd backend && .venv/bin/python -m app.cli ingest run --scope focus

ingest-fixtures: ## Ingest the bundled synthetic policies (offline, no license needed)
	cd backend && .venv/bin/python -m app.cli ingest fixtures

compile:         ## Compile criteria trees for ingested policies
	cd backend && .venv/bin/python -m app.cli criteria compile

eval:            ## Run the offline evaluation suites and write eval/reports
	cd backend && .venv/bin/python -m app.cli eval run --suite all

test: test-backend test-frontend  ## Run all tests

test-backend:    ## Backend unit + integration tests (SQLite, in-memory Qdrant, fake LLMs)
	cd backend && LLM_FAKE=true .venv/bin/python -m pytest -q

test-frontend:   ## Typecheck + lint + production build of the web app
	$(NPM) run lint && cd frontend && npx tsc --noEmit && npm run build

lint:            ## Lint everything
	cd backend && .venv/bin/python -m ruff check app tests
	$(NPM) run lint

fmt:             ## Auto-format backend
	cd backend && .venv/bin/python -m ruff format app tests && .venv/bin/python -m ruff check --fix app tests

typecheck:       ## Static type checks
	cd backend && .venv/bin/python -m mypy app
	cd frontend && npx tsc --noEmit

clean:           ## Remove caches and local dev databases
	find backend -name "__pycache__" -type d -prune -exec rm -rf {} +
	rm -rf backend/.pytest_cache backend/.ruff_cache backend/.mypy_cache backend/necessa-dev.db* frontend/.next
