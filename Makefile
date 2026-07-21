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

assets: ## Regenerate the README screenshots and hero GIF (demo data only)
	@echo "==> demo stills + hero.gif"
	cd web && bun run build:demo
	bun scripts/capture.ts
	@echo "==> the terminal, against a throwaway repo"
	cd web && bun run build
	bun scripts/capture-live.ts
	@echo "==> done — review .github/assets before committing"

demo-feed: ## Stream fabricated demo events into a running server
	python3 hooks/seed_demo.py

# --- desktop app -------------------------------------------------------------
# The desktop app is Electron: it runs the exact web/ UI in Chromium (which
# GPU-composites, where WebKitGTK fell back to software), and brings the Bun
# server up with it. The web UI loads over loopback HTTP so it reaches the
# server on :4000 the same way a browser tab does — no address pinning needed.

desktop: ## Run the desktop app (builds the UI, then launches Electron + sidecar)
	cd web && bun run build
	cd electron && bun run start

desktop-dev: ## Run the desktop app against an already-running dev server
	cd electron && bun run start

desktop-dist: ## Package installable binaries for the host platform (electron-builder)
	cd electron && bun run dist

desktop-dist-linux: ## Package Linux binaries (AppImage + deb)
	cd electron && bun run dist:linux

desktop-install: ## Install the built app for this user (no root)
	electron/install-local.sh

desktop-update: ## Pull the latest and reinstall the desktop app (fast-forward only)
	git pull --ff-only
	bun install
	$(MAKE) desktop-install

# Open the cockpit for ONE project: only that repo (and its worktrees) appear,
# and the dashboard shows that project's work rather than the whole machine.
# Without DIR it covers every project, as before.
desktop-open: ## Open the desktop app scoped to a project — make desktop-open DIR=/path/to/repo
	@test -n "$(DIR)" || { echo "usage: make desktop-open DIR=/path/to/repo" >&2; exit 1; }
	AGENTGLASS_PROJECT="$(DIR)" ~/.local/share/agentglass-desktop/agentglass

.PHONY: help install dev server web build test smoke typecheck start setup setup-undo connect connect-undo demo-feed assets \
        desktop desktop-dev desktop-dist desktop-dist-linux desktop-install desktop-update desktop-open
