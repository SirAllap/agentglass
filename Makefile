# agentglass — one-command entry points.
# Every target is self-documented with a `## description`; the in-app terminal
# (press `t`) surfaces this exact list in its ⚙ commands menu, ready to run.

.DEFAULT_GOAL := help

help: ## List every make command with what it does
	@grep -hE '^[A-Za-z0-9_.-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36mmake %-14s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies (bun)
	bun install

dev: ## Run server (:4000) + web dashboard (:6180) together, live-reload
	bun run dev

server: ## Run only the Bun + SQLite server on :4000
	bun run dev:server

web: ## Run only the Vite dashboard on :6180
	bun run dev:web

build: ## Production build of the web dashboard (web/dist)
	bun run build

test: ## Run the server test suite (what CI runs)
	cd server && bun test

smoke: build ## Boot the production bundle in headless Chrome — fails on a blank screen or any console error
	bun scripts/smoke.ts

typecheck: ## Type-check both halves (vite build and bun both strip types without checking)
	cd web && bunx tsc --noEmit
	cd server && bunx tsc --noEmit

start: ## Run the server in production mode
	bun run start

setup: ## Wire Claude Code hooks globally (~/.claude/settings.json)
	python3 hooks/install_hooks.py

setup-undo: ## Remove the Claude Code hooks again
	python3 hooks/install_hooks.py --uninstall

connect: ## Auto-connect OTel-capable CLIs (Codex, Gemini, …) to agentglass
	python3 hooks/connect_otel.py

connect-undo: ## Undo the OTel auto-connect
	python3 hooks/connect_otel.py --undo

demo-feed: ## Stream fabricated demo events into a running server
	python3 hooks/seed_demo.py

# --- desktop app -------------------------------------------------------------
# The server is compiled to a standalone binary and shipped as a Tauri sidecar,
# so the app carries its own backend. The frontend is pinned to the server's
# real address because inside the app window `location.hostname` is the Tauri
# scheme, not localhost.

TRIPLE := $(shell rustc -vV | sed -n 's/^host: //p')

desktop-server: ## Compile the server to a standalone binary (Tauri sidecar)
	bun build --compile server/src/index.ts \
	  --outfile src-tauri/bin/agentglass-server-$(TRIPLE)

desktop-web: ## Build the dashboard for the desktop window
	cd web && VITE_CW_SERVER=http://localhost:4000 bun run build

desktop: desktop-server desktop-web ## Build the desktop app (icon + native window)
	bunx tauri build

desktop-dev: desktop-server ## Run the desktop app against the live dev server
	bunx tauri dev

desktop-install: ## Install the built app for this user (~/.local, no root)
	src-tauri/install-local.sh

# Open the cockpit for ONE project: only that repo (and its worktrees) appear,
# and the dashboard shows that project's work rather than the whole machine.
# Without DIR it covers every project, as before.
desktop-open: ## Open the desktop app scoped to a project — make desktop-open DIR=/path/to/repo
	@test -n "$(DIR)" || { echo "usage: make desktop-open DIR=/path/to/repo" >&2; exit 1; }
	~/.local/share/agentglass/agentglass "$(DIR)"

.PHONY: help install dev server web build test smoke typecheck start setup setup-undo connect connect-undo demo-feed \
        desktop desktop-server desktop-web desktop-dev desktop-install desktop-open
