/*
 * A compose project as a thing, not as a heading.
 *
 * Twelve containers listed flat is twelve lines to read before you know whether
 * anything is wrong. What you actually want to know first is "is my stack up?",
 * and that question has an answer the panel already has the pieces for: how
 * many are running, whether any of them is failing, and how long they have been
 * that way.
 *
 * The aggregation lives here rather than in the component because the rules are
 * opinions worth pinning: what counts as broken, what a stack is called when
 * its containers come from different checkouts, and which stack goes first.
 */
import type { DockerContainer, DockerOwnerRef } from "../../../shared/types.ts";

/** Worst-first, and the order matters: it is the order the row's colour is
 *  chosen in and the order stacks are sorted by. */
export type StackHealth = "bad" | "warn" | "off" | "ok";

export interface DockerStack {
  /** The compose project, or the bucket standalone containers land in. */
  project: string;
  containers: DockerContainer[];
  up: number;
  total: number;
  worst: StackHealth;
  /** The checkout every container in this stack came from, when they agree.
   *  Null when they do not — which is itself worth seeing, because a stack
   *  half-started from another worktree is a state nothing else reports. */
  owner: DockerOwnerRef | null;
  /** True when the whole stack came out of a checkout that is not the open
   *  project. */
  foreign: boolean;
}

/** The bucket for containers compose knows nothing about — `docker run`,
 *  Podman, k3d. They are real and must not vanish. */
export const LOOSE = "(standalone)";

/**
 * How one container reads.
 *
 * `restarting` is amber, not green: docker restarting something in a loop looks
 * "up" in every flat list, and it is the state most worth catching early. An
 * unhealthy container is red even while running, because that is the whole
 * point of declaring a health check.
 */
export function containerHealth(c: DockerContainer): StackHealth {
  const state = (c.state || "").toLowerCase();
  if (state === "dead" || state === "removing") return "bad";
  if (c.health === "unhealthy") return "bad";
  if (state === "restarting" || c.health === "starting") return "warn";
  if (state === "running") return "ok";
  // exited / created / paused: not running, not broken. A stopped stack is a
  // normal thing to have, and painting it red would make red mean nothing.
  return "off";
}

const RANK: Record<StackHealth, number> = { bad: 0, warn: 1, off: 2, ok: 3 };

/** The worst state in the set — the one the stack's own row shows. */
export function worstOf(items: StackHealth[]): StackHealth {
  return items.reduce<StackHealth>((worst, h) => (RANK[h] < RANK[worst] ? h : worst), "ok");
}

/**
 * Group containers into stacks.
 *
 * Order: anything broken first, then anything running, then the stopped ones,
 * each group alphabetical. A stack you have to scroll to find is a stack you
 * will not look at, and the one with a dead container in it is exactly the one
 * that should not need finding.
 */
export function toStacks(containers: DockerContainer[]): DockerStack[] {
  const byProject = new Map<string, DockerContainer[]>();
  for (const c of containers) {
    const key = c.project || LOOSE;
    const list = byProject.get(key);
    if (list) list.push(c); else byProject.set(key, [c]);
  }

  const stacks: DockerStack[] = [];
  for (const [project, list] of byProject) {
    const owners = list.map((c) => c.owner).filter((o): o is DockerOwnerRef => !!o);
    const agreed = owners.length === list.length && owners.every((o) => o.path === owners[0]!.path) ? owners[0]! : null;
    stacks.push({
      project,
      containers: list,
      up: list.filter((c) => (c.state || "").toLowerCase() === "running").length,
      total: list.length,
      worst: worstOf(list.map(containerHealth)),
      owner: agreed,
      foreign: !!agreed?.foreign,
    });
  }

  return stacks.sort((a, b) => {
    // Standalone last whatever its state: it is a bucket, not a stack, and it
    // is usually somebody else's business.
    if ((a.project === LOOSE) !== (b.project === LOOSE)) return a.project === LOOSE ? 1 : -1;
    if (RANK[a.worst] !== RANK[b.worst]) return RANK[a.worst] - RANK[b.worst];
    return a.project.localeCompare(b.project);
  });
}

/** What the stack's chip says. Short, and it names the problem when there is
 *  one — "11/12 up" is a fact, "1 down" is the fact you needed. */
