#!/usr/bin/env node
// agentglass quickstart launcher — the app itself is local-first (Bun + SQLite)
// and runs from a clone, so this CLI gets you from `npx agentglass` to a
// running cockpit with copy-pasteable steps.
const b = "\x1b[1m", d = "\x1b[2m", c = "\x1b[36m", m = "\x1b[35m", g = "\x1b[32m", r = "\x1b[0m";

console.log(`
${m}${b}  🛰  agentglass${r} ${d}— a loupe for your agents${r}

  Real-time mission-control for AI coding agents: every tool call, token
  and dollar, live — plus a diff viewer, lazygit, lazydocker, a real
  terminal and a Claude chat, all in one browser tab.

  ${b}Try the live demo${r} ${d}(no install)${r}
    ${c}https://sirallap.github.io/agentglass/${r}

  ${b}Run it for real${r} ${d}(requires Bun ≥ 1.1 and Python 3)${r}
    ${g}git clone https://github.com/SirAllap/agentglass.git && cd agentglass${r}
    ${g}bun install${r}   ${d}# wires Claude Code hooks globally (opt-out: AGENTGLASS_NO_HOOKS=1)${r}
    ${g}bun run dev${r}   ${d}# server :4000 + cockpit → http://localhost:6180${r}

  ${b}Docs & source${r}
    ${c}https://github.com/SirAllap/agentglass${r}
`);
