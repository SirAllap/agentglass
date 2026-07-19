# 🛰 agentglass

**A loupe for your agents — real-time mission-control for AI coding agents.**

This npm package is the **quickstart launcher** for agentglass. The app itself
is local-first (Bun + SQLite) and runs from a clone — this package points you
there:

```bash
npx agentglass          # prints the quickstart
```

## The 10-second version

```bash
git clone https://github.com/SirAllap/agentglass.git && cd agentglass
bun install             # wires Claude Code hooks globally (opt-out available)
bun run dev             # server :4000 + cockpit → http://localhost:6180
```

Watch every agent, tool call, token and dollar in real time — across Claude
Code, and any CLI that speaks OpenTelemetry GenAI (Codex, Gemini, …). Plus a
syntax-highlighted diff viewer, a lazygit-style source-control panel, a
lazydocker-style Docker panel, a **real terminal**, and a Claude chat — all one
keystroke away in the same browser tab.

- **Live demo (fake data, zero install):** <https://sirallap.github.io/agentglass/>
- **Source, docs & issues:** <https://github.com/SirAllap/agentglass>

MIT © David Pallares