export function stackLabel(s: DockerStack): string {
  if (s.total === 0) return "empty";
  const down = s.containers.filter((c) => containerHealth(c) === "bad").length;
  if (down) return `${down} down`;
  if (s.up === 0) return "stopped";
  if (s.up < s.total) return `${s.up}/${s.total} up`;
  return `${s.total} up`;
}

/**
 * The dots: one per container, in the stack's own order, capped.
 *
 * Capped because a stack of forty is a stripe, not a signal — past a point the
 * count carries more than the dots do, and the row still has to fit.
 */
export function stackDots(s: DockerStack, cap = 14): { dots: StackHealth[]; more: number } {
  const all = s.containers.map(containerHealth);
  return all.length <= cap ? { dots: all, more: 0 } : { dots: all.slice(0, cap), more: all.length - cap };
}

/**
 * Which stacks start open.
 *
 * Anything not healthy opens itself: the reason to collapse a stack is that it
 * is fine and you want the room, and a stack with a dead container in it is
 * never that. Otherwise the remembered choice wins, and a stack nobody has an
 * opinion about starts open when it is the only one.
 */
export function initiallyOpen(stacks: DockerStack[], remembered: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const s of stacks) {
    out[s.project] = s.worst === "bad" || s.worst === "warn"
      ? true
      : remembered[s.project] ?? (stacks.length === 1 || s.worst === "ok");
  }
  return out;
}


/**
 * The same containers, grouped by the checkout they came from.
 *
 * The list pivoted: not "what stacks are there" but "what is running out of
 * each of my worktrees", which is the question a machine with twenty-five of
 * them actually raises. Containers with no owner land in one bucket rather than
 * disappearing — something is running and not knowing whose it is is itself
 * worth seeing.
 */
export const NO_OWNER = "(no checkout)";

export function toWorktrees(containers: DockerContainer[]): DockerStack[] {
  const by = new Map<string, DockerContainer[]>();
  for (const c of containers) {
    const key = c.owner?.worktree || NO_OWNER;
    const list = by.get(key);
    if (list) list.push(c); else by.set(key, [c]);
  }
  const out: DockerStack[] = [];
  for (const [worktree, list] of by) {
    out.push({
      project: worktree,
      containers: list,
      up: list.filter((c) => (c.state || "").toLowerCase() === "running").length,
      total: list.length,
      worst: worstOf(list.map(containerHealth)),
      owner: list.find((c) => c.owner)?.owner ?? null,
      foreign: !!list.find((c) => c.owner)?.owner?.foreign,
    });
  }
  return out.sort((a, b) => {
    if ((a.project === NO_OWNER) !== (b.project === NO_OWNER)) return a.project === NO_OWNER ? 1 : -1;
    // Yours first when it is known: the checkout you have open is the one you
    // are asking about, and it should not be alphabetically third.
    if (a.foreign !== b.foreign) return a.foreign ? 1 : -1;
    if (RANK[a.worst] !== RANK[b.worst]) return RANK[a.worst] - RANK[b.worst];
    return a.project.localeCompare(b.project);
  });
}

/**
 * Does this container match what somebody typed?
 *
 * Everything a row shows is searchable, plus the things it only implies: the
 * worktree, the branch and the published ports. Typing `8000` should find the
 * container serving it — that is the actual question ("what is on this port"),
 * and it is one the flat list could never answer.
 */
export function matchesQuery(c: DockerContainer, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    c.name, c.service ?? "", c.image, c.project ?? "", c.state, c.status,
    c.owner?.worktree ?? "", c.owner?.branch ?? "",
    ...(c.portList ?? []).map((p) => `${p.host ?? ""} ${p.container}`),
    c.ports,
  ].join(" ").toLowerCase();
  // Every word has to appear somewhere: "keypad 8000" is two facts about one
  // container, not a phrase.
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Keep the containers that match, and drop the stacks left empty. A stack
 *  header with nothing under it is a row that answers nothing. */
export function filterStacks(stacks: DockerStack[], query: string): DockerStack[] {
  if (!query.trim()) return stacks;
  return stacks
    .map((s) => ({ ...s, containers: s.containers.filter((c) => matchesQuery(c, query)) }))
    .filter((s) => s.containers.length);
}
