/*
 * Which CLI reads a Flight plan, and which model it hands it.
 *
 * The Reviewer's engine decides: Claude as it always was, OpenCode on the same
 * plan with the same prompt, and any other engine leaves Claude Sonnet to read
 * it — said in the card, never a silent swap. One function, because the server
 * runs it and the card names it, and two would drift.
 */
import type { EngineChoice } from "./orchestration.ts";
import type { RoleChoice } from "./workerRoles.ts";

export type PreflightEngine = "claude" | "opencode";

/** Where a Preflight goes when the Reviewer's own engine cannot run one. */
export const PREFLIGHT_FALLBACK_MODEL = "sonnet";

export interface PreflightTarget {
  /** The CLI a run really uses. */
  engine: PreflightEngine;
  /** What that CLI's model flag gets; `""` is the CLI's own default. */
  model: string;
  /** The Reviewer is on an engine a Preflight does not run on, so Claude reads instead. */
  fellBack: boolean;
  /** The Reviewer's engine, for the sentence that says so. */
  reviewer: string;
}

export function preflightTarget(role: RoleChoice): PreflightTarget {
  const reviewer = role.provider || "claude";
  if (reviewer === "claude") return { engine: "claude", model: role.model || PREFLIGHT_FALLBACK_MODEL, fellBack: false, reviewer };
  if (reviewer === "opencode") return { engine: "opencode", model: role.model || "", fellBack: false, reviewer };
  return { engine: "claude", model: PREFLIGHT_FALLBACK_MODEL, fellBack: true, reviewer };
}

/**
 * The target for a project: the first engine of the Reviewer chain its policy
 * resolves to, so a project rule that moves the Reviewer moves the Preflight.
 * An empty chain is the role it falls back to.
 */
export function preflightTargetFromChain(chain: readonly EngineChoice[], role: RoleChoice): PreflightTarget {
  const first = chain[0];
  return first ? preflightTarget({ provider: first.engine, model: first.model }) : preflightTarget(role);
}

/** What the card calls each engine: the person's word, not the CLI's package name (Claude Code). */
const ENGINE_TITLE: Record<PreflightEngine, string> = { claude: "Claude", opencode: "OpenCode" };

/** "OpenCode · deepseek-v4.1-flash": an engine and the model it ran, as one line. */
export function engineModelLabel(engine: PreflightEngine, model: string): string {
  // OpenCode takes its model as provider/model, and the provider is already in the engine's name.
  return `${ENGINE_TITLE[engine] ?? engine} · ${model.split("/").pop() || "its default"}`;
}

/** The line the card shows for the target a Preflight will use. */
export function preflightLabel(t: PreflightTarget): string {
  return engineModelLabel(t.engine, t.model);
}

/** What the card says instead of offering a change in Orchestration that a Preflight would not follow. */
export function preflightFallbackNote(t: PreflightTarget): string | null {
  return t.fellBack ? `Preflight runs on Claude ${t.model}: ${t.reviewer} is not supported here yet` : null;
}
