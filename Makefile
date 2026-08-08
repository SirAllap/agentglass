# agentglass — one-command entry points.
# Every target is self-documented with a `## description`; the in-app terminal
# (press `t`) surfaces this exact list in its ⚙ commands menu, ready to run.

.DEFAULT_GOAL := help

help: ## List every make command with what it does
	@grep -hE '^[A-Za-z0-9_.-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[36mmake %-14s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies (bun)
	bun install

# `trap 'kill 0'` tears the whole process group (concurrently, bun --watch, the
# server, vite) down on Ctrl-C or a SIGTERM to make, so an abandoned `make dev`
# leaves nothing behind. The server also carries its own parent-death watchdog
# (AGENTGLASS_DIE_WITH_PARENT, set in server/package.json's dev script) as the
# backstop for the SIGKILL case this trap cannot catch.
dev: ## Run server (:4000) + web dashboard (:6180) together, live-reload
	trap 'kill 0' INT TERM; bun run dev

server: ## Run only the Bun + SQLite server on :4000
	bun run dev:server

web: ## Run only the Vite dashboard on :6180
	bun run dev:web

build: ## Production build of the web dashboard (web/dist)
	bun run build

# This said "what CI runs" and ran one of the six things CI runs. `make ci`
# below is the target that can honestly make that claim; this one is the fast
# half you run while working, and the timeout matches CI's for the same reason
# CI has it.
test: ## Run the server + web test suites (the fast half — `make ci` runs everything CI does)
	cd server && bun test --timeout 20000
	cd web && bun test

# Every step of both CI jobs, in the order .github/workflows/ci.yml declares
# them. `make smoke` and `make perf` are the same scripts those steps run, and
# smoke depends on `build`, which is CI's "Build web".
#
# `headcheck` is the one target here that CI does NOT have a step for, and on
# purpose: actions/checkout hands every job a pristine tree of the commit, so
# up there the typecheck steps below ARE the head check. Down here they are
# not — work-2026-08-05 is never pushed, and a dirty tree is its normal state.
# It goes first because it is the cheapest thing in this list and the only one
# that can fail on something none of the others can see.
ci: ## Run everything CI runs, in CI's order — plus headcheck, which only a local tree needs
	$(MAKE) headcheck
	bun scripts/logo.mjs --check
	cd web && bun run typecheck
	cd server && bun run typecheck
	cd server && bun test --timeout 20000
	cd web && bun test
	$(MAKE) mobile-test
	$(MAKE) smoke
	$(MAKE) perf

# `npm ci` and not `npm install`, because that is what the CI job runs — which
# means it deletes and rebuilds mobile/node_modules, and regenerates
# engine.generated.ts and nerdfont.generated.ts through the postinstall.
mobile-test: ## Install and check the phone app exactly as CI's mobile job does (npm ci wipes mobile/node_modules)
	cd mobile && npm ci
	cd mobile && npm run typecheck
	cd mobile && npm test

# The scripts kill the server/Chrome they spawn on their own SIGINT/SIGTERM;
# `trap 'kill 0'` here is the group-wide backstop for a SIGTERM aimed at make.
smoke: build ## Boot the production bundle in headless Chrome — fails on a blank screen or any console error
	trap 'kill 0' INT TERM; bun scripts/smoke.ts

perf: ## Check the server still answers while it works — fails if the event loop (and so the terminal) stalls
	trap 'kill 0' INT TERM; bun scripts/perfbudget.ts

soak: ## Run the server hard for a few minutes and fail if its memory keeps climbing (AGX_SOAK_MINUTES=30 for a real one)
	trap 'kill 0' INT TERM; bun scripts/soak.ts

loadtest: ## Hammer the server (many clients × every panel) against a copy of the REAL DB and fail if the PTY stutters (AGX_LOAD_CLIENTS=10 for heavier)
	trap 'kill 0' INT TERM; bun scripts/loadtest.ts

# `bun run typecheck`, not `bunx tsc`: bunx downloads the newest published
# TypeScript when the directory has none, which is how server/ ended up being
# checked by 7.0.2 while web/ used 5.9.3. Both declare it now, and `bun run`
# fails loudly instead of fetching. web's script covers src AND test/.
typecheck: ## Type-check both halves, app and tests (vite build and bun both strip types without checking)
	cd web && bun run typecheck
	cd server && bun run typecheck

# The target above reads your DESK. This one reads the COMMIT, and they are not
# the same question on this branch: work-2026-08-05 is the trunk every session
# commits into and rebuilds from, so its working tree is always dirty and the
# commit is what everyone else actually gets.
#
# 5d2ac02 is why it exists. A `git add -A` in the shared worktree committed
# another session's *use* of a `PanesResponse` type without its declaration, and
# `bun run typecheck` stayed green in every tree on the machine for a day —
# everyone had the good shared/types.ts uncommitted on disk. It was found by
# accident. `make headcheck REF=5d2ac02` still fails on it, in 9 seconds.
headcheck: ## Type-check the COMMIT in a clean extraction of itself — the check a dirty tree cannot fake (make headcheck REF=<sha>)
	bun scripts/headcheck.ts $(REF)

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

connect-opencode: ## Deploy the agentglass plugin into OpenCode (reports to /ingest)
	python3 hooks/connect_opencode.py

connect-opencode-undo: ## Remove the agentglass OpenCode plugin again
	python3 hooks/connect_opencode.py --undo

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

.PHONY: help install dev server web build test ci mobile-test smoke perf soak loadtest typecheck headcheck start setup setup-undo connect connect-undo connect-opencode connect-opencode-undo demo-feed assets \
        desktop desktop-dev desktop-dist desktop-dist-linux desktop-install desktop-update desktop-open
