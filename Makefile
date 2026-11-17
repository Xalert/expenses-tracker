# Short names for the npm scripts and Docker commands of docs/DEVELOPMENT.md. `make` alone lists them.
# The dev targets use the demo database `expenses_demo`; only `make dev-real` touches your real data (`expenses`).

COMPOSE_DEV := docker compose -f compose.dev.yaml
DEMO_URL := postgres://expenses:expenses@localhost:5432/expenses_demo
# Database for `make psql` (DB=expenses for the real one).
DB ?= expenses_demo

# The address a phone on the same network reaches this machine at (next.config.ts allows it for dev scripts).
LAN_HOST ?= $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}')
phone-hint = @if [ -n "$(LAN_HOST)" ]; then echo "Phone on the same network: open http://$(LAN_HOST):3000"; fi

.DEFAULT_GOAL := help
.PHONY: help install up down logs psql dev dev-real demo-reset check test watch typecheck lint build migration docker-up docker-down docker-logs

help:
	@echo "Fast path:  make dev     (dev Postgres + demo data if missing + dev server on :3000; user ID demo / demo-password)"
	@echo "Dev:        make up | down | logs | psql [DB=expenses] | demo-reset | dev-real (your REAL data)"
	@echo "Checks:     make check   (typecheck + lint + tests)"
	@echo "            make test [FILE=tests/money.test.ts] [NAME=JPY] | watch | typecheck | lint"
	@echo "Build:      make build | migration | docker-up | docker-down | docker-logs"
	@echo "Details: docs/DEVELOPMENT.md"

## Setup ----------------------------------------------------------------------

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

install: node_modules

## Development database (compose.dev.yaml, 127.0.0.1:5432) -------------------

# Fails early, naming the container, when another one (e.g. billy's Postgres) already publishes 5432.
up:
	@holder=$$(docker ps --filter publish=5432 --format '{{.Names}}' | grep -vx expenses-tracker-dev-db-1 | head -1); \
	if [ -n "$$holder" ]; then echo "Port 5432 is taken by container $$holder. Stop it with: docker stop $$holder"; exit 1; fi
	npm run -s db:up

# Data stays in the expenses-dev-pg volume.
down:
	npm run -s db:down

logs:
	$(COMPOSE_DEV) logs -f db

psql:
	$(COMPOSE_DEV) exec db psql -U expenses -d $(DB)

## Dev server -----------------------------------------------------------------

# The demo database, seeded if needed. Sign in as demo / demo-password.
dev: node_modules up
	$(phone-hint)
	npm run dev:demo

# Your real data in `expenses`.
dev-real: node_modules up
	$(phone-hint)
	npm run dev

# expenses_demo back to the fresh demo state, no prompt.
demo-reset: node_modules up
	npm run -s demo:reset

## Checks (no database needed: tests use PGlite) ------------------------------

check: node_modules
	npm run -s typecheck
	npm run -s lint
	npm test

# One file and/or the tests whose name matches: make test FILE=tests/users.test.ts NAME=changePassword
test: node_modules
	npx vitest run $(FILE) $(if $(NAME),-t "$(NAME)")

watch: node_modules
	npx vitest $(FILE) $(if $(NAME),-t "$(NAME)")

typecheck: node_modules
	npm run -s typecheck

lint: node_modules
	npm run -s lint

## Build ----------------------------------------------------------------------

build: node_modules
	npm run build

# After editing src/db/schema.ts (drizzle-kit may prompt, so run it in a terminal).
migration: node_modules
	npm run db:generate

# The real deployment artefact, built from source (docker-compose.yml, :3000). Stop `make dev` first: same port.
docker-up:
	docker compose up -d --build

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f
