// OpenAI Codex — the CLI's argv for a worker run, its home and its model list.
//
// `codex exec --json` is Codex's equivalent of `claude -p --output-format
// stream-json`; the first turn mints a thread and follow-ups go through
// `codex exec resume <thread_id>`. Gated by AGENTGLASS_CODEX_DISABLED.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { MODEL_RE } from "./agentids.ts";
import type { CodexModel } from "../../shared/types.ts";

const codexBin = () => Bun.which("codex");
/*
 * Resolved per call, not once at import.
 *
 * It used to be a constant computed when this module first loaded, so a
 * `codex` installed while the server was running stayed invisible until a
 * restart — with nothing on screen to suggest why. remote.ts documents the
 * same trap with a measurement against a stub that was silently bypassed;
 * the lesson was learnt there and not here.
 */
export const CODEX_ENABLED = (): boolean => !!codexBin() && process.env.AGENTGLASS_CODEX_DISABLED !== "1";

export const DEFAULT_SANDBOX = "read-only";

// --- the model list ---------------------------------------------------------
// Read from Codex's own cache rather than hardcoded here.
//
// A model table checked into this repo is wrong the day OpenAI ships anything,
// and the failure is silent: the dropdown keeps offering an id the CLI no
// longer serves. Codex already maintains the list on disk — it refreshes
// `models_cache.json` itself — so the honest answer to "what can I pick?" is
// whatever that file currently says.

/** Where Codex keeps its state. `CODEX_HOME` is Codex's own override and is
 *  honoured here so an operator who moved it does not silently get an empty
 *  list. */
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * A last resort, not the source of truth.
 *
 * Reached when the cache is missing (a fresh install that has not talked to the
 * API yet) or unreadable. Offering nothing at all would make the panel look
 * broken on a machine where Codex works fine, so this is deliberately a short
 * list of ids that have shipped rather than an attempt at completeness — the
 * cache takes over the moment it exists.
 */
const FALLBACK_MODELS: CodexModel[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

/**
 * The models the dropdown may offer.
 *
 * Exported for tests. Every entry is validated against MODEL_RE before it goes
 * out, because the same expression guards the spawn below — offering a choice
 * the send path would then refuse is the one outcome worth ruling out here.
 *
 * The cache is ~37KB, nearly all of it each model's `base_instructions`. Only
 * the id and the label cross the wire.
 */
export function parseModels(raw: string): CodexModel[] {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return []; }
  const models = (doc as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const out: Array<CodexModel & { priority: number }> = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const { slug, display_name, visibility, priority } = m as Record<string, unknown>;
    // `visibility` is Codex's own answer to "should a human be offered this?" —
    // the cache also carries internal entries (a review model, service tiers)
    // that are not conversation models at all.
    if (visibility !== "list") continue;
    if (typeof slug !== "string" || !MODEL_RE.test(slug)) continue;
    out.push({
      id: slug,
      label: typeof display_name === "string" && display_name ? display_name : slug,
      priority: typeof priority === "number" ? priority : Number.MAX_SAFE_INTEGER,
    });
  }
  out.sort((a, b) => a.priority - b.priority);
  return out.map(({ id, label }) => ({ id, label }));
}

export function codexModels(): CodexModel[] {
  try {
    const found = parseModels(readFileSync(join(codexHome(), "models_cache.json"), "utf8"));
    if (found.length) return found;
  } catch { /* no cache yet, or unreadable */ }
  return FALLBACK_MODELS;
}

// --- replaying a thread -----------------------------------------------------
// What a Codex session actually said, for a chat that adopted it from the fleet.
//
// The fleet knows Codex sessions through OpenTelemetry, and those log records
// carry the *shape* of a turn but not its words — `logRecordToEvent` in otlp.ts
// can build a tool call out of them and has nothing to build a prompt or a reply
// from. So a resumed Codex chat opened as a blank panel while `codex` held the
// whole conversation, which reads as the resume having silently failed. It is
// the same problem `hydrate` already solves for Claude by replaying the stored
// transcript; Codex's equivalent is its own rollout on disk.

// --- driving a turn ---------------------------------------------------------

/**
 * The argv for one turn.
 *
 * Exported and pure so the flag mapping can be pinned in tests without
 * spawning a real `codex`.
 *
 * Two things about this are worth writing down, because both were found the
 * hard way rather than read off the help output:
 *
 *  - The prompt goes in on stdin, via the trailing `-`. Passing it as an argv
 *    element would work until someone pastes something long enough to hit
 *    ARG_MAX, and it puts what the user typed into the process table.
 *  - The sandbox is set with `-c sandbox_mode=...` rather than `-s`, because
 *    `codex exec resume` does not accept `-s` at all ("unexpected argument
 *    '-s' found") while it does accept `-c`. Using the config override on both
 *    paths keeps one code path instead of a flag that changes shape depending
 *    on whether this is the first turn.
 *
 * The working directory is set on the spawn, not with `-C`:
 * `codex exec resume` has no `-C` either.
 */
export function codexArgs(bin: string, model: string, sandbox: string, resumeId: string): string[] {
  const args = [bin, "exec"];
  if (resumeId) args.push("resume", resumeId);
  args.push("--json", "-m", model);
  if (sandbox === "full-access") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-c", `sandbox_mode=${sandbox}`);
    // `codex exec` has no channel to ask down, so an approval policy that would
    // prompt can only stall or deny. Saying "never" up front makes the sandbox
    // the only thing deciding, which is what the mode label already claims.
    args.push("-c", "approval_policy=never");
  }
  args.push("-"); // read the prompt from stdin
  return args;
}
