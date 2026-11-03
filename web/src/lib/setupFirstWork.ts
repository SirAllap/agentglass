/*
 * Step 5: the project, the command that will run, and the one door out.
 *
 * Everything the screen says comes from data: the projects the workspace
 * already holds, the branch each is on, the picked agent's own title and
 * command, and `launch.mode`'s label. The ticket is asked for in the project
 * this step names, with the picked agent as its kind — never a literal
 * `claude`. The pane is handed to the Terminal view by id, and a failure keeps
 * the wizard where it is with the server's own sentence.
 */
import type { EngineReadiness, EnginesReport, GitRepoRef } from "../../../shared/types.ts";
import { agentKind, agentProvider } from "../../../shared/agentKinds.ts";
import { LAUNCH_MODE_LABEL, type LaunchMode } from "../../../shared/launchModes.ts";
import { api } from "./api.ts";
import { branchLabel } from "./setupRepos.ts";
import { requestWorktreeJump } from "./worktreeJump.ts";

/** How many project tiles the step shows; the rest become one line. */
export const PROJECT_TILES = 3;
/** How many characters of a project name one tile shows. */
export const PROJECT_NAME_MAX = 24;

export interface FirstWorkProject {
  root: string;
  name: string;
  branch: string;
  /** Last worked in, epoch ms; 0 when git could not say. */
  touchedAt: number;
}

/** The open projects, in the order the workspace keeps them; none is not "every repo git knows". */
export function firstWorkProjects(repos: readonly GitRepoRef[], workspaces: readonly string[]): FirstWorkProject[] {
  const byRoot = new Map(repos.map((r) => [r.root, r]));
  const ordered = workspaces.map((root) => byRoot.get(root)).filter((r): r is GitRepoRef => !!r);
  return ordered.map((r) => ({ root: r.root, name: r.name, branch: r.branch, touchedAt: r.touchedAt }));
}

/** The tiles on screen and the count behind `N more`. */
export function projectTiles(projects: readonly FirstWorkProject[]): {
  shown: FirstWorkProject[];
  more: number;
} {
  return { shown: projects.slice(0, PROJECT_TILES), more: Math.max(0, projects.length - PROJECT_TILES) };
}

/** A project's name on one tile: cut, with the full value on `title`. */
export function projectLabel(name: string): string {
  return branchLabel(name, PROJECT_NAME_MAX);
}

/** How long ago a checkout was last worked in, as one short line. */
export function workedAgo(touchedAt: number, now = Date.now()): string {
  if (!touchedAt) return "not worked in yet";
  const mins = Math.max(0, Math.round((now - touchedAt) / 60000));
  if (mins < 60) return `worked ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `worked ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `worked ${days}d ago`;
}

export interface FirstWorkView {
  /** The button's own words. */
  primary: string;
  /** The step cannot act at all (no project). */
  blocked: boolean;
  /** Which door the primary uses. */
  action: "agent" | "shell" | "none";
  agentTitle: string;
  /** `starts in Ask — the mode Settings › Terminal sets.` */
  lock: string;
  /** The command the pane will run, for the preview's prompt line. */
  command: string;
  /** A sentence under the block, or null. */
  notice: string | null;
}

export function firstWorkView({ engine, agent, mode, project }: {
  engine: EngineReadiness | undefined;
  agent: string;
  mode: LaunchMode;
  project: FirstWorkProject | null;
}): FirstWorkView {
  const title = engine?.title || agentProvider(agent)?.title || agent;
  const command = agentKind(agent)?.bin || agent;
  const lock = `${title} starts in ${LAUNCH_MODE_LABEL[mode]} — the mode Settings › Terminal sets. This screen does not change it.`;
  if (!project) {
    return {
      primary: "Pick a folder", blocked: false, action: "none", agentTitle: title, lock, command,
      notice: "A terminal needs a project to open in.",
    };
  }
  if (!engine || !engine.found) {
    return {
      primary: `Open a terminal in ${projectLabel(project.name)} anyway`, blocked: false, action: "shell",
      agentTitle: title, lock, command,
      notice: `${title} is not installed.`,
    };
  }
  const signed = engine.account.signedIn === true;
  return {
    primary: `Open the terminal in ${projectLabel(project.name)}`, blocked: false, action: "agent",
    agentTitle: title, lock, command,
    notice: signed ? null : `${title} is not signed in — the pane starts and asks you to sign in there.`,
  };
}

/** What the tile's own two lines say. */
export function projectTileLines(p: FirstWorkProject): { name: string; branch: string; worked: string } {
  return { name: projectLabel(p.name), branch: branchLabel(p.branch), worked: workedAgo(p.touchedAt) };
}

/** The project a picked agent is measured against; undefined is "not read". */
export function engineFor(report: EnginesReport | null, agent: string): EngineReadiness | undefined {
  return report?.engines.find((e) => e.id === agent);
}

/** Mint the ticket in that project and hand the pane to the Terminal view. */
export async function openFirstWork(project: FirstWorkProject, agent: string, deps: {
  mint?: (cwd: string, prompt: string, yolo: boolean, title: string, kind?: string) => Promise<{ ok: boolean; ticket?: string; error?: string }>;
  hand?: (root: string, ticket: string) => void;
} = {}): Promise<{ ok: boolean; error?: string }> {
  const mint = deps.mint ?? api.termAgentTicket;
  const hand = deps.hand ?? requestSetupPane;
  const title = agentProvider(agent)?.title ?? agent;
  try {
    const r = await mint(project.root, "", false, title, agent);
    if (!r.ok || !r.ticket) return { ok: false, error: r.error || "the server did not answer with a ticket" };
    hand(project.root, r.ticket);
    requestWorktreeJump({ view: "term" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** The other door: a shell in the same project, for a chosen agent that is absent. */
export async function openFirstWorkShell(project: FirstWorkProject): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await api.openShell(project.root);
    if (!r.ok) return { ok: false, error: r.error || "the server did not open a terminal" };
    requestWorktreeJump({ view: "term" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* One slot for a pane the Terminal view has not been able to make yet: the
 * step mints the ticket, the view creates the session when it is mounted. */
export interface SetupPane { root: string; ticket: string }

let pane: SetupPane | null = null;
const subs = new Set<() => void>();

export function subscribeSetupPane(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
export function setupPane(): SetupPane | null { return pane; }
export function requestSetupPane(root: string, ticket: string): void {
  pane = { root, ticket };
  subs.forEach((f) => f());
}
export function takeSetupPane(): SetupPane | null {
  const p = pane;
  pane = null;
  subs.forEach((f) => f());
  return p;
}
