/*
 * The user's half of the "Review with Claude" menu.
 *
 * `reviewRecipes.ts` holds the catalogue — the prompts we ship. This holds what
 * somebody did to it: a built-in whose wording they rewrote, a built-in they
 * deleted, and the ones they wrote themselves. Two files rather than one
 * because they age differently: the catalogue improves with the app, and an
 * edit must survive that improvement without freezing a copy of everything else
 * beside it.
 *
 * Stored by id, next to commands.json and clickup-views.json, and for the same
 * reason: it is a handful of strings, it is not a secret, and being able to open
 * it in an editor beats any storage engine.
 *
 * Nothing here executes anything. A prompt is text that reaches an agent, which
 * is a real thing to be careful about — but the care belongs where the agent is
 * launched, not here, and pretending otherwise would only stop somebody writing
 * the word `rm` in a sentence about a diff.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ReviewRecipe, ReviewRecipeContext, ReviewRecipeGroup, ReviewRecipeWhen } from "../../shared/types.ts";
import { BUILT_IN_RECIPES, expandRecipe, suggestRecipeId, type ReviewSituation } from "./reviewRecipes.ts";

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "review-prompts.json",
);

/** Test seam, so a suite never reads or writes somebody's own prompts. */
let override: string | null = null;
export function __setReviewPromptsPath(p: string | null): void { override = p; cache = undefined; }
const path = (): string => override ?? FILE;

interface Store { prompts: ReviewRecipe[] }
let cache: Store | undefined;

const GROUPS: ReviewRecipeGroup[] = ["reviewing", "focused", "mine"];
const WHENS: ReviewRecipeWhen[] = ["any", "asked", "reviewed", "card", "mine", "mine-changes"];

function load(): Store {
  if (cache) return cache;
  try {
    const p = path();
    cache = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Store) : { prompts: [] };
  } catch {
    // A malformed file is not a reason to lose the menu — it is a reason to
    // show the catalogue, which is visible and recoverable. The file stays on
    // disk untouched for somebody to fix by hand.
    cache = { prompts: [] };
  }
  cache!.prompts = (Array.isArray(cache!.prompts) ? cache!.prompts : []).filter((p) => p && typeof p.id === "string");
  return cache!;
}

function write(s: Store): void {
  try {
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), JSON.stringify(s, null, 2) + "\n");
  } catch { /* the menu still works this session; it just will not survive */ }
  cache = s;
}

/**
 * The menu: the catalogue, with the user's edits laid over it.
 *
 * Three rules, and the order matters:
 *   - a stored entry whose id is a built-in REPLACES its title, body and skill,
 *     and keeps being a built-in (so "Reset" has something to go back to);
 *   - a stored entry marked hidden takes that built-in out;
 *   - everything else is the user's own, and sorts after the built-ins in its
 *     group.
 */
export function reviewRecipes(): ReviewRecipe[] {
  const stored = new Map(load().prompts.map((p) => [p.id, p]));
  const out: ReviewRecipe[] = [];

  BUILT_IN_RECIPES.forEach((b, i) => {
    const mine = stored.get(b.id);
    stored.delete(b.id);
    if (mine?.hidden) return;
    out.push({
      ...b,
      ...(mine ? { title: mine.title || b.title, body: mine.body ?? b.body, skill: mine.skill, group: mine.group || b.group, when: mine.when || b.when } : {}),
      builtIn: true,
      rank: mine?.rank ?? i,
    });
  });

  // Whatever is left is the user's own. Tombstones for built-ins that no longer
  // exist (a catalogue entry we dropped) are not resurrected as custom ones.
  for (const p of stored.values()) {
    if (p.hidden) continue;
    out.push({ ...p, builtIn: false, rank: p.rank ?? 1000 });
  }

  const g = (r: ReviewRecipe) => Math.max(0, GROUPS.indexOf(r.group));
  return out.sort((a, b) => g(a) - g(b) || (a.rank ?? 0) - (b.rank ?? 0) || a.title.localeCompare(b.title));
}

/** One by id, already merged. Null when it was deleted or never existed — the
 *  caller then falls back to the suggestion rather than sending nothing. */
export function reviewRecipe(id: string): ReviewRecipe | null {
  return reviewRecipes().find((r) => r.id === id) ?? null;
}

