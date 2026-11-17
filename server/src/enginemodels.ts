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

/**
 * OpenCode wants `provider/model`; a flow's chain may hold the bare name
 * (`big-pickle`). The canonical form is the engine's own: a bare name takes the
 * provider from the installed engine's list, only when exactly one provider
 * has it. Anything else (already qualified, unknown, ambiguous) is returned as is.
 */
export function qualifyModel(model: string, models: readonly AgentModel[]): string {
  if (!model || model.includes("/")) return model;
  const hits = models.filter((m) => m.id.slice(m.id.indexOf("/") + 1) === model);
  return hits.length === 1 ? hits[0]!.id : model;
}

const TTL_MS = 5 * 60_000;
/**
 * A worker start waits on the engine's list at most this long. The seat measured
 * the real `opencode models` hanging for minutes (a full server tranche sat 14 min),
 * so the spawn is killed at the bound (runCommand kills the process group) and the
 * start never waits past it: a timed-out or failed list is an empty one and names
 * stay as stored. A failed read is cached too, so a stuck CLI costs one bound per TTL.
 */
export const OPENCODE_LIST_BOUND_MS = 3000;
let opencodeCache: { at: number; models: AgentModel[] } | null = null;

/** A process spawn: read when the picker opens, cached, never per keystroke. */
async function opencodeModels(now: number): Promise<AgentModel[]> {
  if (opencodeCache && now - opencodeCache.at < TTL_MS) return opencodeCache.models;
  let models: AgentModel[] = [];
  try {
    const bin = Bun.which("opencode");
    if (bin) {
      const r = await runCommand([bin, "models"], OPENCODE_LIST_BOUND_MS);
      if (!r.timedOut && r.code === 0) models = parseOpencodeModels(r.out);
    }
  } catch { /* no CLI: an empty list */ }
  opencodeCache = { at: now, models };
  return models;
}

export function __resetEngineModels(): void { opencodeCache = null; }
/** A suite answers the installed engine's list instead of spawning the CLI. */
export function __seedOpencodeModels(models: AgentModel[]): void { opencodeCache = { at: Date.now(), models }; }

/** Ask the installed engine once, so the sync readers below have its list. Never throws. */
export async function primeOpencodeModels(bound = OPENCODE_LIST_BOUND_MS + 500, list: () => Promise<unknown> = () => opencodeModels(Date.now())): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([list(), new Promise<void>((res) => { timer = setTimeout(res, bound); })]);
  } catch { /* an empty list: names stay as stored */ } finally { clearTimeout(timer); }
}

/**
 * The one place a chain is read for OpenCode: every bare model in it takes the
 * provider from the list `primeOpencodeModels` last read (stale is fine; the
 * list only grows). Sync, so the sync planners can call it.
 */
export function qualifyChain<T extends { engine: string; model: string }>(chain: readonly T[]): T[] {
  const models = opencodeCache?.models ?? [];
  return chain.map((c) => (c.engine === "opencode" ? { ...c, model: qualifyModel(c.model, models) } : c));
}
export function qualifyOpencode(model: string): string { return qualifyModel(model, opencodeCache?.models ?? []); }

/**
 * Whether the installed OpenCode offers a chain entry's model. A chain is an
 * ordered fallback, so an entry whose model the engine lacks is skipped like an
 * engine that is not ready. Only a list the engine really gave can say no: an
 * empty or failed list (no CLI, timeout) says yes to everything, and so does
 * an entry with no model named (the engine's own default).
 */
export function opencodeOffers(model: string): boolean {
  const models = opencodeCache?.models ?? [];
  if (!models.length || !model) return true;
  const q = qualifyModel(model, models);
  return models.some((m) => m.id === q);
}
/** The installed engine's model ids, for a sentence that says what it does have. */
export function opencodeModelIds(): string[] { return (opencodeCache?.models ?? []).map((m) => m.id); }

export async function engineModels(engine: string, now = Date.now()): Promise<AgentModel[]> {
  if (engine === "claude") return ALIASES;
  if (engine === "opencode") return opencodeModels(now);
  return [];
}
