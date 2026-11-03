/*
 * The words and small lookups the Flow screens share: how an engine and model
 * read on a block, the tool names a person sees, and the sentences for an exit.
 * Plain functions, so the canvas, the side panel, the role editor and the page
 * preview say the same thing about the same role.
 */
import { agentProvider } from "../../../../../shared/agentKinds.ts";
import { chainOf, roleById, type Flow, type FlowRole } from "../../../../../shared/flow.ts";
import { chainFor, planWord, type Chain, type Policy } from "../../../../../shared/orchestration.ts";

export const TOOL_WORD: Record<string, string> = {
  read: "Read files", run: "Run commands", write: "Write in its own copy", commit: "Commit locally", notes: "Write notes",
};
export const TOOL_IDS = ["read", "run", "write", "commit", "notes"] as const;

/** The engines a person may pick for a role of their own, with the models each one is offered. */
export const ENGINE_CHOICES: { id: string; models: string[] }[] = [
  { id: "claude", models: ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-5-5"] },
  { id: "codex", models: ["gpt-5.6-codex"] },
  { id: "opencode", models: ["opencode-go/deepseek-v4.1-flash", "opencode-go/deepseek-v4-pro", "opencode-go/glm-5.3-flash", "opencode/big-pickle"] },
];

export const engineName = (id: string): string => agentProvider(id)?.title ?? id;

/** What each engine's plan is, in the mockup's one line under the engine's name. */
export const ENGINE_PLAN: Record<string, string> = {
  claude: `your ${planWord("anthropic")} plan`,
  opencode: `${planWord("opencode")} plan`,
  codex: `your ${planWord("codex")} plan`,
};

/** The id without its provider: `opencode-go/deepseek-v4.1-flash` reads as `deepseek-v4.1-flash`. */
export const modelId = (full: string): string => full.slice(full.lastIndexOf("/") + 1);

/** `claude-sonnet-5-5` reads as `sonnet` in the rail, as the mockup's role rows write it; the full id is one hover away. */
export function railModel(full: string): string {
  const m = modelId(full);
  if (m.startsWith("claude-")) return m.replace("claude-", "").replace(/(-\d+(\.\d+)?)+$/, "");
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("gpt-")) return "codex";
  if (m.startsWith("glm")) return "glm";
  return m;
}

export const shortChain = (c: Chain): string => (c.length ? c.map((x) => modelId(x.model)).join(" → ") : "none");
export const fullChain = (c: Chain): string => (c.length ? c.map((x) => `${x.model} (${engineName(x.engine)})`).join(" → ") : "none");

export const stageLabel = (flow: Flow, id: string): string => flow.stages.find((s) => s.id === id)?.label ?? id;

/** What a role's passing arrow says: the next step on the path, or the end. */
export function passWord(flow: Flow, id: string): string {
  const role = roleById(flow, id);
  if (role?.actor === "person") return "waits for you";
  const next = flow.path[flow.path.indexOf(id) + 1];
  return next ? roleById(flow, next)?.name ?? "the end" : "the end";
}

/** Where a failing role goes: back to a step and how many rounds, or the person. */
export function failWord(flow: Flow, id: string): { text: string; rounds: number | null; to: FlowRole | null } {
  const e = flow.edges.find((x) => x.on === "fail" && x.from === id);
  const to = e ? roleById(flow, e.to) ?? null : null;
  return e && to ? { text: `back to ${stageLabel(flow, to.stage)}`, rounds: e.maxRounds ?? null, to } : { text: "asks you", rounds: null, to: null };
}

/**
 * The flow as the screens draw it: every built-in role's chain as the policy says
 * now. A save returns `validateFlow`'s flow, which drops `resolvedChain`, so the
 * canvas, the rail, the panel and the editor all read this, not the stored flow.
 */
export function flowOnScreen(flow: Flow, policy: Policy, holds: (id: string) => boolean): Flow {
  return {
    ...flow,
    roster: flow.roster.map((r) => {
      if (!r.policyRole) return r;
      const chain = chainFor(policy, { on: holds }, r.policyRole);
      return chain.length ? { ...r, resolvedChain: chain } : r;
    }),
  };
}

/** The headline engine of a role: engine name and first model, or null where a person answers. */
export function runsOn(role: FlowRole): { engine: string; model: string } | null {
  const c = chainOf(role);
  return c.length ? { engine: engineName(c[0]!.engine), model: c[0]!.model } : null;
}


/** The folder name of a project root, the way the project filter spells it. */
export const projectName = (root: string): string => root.replace(/\/+$/, "").split("/").pop() || root;