function invalid(r: ReviewRecipe): string | null {
  if (!r || typeof r !== "object") return "not a prompt";
  if (!String(r.title || "").trim()) return "A prompt needs a title — it is what the menu shows";
  if (!String(r.body || "").trim() && !String(r.skill || "").trim()) return "A prompt needs either a body or a skill to run";
  if (String(r.title).length > 80) return "That title is too long for a menu — keep it under 80 characters";
  // 20k is roughly ten times the longest built-in. It exists so a paste
  // accident cannot put a megabyte into a config file, not to police wording.
  if (String(r.body || "").length > 20_000) return "That prompt is enormous — keep it under 20,000 characters";
  if (r.skill && !/^\/[\w-]/.test(String(r.skill).trim())) return "A skill starts with a slash, the way you would type it: /pr-resolve-reviews {number}";
  return null;
}

let seq = 0;
export function saveReviewRecipe(r: ReviewRecipe): { ok: boolean; error?: string; recipe?: ReviewRecipe } {
  const why = invalid(r);
  if (why) return { ok: false, error: why };
  const s = load();
  const id = String(r.id || "").trim() || `p${Date.now().toString(36)}${(seq++).toString(36)}`;
  const next: ReviewRecipe = {
    id,
    title: String(r.title).trim(),
    body: String(r.body ?? ""),
    ...(String(r.skill || "").trim() ? { skill: String(r.skill).trim() } : {}),
    group: GROUPS.includes(r.group) ? r.group : "reviewing",
    when: WHENS.includes(r.when) ? r.when : "any",
    ...(typeof r.rank === "number" ? { rank: r.rank } : {}),
  };
  write({ prompts: [...s.prompts.filter((x) => x.id !== id), next] });
  return { ok: true, recipe: reviewRecipe(id) ?? next };
}

/**
 * Delete — which for a built-in means "hide", because the catalogue would hand
 * it straight back on the next start otherwise. The tombstone carries the id
 * and nothing else worth keeping.
 */
export function removeReviewRecipe(id: string): { ok: boolean } {
  const s = load();
  const isBuiltIn = BUILT_IN_RECIPES.some((b) => b.id === id);
  const rest = s.prompts.filter((p) => p.id !== id);
  write({ prompts: isBuiltIn ? [...rest, { id, title: "", body: "", group: "reviewing", when: "any", hidden: true }] : rest });
  return { ok: true };
}

/** Put a built-in back the way it shipped — and un-hide it if it was deleted. */
export function resetReviewRecipe(id: string): { ok: boolean; recipe?: ReviewRecipe } {
  const s = load();
  write({ prompts: s.prompts.filter((p) => p.id !== id) });
  return { ok: true, recipe: reviewRecipe(id) ?? undefined };
}

/**
 * The text that actually reaches the agent.
 *
 * An id when the menu asked for one, the situation's suggestion otherwise — and
 * the fall back to "what is this pull request" is not defensive: a prompt can
 * be deleted from Settings between the menu being drawn and the button being
 * pressed, and the honest answer to that is the read-only opener, not an error
 * where a chat should be.
 *
 * A skill goes FIRST and on its own line, because that is where Claude's own
 * parser looks for it, and the body follows as the sentence of context the
 * skill's arguments cannot carry.
 */
export function recipePromptText(input: {
  id: string;
  pr: ReviewRecipeContext;
  situation: ReviewSituation;
}): string {
  const list = reviewRecipes();
  const pick =
    (input.id ? list.find((r) => r.id === input.id) : null) ??
    list.find((r) => r.id === suggestRecipeId(input.situation)) ??
    list.find((r) => r.id === "understand") ??
    list[0];
  if (!pick) return "";

  const skill = pick.skill ? expandRecipe(pick.skill, input.pr).trim() : "";
  const body = expandRecipe(pick.body ?? "", input.pr).trim();
  return [skill, body].filter(Boolean).join("\n\n");
}

/** Which recipe the menu should put first for this pull request — the rule
 *  above, but never naming one the user has deleted. */
export function suggestedRecipeId(situation: ReviewSituation): string {
  const list = reviewRecipes();
  const want = suggestRecipeId(situation);
  return (list.find((r) => r.id === want) ?? list.find((r) => r.id === "understand") ?? list[0])?.id ?? "";
}

/** For a test's own teardown. */
export function __clearReviewPrompts(): void { cache = { prompts: [] }; }
