/*
 * What the Containers view decides on top of the state, triage and stack
 * modules: which situation it is in, what the freshness label says, the
 * sub-line under a name, the port cell, and how the list is grouped, folded and
 * stepped through. Out of the components so each of these is a function a test
 * can break, because the screen has no renderer to do it with.
 */
import type {
  DockerCapability, DockerContainer, DockerOverview, DockerPort, DockerScope, DockerStat,
} from "../../../shared/types.ts";
import { firstReachable, portLabel, portUrl } from "./dockerRow.ts";
import { exitCode, kindOf, needsYou } from "./dockerState.ts";
import { matchesQuery, NO_OWNER, toStacks, toWorktrees, type DockerStack } from "./dockerStacks.ts";
import { answerOf, foldedByDefault, needingFirst, stackSummary, type Answer } from "./dockerTriage.ts";

/* ---------------------------------------------------------------- situation */

export type Situation = "notinstalled" | "loading" | "down" | "empty" | "normal";

/**
 * Which of the five pictures the view draws.
 *
 * `good` is the last overview that said the daemon was up: a daemon that goes
 * away leaves that on screen, dimmed, under a banner, rather than a blank pane.
 * `failed` is a first fetch that threw, which is down too, with nothing to dim.
 */
export function situation(i: {
  cap: DockerCapability | null; ov: DockerOverview | null; good: DockerOverview | null; liveDown: boolean; failed: boolean;
}): Situation {
  if (i.cap && !i.cap.available) return "notinstalled";
  if (!i.ov && !i.good) return i.failed ? "down" : "loading";
  if (i.liveDown || (i.ov && !i.ov.available) || !i.good) return "down";
  return i.good.containers.length ? "normal" : "empty";
}

/** "40s", "4 min", "3 h": how old a state is once it is past "just now". */
export function ageWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/**
 * The header's freshness label. There is no timer behind it: the age is read
 * when the view renders, and it renders when the feed says something or the
 * window comes back, so "Live · 5s ago" is as old as the last thing heard.
 */
export function freshness(i: { situation: Situation; at?: number; lastGoodAt?: number; now: number }): { text: string; warn: boolean } {
  if (i.situation === "loading") return { text: "connecting…", warn: false };
  if (i.situation === "down") {
    return { text: i.lastGoodAt ? `retrying · last state ${ageWords(i.now - i.lastGoodAt)} old` : "retrying · no state yet", warn: true };
  }
  const s = i.at ? Math.max(0, Math.round((i.now - i.at) / 1000)) : 0;
  return { text: `Live · ${s < 2 ? "just now" : `${ageWords(i.now - i.at!)} ago`}`, warn: false };
}

export interface ScopeLine { all: boolean; project: string; before: string; after: string; title: string }

export function scopeLine(scope: DockerScope | undefined, shown: number): ScopeLine | null {
  if (!scope) return null;
  return scope.showingAll
    ? {
      all: true, project: scope.project, before: "No ", after: " containers · showing all",
      title: `No container is labelled for ${scope.project} (${scope.workspace}), so every container on this host is listed`,
    }
    : {
      all: false, project: scope.project, before: "Project ", after: ` · ${shown} container${shown === 1 ? "" : "s"}`,
      title: `Containers of the project open in agentglass (${scope.workspace})`,
    };
}

export interface NavCounts { need: number; containers: number; images: number; volumes: number; networks: number }

export function navCounts(ov: DockerOverview | null): NavCounts | null {
  if (!ov) return null;
  return {
    need: ov.containers.filter(needsYou).length, containers: ov.containers.length,
    images: ov.images.length, volumes: ov.volumes.length, networks: ov.networks.length,
  };
}

/* --------------------------------------------------------------------- rows */

export interface Why { text: string; tone: "" | "warn" | "amb" }

const firstLine = (s: string, max = 60): string => {
  const l = s.split("\n")[0]!.trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
};

/** The one line under a name: why it is sick, or what it is. */
export function whyOf(c: DockerContainer): Why {
  const k = kindOf(c);
  switch (k) {
    case "unhealthy": {
      const n = c.healthFailures && c.healthFailures > 1 ? ` ×${c.healthFailures}` : "";
      return { text: `${c.healthError ? `health check: ${firstLine(c.healthError)}` : "health check failing"}${n}`, tone: "warn" };
    }
    case "restarting": {
      const last = /^Restarting \((-?\d+)\)/.exec(c.status || "")?.[1];
      return { text: c.restarts ? `${c.restarts} restarts${last ? ` · last exit ${last}` : ""}` : "restarting", tone: "amb" };
    }
    case "crash": return { text: `exited with code ${exitCode(c)} · ${(c.status || "").replace(/^Exited \(-?\d+\) /, "")}`, tone: "warn" };
    case "dead": return { text: "dead · cannot start, remove it", tone: "warn" };
    case "stop": return { text: (c.status || "").replace(/^Exited \(-?\d+\) /, "stopped "), tone: "" };
    case "made": return { text: "created, never started", tone: "" };
    case "paused": return { text: `paused · ${c.image}`, tone: "amb" };
    default: return { text: c.image, tone: "" };
  }
}

