/*
 * What one container is, and what its row and menu offer for that.
 *
 * Nine kinds, each with a word, a tone and a shape, so a state is never told by
 * colour alone. "Needs you" is read off the kind and nowhere else: the sentence
 * on top, the answer cards, the squares in the map and the sort order all ask
 * `needsYou`, so they cannot disagree about which containers are in trouble.
 *
 * `containerHealth` in dockerStacks.ts is the older four-level reading the
 * stack chips still use; the two agree on what is broken, but this one also
 * counts a crashed exit and a restart loop as needing a person.
 */
import type { DockerContainer } from "../../../shared/types.ts";

export type ContainerKind =
  | "up" | "healthy" | "unhealthy" | "restarting" | "paused" | "stop" | "made" | "crash" | "dead";

export interface KindLook {
  /** The word a screen reader and a tooltip use. */
  word: string;
  tone: string;
  /** Names a drawing, not a colour: two kinds never share one. */
  shape: string;
}

export const KINDS: Record<ContainerKind, KindLook> = {
  up: { word: "running", tone: "var(--success)", shape: "dot" },
  healthy: { word: "running, healthy", tone: "var(--success)", shape: "dot-check" },
  unhealthy: { word: "unhealthy", tone: "var(--error)", shape: "triangle" },
  restarting: { word: "restarting", tone: "var(--warning)", shape: "spinner" },
  paused: { word: "paused", tone: "var(--warning)", shape: "pause" },
  stop: { word: "stopped", tone: "var(--text4)", shape: "ring" },
  made: { word: "created, never started", tone: "var(--info)", shape: "ring-dashed" },
  crash: { word: "exited with an error", tone: "var(--error)", shape: "ring-x" },
  dead: { word: "dead", tone: "var(--error)", shape: "square-x" },
};

/** The N in "Exited (N) 2 hours ago". Null when the status does not say, which
 *  is not the same as 0: an unknown exit must not read as a crash. */
export function exitCode(c: Pick<DockerContainer, "status">): number | null {
  const m = /^Exited \((-?\d+)\)/.exec(c.status || "");
  return m ? Number(m[1]) : null;
}

/** The first match wins, in the mockup's order: a restart loop is a restart
 *  loop even if a stale health flag says otherwise. A state docker adds later
 *  reads as stopped, the one reading that offers nothing destructive. */
export function kindOf(c: DockerContainer): ContainerKind {
  const state = (c.state || "").toLowerCase();
  if (state === "dead") return "dead";
  if (state === "restarting") return "restarting";
  if (c.health === "unhealthy") return "unhealthy";
  if (state === "paused") return "paused";
  if (state === "exited") return exitCode(c) ? "crash" : "stop";
  if (state === "created") return "made";
  if (state === "running") return c.health === "healthy" ? "healthy" : "up";
  return "stop";
}

const NEEDS: ReadonlySet<ContainerKind> = new Set(["unhealthy", "restarting", "crash", "dead"]);
export const kindNeedsYou = (k: ContainerKind): boolean => NEEDS.has(k);
export const needsYou = (c: DockerContainer): boolean => kindNeedsYou(kindOf(c));

/** What a container is called in a row: its compose service, else its name. */
export const displayName = (c: DockerContainer): string => c.service || c.name;

export const READ_ONLY_REASON = "Read-only instance: writes are turned off";

export type RowVerb = "start" | "restart" | "unpause" | "rm";
export interface RowAction {
  verb: RowVerb;
  label: string;
  tone: string;
  disabled?: boolean;
  reason?: string;
}

/** The one button a row shows: the likely next step for this state. Stop and
 *  Remove live in the menu; Resume (docker unpause) is a paused row's. */
export function rowAction(kind: ContainerKind, opts: { readOnly?: boolean } = {}): RowAction {
  let a: RowAction;
  if (kind === "stop" || kind === "made" || kind === "crash") a = { verb: "start", label: "Start", tone: "var(--success)" };
  else if (kind === "dead") a = { verb: "rm", label: "Remove", tone: "var(--error)" };
  else if (kind === "paused") a = { verb: "unpause", label: "Resume", tone: "var(--success)" };
  else a = { verb: "restart", label: "Restart", tone: kind === "unhealthy" ? "var(--error)" : kind === "restarting" ? "var(--warning)" : "var(--text2)" };
  return opts.readOnly ? { ...a, disabled: true, reason: READ_ONLY_REASON } : a;
}

export interface MenuItem {
  verb: "logs" | "insp" | "shell" | "open" | "unpause" | "stop" | "rm" | "hr";
  label: string;
  key?: string;
  disabled?: boolean;
  reason?: string;
  danger?: boolean;
}

const HR: MenuItem = { verb: "hr", label: "" };
const LIVE = new Set(["running", "restarting", "paused"]);

/** The `...` menu, same slot on every row. Reads first, then the verbs that
 *  change something; a read-only instance keeps only the reads. */
export function menuItems(c: DockerContainer, opts: { where?: "row" | "detail"; readOnly?: boolean } = {}): MenuItem[] {
  const state = (c.state || "").toLowerCase();
  const reads: MenuItem[] = [];
  const acts: MenuItem[] = [];
  reads.push(opts.where === "detail" ? { verb: "insp", label: "Inspect (raw JSON)" } : { verb: "logs", label: "Logs" });
  if (opts.readOnly) return reads;

  const web = state === "running" ? c.portList?.find((p) => p.web && p.host != null) : undefined;
  if (state === "running") reads.push({ verb: "shell", label: "Shell" });
  if (web) reads.push({ verb: "open", label: `Open in browser · :${web.host}` });

  const live = LIVE.has(state);
  if (state === "paused") acts.push({ verb: "unpause", label: "Resume" });
  if (live) acts.push({ verb: "stop", label: "Stop", key: "s" });
  if (kindOf(c) !== "dead") {
    acts.push({ verb: "rm", label: "Remove…", danger: true, ...(live ? { disabled: true, reason: "Stop it first" } : {}) });
  }
  return reads.length && acts.length ? [...reads, HR, ...acts] : [...reads, ...acts];
}

export interface GroupVerb {
  label: string;
  /** Exactly the containers this verb would touch. */
  ids: string[];
  count: number;
  disabled?: boolean;
  reason?: string;
}

/**
 * The stack header's menu and its one button.
 *
 * "Stopped" here means exited or created: the two states `docker start` takes.
 * A paused container needs Resume and a dead one needs removing, so a group
 * Start would only fail on them.
 */
export function groupMenu(cs: DockerContainer[], opts: { readOnly?: boolean } = {}) {
  const ids = (states: string[]) => cs.filter((c) => states.includes((c.state || "").toLowerCase())).map((c) => c.id);
  const mk = (label: string, list: string[]): GroupVerb => ({
    label, ids: list, count: list.length,
    ...(opts.readOnly ? { disabled: true, reason: READ_ONLY_REASON } : list.length ? {} : { disabled: true }),
  });
  const stopped = ids(["exited", "created"]);
  const running = ids(["running", "restarting"]);
  const start = mk(`Start the ${stopped.length} stopped`, stopped);
  const restart = mk("Restart all running", running);
  const stop = mk("Stop all running", running);
  const nothingRuns = !cs.some((c) => ["running", "restarting"].includes((c.state || "").toLowerCase()));
  const button = nothingRuns
    ? { verb: "start" as const, ...mk("Start all", stopped) }
    : { verb: "restart" as const, ...mk("Restart all", running) };
  return { start, restart, stop, button };
}
