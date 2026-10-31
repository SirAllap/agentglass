/*
 * The two-second answer.
 *
 * "3 of 14 containers need you" is the first thing the Containers view says,
 * with three answers under it that also work as filters, stacks that put the
 * troubled ones first, and a map of one square per container. Every one of
 * those reads `needsYou`, so a container is never in trouble in the sentence
 * and fine in the map.
 */
import type { DockerContainer, DockerStat } from "../../../shared/types.ts";
import { displayName, KINDS, kindOf, needsYou, type ContainerKind } from "./dockerState.ts";
import { LOOSE, type DockerStack } from "./dockerStacks.ts";

export type Answer = "need" | "run" | "stop";

export function answerOf(c: DockerContainer): Answer {
  if (needsYou(c)) return "need";
  return (c.state || "").toLowerCase() === "running" ? "run" : "stop";
}

export const withAnswer = (cs: DockerContainer[], a: Answer | null): DockerContainer[] =>
  a ? cs.filter((c) => answerOf(c) === a) : cs;

/** "billing-fix · api": the checkout when there is one, else the stack. */
const labelOf = (c: DockerContainer): string => `${c.owner?.worktree || c.project || LOOSE} · ${displayName(c)}`;

const MIB: Record<string, number> = { B: 1 / 1048576, KIB: 1 / 1024, KB: 1 / 1024, MIB: 1, MB: 1, GIB: 1024, GB: 1024 };
function usedMiB(memUsage: string): number | null {
  const m = /^([\d.]+)\s*([A-Za-z]+)/.exec(memUsage || "");
  const unit = m && MIB[m[2]!.toUpperCase()];
  return m && unit ? Number(m[1]) * unit : null;
}

const WHY: [ContainerKind, string][] = [
  ["unhealthy", "unhealthy"], ["restarting", "restarting over and over"], ["crash", "exited with an error"], ["dead", "dead"],
];

/** The sentence, the three answers and what each says about itself. Stats are
 *  optional: without them there is no busiest container and no memory figure,
 *  rather than a made-up zero. */
export function triage(all: DockerContainer[], stats: DockerStat[] = []) {
  const need = all.filter((c) => answerOf(c) === "need");
  const run = all.filter((c) => answerOf(c) === "run");
  const stop = all.filter((c) => answerOf(c) === "stop");
  const n = need.length;
  const lead = n ? `${n} of ${all.length} container${all.length === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} you.` : "Nothing needs you.";
  const rest = `${run.length} running fine${stop.length ? `, ${stop.length} stopped${n ? "" : " on purpose"}` : ""}.`;
  const why = WHY.map(([k, w]) => [need.filter((c) => kindOf(c) === k).length, w] as const)
    .filter(([count]) => count).map(([count, w]) => `${count} ${w}`).join(", ") || "nothing is wrong";

  const byId = new Map(stats.map((s) => [s.id, s]));
  const sampled = run.filter((c) => byId.has(c.id));
  const busiest = sampled.reduce<DockerContainer | null>((b, c) => (!b || byId.get(c.id)!.cpu > byId.get(b.id)!.cpu ? c : b), null);
  const mib = sampled.map((c) => usedMiB(byId.get(c.id)!.memUsage)).filter((v): v is number => v != null);
  const total = mib.reduce((a, b) => a + b, 0);
  return {
    all, need, run, stop, lead, rest, why,
    needNames: need.slice(0, 3).map(labelOf),
    stopNames: stop.slice(0, 2).map(labelOf),
    busiest,
    busiestCpu: busiest ? byId.get(busiest.id)!.cpu : null,
    memory: mib.length ? (total >= 1024 ? `${(total / 1024).toFixed(1)} GiB` : `${Math.round(total)} MiB`) : null,
    webPorts: run.reduce((a, c) => a + (c.portList?.filter((p) => p.web).length ?? 0), 0),
    paused: stop.filter((c) => kindOf(c) === "paused").length,
    made: stop.filter((c) => kindOf(c) === "made").length,
    labelOf,
  };
}

const hasNeed = (s: DockerStack): boolean => s.containers.some(needsYou);

/** Stacks with something that needs you first; every other keeps the order
 *  toStacks gave it. Array sort is stable, so this is a partition. */
export const needingFirst = (stacks: DockerStack[]): DockerStack[] =>
  [...stacks].sort((a, b) => Number(hasNeed(b)) - Number(hasNeed(a)));

/** A fleet this big folds the stacks that are fine. The mockup only tells five
 *  containers from seventy, so this is the nearest round number to where a
 *  page of open stacks stops fitting one screen. */
export const FOLD_FROM = 20;

/**
 * Does a stack start folded?
 *
 * A stack that needs you is never folded, whatever was remembered: the reason
 * to fold is that it is fine and you want the room. A search or an answer card
 * opens everything, because the matches are what you asked to see.
 */
export function foldedByDefault(stack: DockerStack, o: { total: number; remembered?: boolean; filtering?: boolean }): boolean {
  if (o.filtering || hasNeed(stack)) return false;
  return o.remembered ?? o.total >= FOLD_FROM;
}

/** "2/3 up · 1 needs you". Only running counts as up: a restart loop is not. */
export function stackSummary(cs: DockerContainer[]) {
  const up = cs.filter((c) => (c.state || "").toLowerCase() === "running").length;
  const need = cs.filter(needsYou).length;
  return { up, total: cs.length, need, text: `${up}/${cs.length} up${need ? ` · ${need} ${need === 1 ? "needs" : "need"} you` : ""}` };
}

export type SquareTone = "up" | "need" | "restart" | "pause" | "stop" | "made";
export const SQUARE_TONE: Record<ContainerKind, SquareTone> = {
  up: "up", healthy: "up", unhealthy: "need", crash: "need", dead: "need", restarting: "restart", paused: "pause", stop: "stop", made: "made",
};

/** One square per container, the ones that need you first. Squares outside the
 *  filter stay (the map is the whole fleet) but go dim. */
export function stackMap(cs: DockerContainer[], o: { inFilter?: ReadonlySet<string>; selected?: string | null } = {}) {
  return [...cs].sort((a, b) => Number(needsYou(b)) - Number(needsYou(a))).map((c) => {
    const kind = kindOf(c);
    return {
      id: c.id, kind, tone: SQUARE_TONE[kind],
      dim: !!o.inFilter && !o.inFilter.has(c.id),
      current: c.id === o.selected,
      title: `${displayName(c)}: ${KINDS[kind].word}`,
    };
  });
}