/** Where the meters turn amber. */
export const HOT = { cpu: 50, mem: 80 } as const;

export function meterOf(stat: DockerStat | undefined, running: boolean) {
  const has = !!stat && running;
  return {
    cpu: has ? stat!.cpu : null,
    mem: has ? stat!.mem : null,
    cpuHot: has && stat!.cpu >= HOT.cpu,
    memHot: has && stat!.mem >= HOT.mem,
    memSub: has ? stat!.memUsage.split(" / ")[0]! : "",
  };
}

export interface PortCell { kind: "none" | "web" | "plain" | "off"; label: string; url?: string; title: string }

export function portCell(c: DockerContainer): PortCell {
  const state = (c.state || "").toLowerCase();
  const p: DockerPort | null = firstReachable(c.portList);
  const legacy = /(\d+)->/.exec(c.ports || "")?.[1];
  const label = p ? portLabel(p) : legacy ? `:${legacy}` : "";
  const none: PortCell = { kind: "none", label: "—", title: "No port" };
  if (!label || state === "restarting" || state === "dead") return none;
  if (state === "paused") return { kind: "off", label: `${label} · paused`, title: "Paused: nothing answers" };
  if (state !== "running") return { kind: "off", label: `${label} · off`, title: "Published when it runs" };
  const url = p ? portUrl(p) : null;
  if (url) return { kind: "web", label: url.replace(/^https?:\/\//, ""), url, title: `Open ${url}` };
  return { kind: "plain", label, title: "Published, but not a web port" };
}

/** The ones that need you first; the rest keep their order. */
export const needFirst = (cs: DockerContainer[]): DockerContainer[] =>
  [...cs].sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)));

/* ------------------------------------------------------------------- groups */

export type GroupBy = "stack" | "worktree";

export interface GroupView {
  key: string;
  stack: DockerStack;
  /** The containers shown, the ones that need you first. */
  containers: DockerContainer[];
  summary: ReturnType<typeof stackSummary>;
  folded: boolean;
  /** The name with its checkout, for the places a chip would not fit. */
  label: string;
  /** The checkout in stack mode, the stack in worktree mode. */
  chip: { text: string; foreign: boolean } | null;
}

const stacksOf = (cs: DockerContainer[], by: GroupBy): DockerStack[] =>
  needingFirst(by === "worktree" ? toWorktrees(cs) : toStacks(cs));

/** `open` is the remembered map (key: shown open), the same shape the panel always stored. */
export function groupsView(all: DockerContainer[], o: {
  groupBy: GroupBy; q: string; answer: Answer | null; open: Record<string, boolean>;
}): GroupView[] {
  const shown = all.filter((c) => matchesQuery(c, o.q) && (!o.answer || answerOf(c) === o.answer));
  const filtering = !!o.q.trim() || !!o.answer;
  return stacksOf(shown, o.groupBy).map((stack) => {
    const containers = needFirst(stack.containers);
    const remembered = stack.project in o.open ? !o.open[stack.project] : undefined;
    const lead = containers[0]!;
    const chipText = o.groupBy === "stack"
      ? (stack.owner?.worktree && stack.owner.worktree !== NO_OWNER ? stack.owner.worktree : "")
      : (lead.project ?? "");
    return {
      key: stack.project, stack, containers, summary: stackSummary(containers),
      label: o.groupBy === "stack" && chipText ? `${stack.project} · ${chipText}` : stack.project,
      folded: foldedByDefault(stack, { total: all.length, remembered, filtering }),
      chip: chipText ? { text: chipText, foreign: o.groupBy === "stack" && stack.foreign } : null,
    };
  });
}

/** The map is the whole fleet, whatever the filter says. */
export function mapGroups(all: DockerContainer[], by: GroupBy) {
  return stacksOf(all, by).map((s) => ({
    key: s.project, containers: s.containers,
    label: by === "stack" && s.owner?.worktree ? `${s.project} · ${s.owner.worktree}` : s.project,
  }));
}

/** "3 of 14", and who is either side. */
export function stepOf(ids: string[], sel: string | null) {
  const at = ids.indexOf(sel ?? "");
  if (at < 0) return { i: 0, n: ids.length, prev: null, next: null };
  return { i: at + 1, n: ids.length, prev: ids[at - 1] ?? null, next: ids[at + 1] ?? null };
}

/** The feed samples the whole host; keep the containers this view shows. With none known yet, keep all. */
export function mergeStats(incoming: DockerStat[], known: ReadonlySet<string>): Record<string, DockerStat> {
  const out: Record<string, DockerStat> = {};
  for (const s of incoming) if (!known.size || known.has(s.id)) out[s.id] = s;
  return out;
}

/* ------------------------------------------------------------------- layout */

export type Layout = "list" | "split";
export const LAYOUT_KEY = "agx.docker.layout";

export function readLayout(get: (key: string) => string | null = (k) => localStorage.getItem(k)): Layout {
  try { return get(LAYOUT_KEY) === "split" ? "split" : "list"; } catch { return "list"; }
}
