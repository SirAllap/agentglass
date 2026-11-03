import type { AgentModel } from "../../shared/types.ts";
import { runCommand } from "./agentprobe.ts";

/**
 * The models an engine offers a worker role, for the picker's list. Typing a
 * name the list does not know stays allowed, so every failure here is an empty
 * list and never an error.
 */

/** Claude Code has no list command; these three follow the newest model by themselves. */
const ALIASES: AgentModel[] = [
  { id: "haiku", label: "haiku" },
  { id: "sonnet", label: "sonnet" },
  { id: "opus", label: "opus" },
];

/** `opencode models` prints one `provider/model` per line; anything else is noise. */
export function parseOpencodeModels(text: string): AgentModel[] {
  const seen = new Set<string>();
  const out: AgentModel[] = [];
  for (const line of text.split("\n")) {
    const id = line.trim();
    if (!/^[\w.-]+\/[\w.:/@-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}

const TTL_MS = 5 * 60_000;
let opencodeCache: { at: number; models: AgentModel[] } | null = null;

/** A process spawn: read when the picker opens, cached, never per keystroke. */
async function opencodeModels(now: number): Promise<AgentModel[]> {
  if (opencodeCache && now - opencodeCache.at < TTL_MS) return opencodeCache.models;
  let models: AgentModel[] = [];
  try {
    const bin = Bun.which("opencode");
    if (bin) {
      const r = await runCommand([bin, "models"], 5000);
      if (!r.timedOut && r.code === 0) models = parseOpencodeModels(r.out);
    }
  } catch { /* no CLI: an empty list */ }
  opencodeCache = { at: now, models };
  return models;
}

export function __resetEngineModels(): void { opencodeCache = null; }

export async function engineModels(engine: string, now = Date.now()): Promise<AgentModel[]> {
  if (engine === "claude") return ALIASES;
  if (engine === "opencode") return opencodeModels(now);
  return [];
}
