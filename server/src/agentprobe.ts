import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProbe, KnownAgent } from "../../shared/types.ts";
import { db } from "./db.ts";
import { hookStatus } from "./hooksetup.ts";

/**
 * The agents this machine already has, and whether any of them is talking.
 *
 * Connecting a second agent is the step where people stop. The hooks ship in
 * the app, but somebody still has to know which harness they have, which config
 * file it reads, and what to put in it — three questions the cockpit can just
 * answer by looking.
 *
 * Everything not found is listed too, rather than hidden. A list of what is
 * installed tells you nothing about what is *supported*, and "supported" is the
 * question somebody has when they are deciding whether to try a second agent at
 * all.
 *
 * The half that matters is the last one. **"Connected" has to mean an event
 * landed**, not that a file was written — every failure in this area looks like
 * a successful write: a config in the right shape that the CLI does not read, a
 * session started before the change, a typo in an endpoint. A green tick over a
 * file that changed nothing is worse than no tick, because it stops the search.
 */

/**
 * The roster, with its paths resolved when they are asked for.
 *
 * Not at import: `homedir()` would be captured once, and both the hook
 * installer's own `CLAUDE_CONFIG_DIR` and a suite pointing `HOME` at a scratch
 * directory move afterwards. A frozen path here reads a developer's real
 * config in tests and the wrong one in an app that re-homes itself.
 */
type Roster = Omit<KnownAgent, "configPath"> & { configPath: () => string };

/**
 * The home the *agent CLIs* use, which is not always the one Bun reports.
 *
 * `os.homedir()` in Bun resolves from the passwd entry and ignores `$HOME`;
 * Node prefers `$HOME` on POSIX, and so does Python's `Path.home()` — which is
 * what `hooks/connect_otel.py` writes through. So on any machine where the two
 * differ (a container, `sudo -E`, CI) this module would have read a config the
 * installer never wrote, and reported a correctly connected agent as
 * unconnected. `$HOME` is also what the CLIs themselves read, which makes it
 * the right answer rather than merely the consistent one.
 */
const agentHome = (): string => process.env.HOME || homedir();

export const ROSTER: Roster[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    via: "hooks",
    // The hook installer decides this one — it honours CLAUDE_CONFIG_DIR.
    configPath: () => hookStatus().settingsPath,
    /** Every event this agent produces arrives under this name. */
    match: "claude",
    install: "npm i -g @anthropic-ai/claude-code",
    connects: "hooks that post each event to this server",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    via: "otel",
    configPath: () => join(agentHome(), ".gemini", "settings.json"),
    match: "gemini",
    install: "npm i -g @google/gemini-cli",
    connects: "OpenTelemetry traces → /v1/traces",
  },
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    bin: "codex",
    via: "otel",
    configPath: () => join(agentHome(), ".codex", "config.toml"),
    match: "codex",
    install: "npm i -g @openai/codex",
    connects: "OpenTelemetry logs → /v1/logs",
  },
  {
    // Google's agentic CLI, and a separate product from the Gemini CLI above —
    // separate binary, separate state, and a model list that spans Anthropic
    // and open-weight models as well as Google's. Wiring one does nothing for
    // the other.
    id: "antigravity",
    label: "Google Antigravity",
    bin: "agy",
    via: "chat",
    // It keeps state under ~/.gemini/antigravity-cli, but nothing there is a
    // connection this app writes or reads, so there is no path worth showing.
    configPath: () => "",
    match: "antigravity",
    install: "https://antigravity.google/docs/cli",
    connects: "the chat panel, which turns its own turns into events",
  },
];

/**
 * Whether this agent's config currently points at us.
 *
 * Read rather than remembered: the file is the truth, and somebody who edited
 * it by hand — or ran the CLI's own reset — should see that reflected instead
 * of a state this app wrote down once.
 */
function wired(a: Roster, path: string, found: boolean): boolean {
  if (a.via === "hooks") return hookStatus().installed;
  // Nothing to wire and nothing that could be unwired: a `chat` agent reports
  // because this server is the thing running it, so being installed is the
  // whole of being connected. It has to be said that way round — answering a
  // flat `true` here would report a CLI nobody has installed as connected and
  // waiting for its first event, which is the one state it can never reach.
  if (a.via === "chat") return found;
  if (!existsSync(path)) return false;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  // Deliberately loose: what is being asked is "does this point at an
  // agentglass receiver", and the port can be anything. A stricter match would
  // report a server on 4001 as unconnected while its events arrived.
  if (a.id === "gemini") {
    try {
      const cfg = JSON.parse(text) as { telemetry?: { otlpEndpoint?: unknown; enabled?: unknown } };
      const ep = String(cfg.telemetry?.otlpEndpoint ?? "");
      return !!cfg.telemetry?.enabled && /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/.test(ep);
    } catch {
      return false;
    }
  }
  return /otlp-http\s*=\s*\{[^}]*(localhost|127\.0\.0\.1)/.test(text);
}

/**
 * When this agent last actually said something.
 *
 * Matched on a name fragment rather than an exact `source_app`, because for the
 * OTLP agents that field is whatever the CLI puts in its own `service.name` —
 * this app does not choose it and cannot pin it. The fragment is the part that
 * does not change.
 */
function lastSeen(match: string, q: typeof db = db): number | null {
  const r = q
    .query<{ t: number | null }, [string]>(
      "SELECT MAX(timestamp) AS t FROM events WHERE source_app LIKE '%' || ? || '%'"
    )
    .get(match);
  return r?.t ?? null;
}

/** Every agent this app knows how to connect, with what is true of it here. */
export function probeAgents(
  which: (cmd: string) => string | null = (c) => Bun.which(c),
  seen: (match: string) => number | null = lastSeen,
): AgentProbe[] {
  return ROSTER.map((a) => {
    const path = a.configPath();
    const found = which(a.bin);
    return {
      ...a,
      configPath: path,
      found: !!found,
      path: found,
      connected: wired(a, path, !!found),
      // Independent of `connected` on purpose. A config that was written and an
      // event that arrived are different facts, and the gap between them is
      // exactly where this feature earns its place: it is the state somebody
      // sits in for ten minutes wondering what they did wrong.
      seenAt: seen(a.match),
    };
  });
}

/** The one word for where an agent stands, so a panel is not re-deriving it. */
export function agentState(p: AgentProbe): "live" | "waiting" | "ready" | "missing" {
  if (p.seenAt) return "live";
  if (p.connected) return "waiting";
  return p.found ? "ready" : "missing";
}
