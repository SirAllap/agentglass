#!/usr/bin/env python3
"""Auto-connect other AI-agent CLIs to agentglass via OpenTelemetry.

agentglass exposes an OTLP/HTTP trace receiver (JSON + protobuf) at
`<server>/v1/traces`. Any tool that emits OpenTelemetry GenAI (`gen_ai.*`) trace
spans can stream in — this script wires the ones that do, on install, the same
way `install_hooks.py` wires Claude Code. It's idempotent, backs up before it
writes, and never fails the install.

  python3 hooks/connect_otel.py               # detect + wire installed agent CLIs
  python3 hooks/connect_otel.py --undo        # unwire them again
  python3 hooks/connect_otel.py --postinstall # lifecycle mode (honors AGENTGLASS_NO_OTEL)

Currently wired automatically:
  * Gemini CLI       → ~/.gemini/settings.json   (OTLP traces → /v1/traces)
  * OpenAI Codex CLI → ~/.codex/config.toml       (OTLP logs   → /v1/logs)
"""
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

SERVER = os.environ.get("AGENTGLASS_SERVER", "http://localhost:4000").rstrip("/")

def _agentglass_local_only(url):
    """Refuse to send transcript/telemetry anywhere but this machine.
    AGENTGLASS_SERVER is attacker-influenceable (a repo-local settings.json can
    set it), and the payloads carry full session content. Opt out explicitly
    with AGENTGLASS_ALLOW_REMOTE=1 if you really run the server elsewhere."""
    import os
    from urllib.parse import urlparse
    if os.environ.get("AGENTGLASS_ALLOW_REMOTE"):
        return
    u = urlparse(url or "")
    if u.scheme not in ("http", "https") or (u.hostname or "") not in ("localhost", "127.0.0.1", "::1"):
        import sys
        sys.stderr.write("[agentglass] refusing non-local server %r\n" % url)
        sys.exit(0)



def _backup(path: Path) -> None:
    if path.exists():
        bak = path.with_name(path.name + f".bak.agentglass.{time.strftime('%Y%m%d-%H%M%S')}")
        shutil.copy2(path, bak)
        print(f"[agentglass] backup → {bak}")


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text()) if path.exists() else {}
    except Exception:
        return {}


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


# --- Gemini CLI ------------------------------------------------------------
GEMINI_SETTINGS = Path.home() / ".gemini" / "settings.json"


def gemini_installed() -> bool:
    return GEMINI_SETTINGS.parent.exists() or shutil.which("gemini") is not None


def wire_gemini(undo: bool) -> bool:
    if not gemini_installed():
        return False
    cfg = _load(GEMINI_SETTINGS)
    tel = cfg.get("telemetry") if isinstance(cfg.get("telemetry"), dict) else {}
    if undo:
        # Only unwire if it still points at us; leave a user's own setup alone.
        if tel.get("otlpEndpoint") == SERVER:
            _backup(GEMINI_SETTINGS)
            for k in ("enabled", "traces", "otlpEndpoint", "otlpProtocol"):
                tel.pop(k, None)
            cfg["telemetry"] = tel
            _write(GEMINI_SETTINGS, cfg)
            print(f"[agentglass] unwired Gemini CLI ({GEMINI_SETTINGS})")
        return True
    if tel.get("otlpEndpoint") == SERVER and tel.get("traces") and tel.get("enabled"):
        print("[agentglass] Gemini CLI already connected — nothing to do.")
        return True
    _backup(GEMINI_SETTINGS)
    tel.update({"enabled": True, "traces": True, "otlpEndpoint": SERVER, "otlpProtocol": "http"})
    cfg["telemetry"] = tel
    _write(GEMINI_SETTINGS, cfg)
    print(f"[agentglass] connected Gemini CLI → {SERVER}/v1/traces ({GEMINI_SETTINGS})")
    print("[agentglass]   start a new `gemini` session for it to take effect.")
    return True


# --- OpenAI Codex CLI (OTLP logs) ------------------------------------------
CODEX_CONFIG = Path.home() / ".codex" / "config.toml"
CODEX_MARK = "# agentglass — OTLP logs → agentglass"
CODEX_BLOCK = (
    f"\n{CODEX_MARK}\n"
    f"[otel]\n"
    f'exporter = {{ otlp-http = {{ endpoint = "{SERVER}/v1/logs", protocol = "binary" }} }}\n'
)


def codex_installed() -> bool:
    return CODEX_CONFIG.parent.exists() or shutil.which("codex") is not None


def wire_codex(undo: bool) -> bool:
    if not codex_installed():
        return False
    text = CODEX_CONFIG.read_text() if CODEX_CONFIG.exists() else ""
    if undo:
        if CODEX_BLOCK in text:
            _backup(CODEX_CONFIG)
            CODEX_CONFIG.write_text(text.replace(CODEX_BLOCK, ""))
            print(f"[agentglass] unwired Codex CLI ({CODEX_CONFIG})")
        return True
    if f"{SERVER}/v1/logs" in text:
        print("[agentglass] Codex CLI already connected — nothing to do.")
        return True
    if "[otel]" in text:
        # Respect a config the user already wrote; just tell them where to point.
        print(f"[agentglass] Codex CLI has its own [otel] config — leaving it. Point its "
              f"otlp-http endpoint at {SERVER}/v1/logs to stream here.")
        return True
    _backup(CODEX_CONFIG)
    CODEX_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CODEX_CONFIG.write_text(text + CODEX_BLOCK)
    print(f"[agentglass] connected Codex CLI → {SERVER}/v1/logs ({CODEX_CONFIG})")
    print("[agentglass]   start a new `codex` session for it to take effect.")
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description="Connect agent CLIs to agentglass via OpenTelemetry.")
    ap.add_argument("--undo", action="store_true", help="remove the agentglass telemetry wiring")
    ap.add_argument("--postinstall", action="store_true", help="lifecycle mode: honor AGENTGLASS_NO_OTEL, never fail")
    args = ap.parse_args()
    _agentglass_local_only(SERVER)

    if args.postinstall and os.environ.get("AGENTGLASS_NO_OTEL"):
        print("[agentglass] AGENTGLASS_NO_OTEL set — skipping OTel auto-connect.")
        return

    any_tool = False
    try:
        any_tool = wire_gemini(args.undo) or any_tool
        any_tool = wire_codex(args.undo) or any_tool
    except Exception as e:  # never break `bun install`
        print(f"[agentglass] OTel auto-connect skipped ({e}).")
        return

    if not any_tool and not args.postinstall:
        print("[agentglass] no supported agent CLIs detected (looked for Gemini CLI, Codex CLI).")


if __name__ == "__main__":
    main()
