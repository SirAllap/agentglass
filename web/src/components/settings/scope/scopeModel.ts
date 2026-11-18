/*
 * The "Applies to" control's decisions, without a renderer. The store is the one
 * the orchestration pages already use: scope "" is All projects, a folder is
 * that project; an override is a value the project holds beside the general one.
 * Nothing here writes. Switching scope only changes which value is read, so an
 * override is never discarded by looking at All projects.
 */

export type ScopeChoice = "all" | "project";

export const OPEN_A_PROJECT = "Open a project to set its own values";
/** A machine value under "Only <project>": locked, and it says why in a full sentence, never a fragment. */
export const LOCKED_TEXT = "This one is set for every project. Change it under All projects.";
/** The same machine value under All projects: it edits as usual and says it is not per project. */
export const MACHINE_NOTE = "This one is set for every project, not per project.";
/**
 * The Settings pages whose every value is machine-wide. They show one scope
 * line in the page header ("Settings for · This machine") and no Applies to
 * control: offering "Only <project>" there would lock the whole page. Every
 * other Agents page draws the Applies to control and no header line.
 */
export const MACHINE_PAGES: ReadonlySet<string> = new Set(["hooks", "engines"]);
export const MACHINE_SCOPE = { key: "Settings for", pill: "This machine", note: "Every project on this machine." } as const;
/** A locked block says what it is and how to change it; "All projects" after it is the button. */
export const SAME_EVERYWHERE = "Same for every project. Switch to";
export const SEARCH_FROM = 8;

/**
 * Every project the app knows, the open one first, none twice: the open ones,
 * then every one the "Open projects" dialog lists under All projects (folders
 * scanned and recent). Not only what is open right now.
 */
export function projectList(workspaces: readonly string[], open: string | null, known: readonly string[] = []): string[] {
  const rest = [...new Set([...workspaces, ...known])].filter((w) => w !== open);
  return open ? [open, ...rest] : rest;
}

/** The menu's rows for a search: case-insensitive on the name or the folder. Few projects: no search, all rows. */
export function filterProjects(projects: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (projects.length <= SEARCH_FROM || !q) return [...projects];
  return projects.filter((p) => projectName(p).toLowerCase().includes(q) || p.toLowerCase().includes(q));
}

/** The project the page is scoped to: the remembered one while it is still known, else the open one. */
export function pickedProject(stored: string, projects: readonly string[], open: string | null): string | null {
  return stored !== "" && projects.includes(stored) ? stored : open;
}

export const projectName = (root: string): string => root.split("/").filter(Boolean).pop() ?? root;

/** The two options. No project open: the second one is there but cannot be picked. */
export function scopeOptions(project: string | null): readonly { id: ScopeChoice; label: string; disabled: boolean; reason?: string }[] {
  return [
    { id: "all", label: "All projects", disabled: false },
    project
      ? { id: "project", label: `Only ${projectName(project)}`, disabled: false }
      : { id: "project", label: "Only this project", disabled: true, reason: OPEN_A_PROJECT },
  ];
}

/** What the closed "Applies to" button says: "All projects", or the project's name. */
export const triggerLabel = (choice: ScopeChoice, project: string | null): string =>
  choice === "project" && project ? projectName(project) : "All projects";

/** One row of the "Applies to" menu: All projects, the line under it, a project, or the empty-search line. */
export type MenuRow =
  | { kind: "all"; label: string; checked: boolean }
  | { kind: "divider" }
  | { kind: "project"; root: string; name: string; checked: boolean }
  | { kind: "empty"; label: string };

/**
 * The menu, top to bottom: "All projects", a divider, then every project the
 * search keeps (the order `projectList` gave), the current choice checked.
 * The search only filters from SEARCH_FROM projects up (see filterProjects).
 */
export function menuRows(projects: readonly string[], project: string | null, choice: ScopeChoice, query = ""): MenuRow[] {
  const shown = filterProjects(projects, query);
  const on = choice === "project" && project ? project : null;
  return [
    { kind: "all", label: "All projects", checked: on === null },
    ...(projects.length ? [{ kind: "divider" } as const] : []),
    ...shown.map((root) => ({ kind: "project" as const, root, name: projectName(root), checked: root === on })),
    ...(projects.length && !shown.length ? [{ kind: "empty" as const, label: "No project matches." }] : []),
  ];
}

/** Type-ahead without a search field: the first project whose name starts with what was typed, or -1. */
/**
 * The project Enter in the search field picks: the first match, but only once
 * something is typed. The field has focus when the menu opens, so Enter on an
 * empty query would scope the page to a project nobody chose.
 */
export function enterPick(rows: readonly MenuRow[], query: string): string | null {
  if (!query.trim()) return null;
  const first = rows.find((r) => r.kind === "project");
  return first?.kind === "project" ? first.root : null;
}

/**
 * A page's menu list plus the projects it holds saved values for, none twice and
 * no hidden one added: a saved value must not bring back a project the person hid.
 */
export function withSaved(projects: readonly string[], saved: readonly string[], hidden: ReadonlySet<string>): string[] {
  return [...new Set([...projects, ...saved.filter((p) => !hidden.has(p))])];
}

export function typeAhead(rows: readonly MenuRow[], typed: string): number {
  const q = typed.toLowerCase();
  if (!q) return -1;
  return rows.findIndex((r) => (r.kind === "project" ? r.name : r.kind === "all" ? r.label : "").toLowerCase().startsWith(q));
}

/** The scope the store is read with: "" for All projects, else the project folder. */
export const rootFor = (choice: ScopeChoice, project: string | null): string =>
  choice === "project" && project ? project : "";

/** A project that is gone while "Only <it>" was chosen reads as All projects, never as an empty setting. */
export const choiceFor = (root: string, project: string | null): ScopeChoice =>
  root !== "" && root === project ? "project" : "all";

/** One setting on the page, as the scope control needs it. `own` is undefined when the project follows all projects. */
export interface ScopeRow<V = unknown> {
  id: string;
  general: V;
  own?: V;
  /** A machine value: it cannot differ per project. */
  machine?: boolean;
}

export type RowTag =
  | { kind: "none" }
  | { kind: "locked"; text: string }
  | { kind: "same"; text: string }
  | { kind: "differs"; text: string; reset: string };

export const isOverride = <V,>(r: ScopeRow<V>): boolean => !r.machine && r.own !== undefined;

/**
 * What a row says under "Only <project>". Under All projects rows show nothing
 * extra, except a machine row, which says why it is not per project.
 */
export function rowTag<V>(r: ScopeRow<V>, choice: ScopeChoice, show: (v: V) => string): RowTag {
  if (r.machine) return { kind: "locked", text: choice === "project" ? LOCKED_TEXT : MACHINE_NOTE };
  if (choice === "all") return { kind: "none" };
  if (!isOverride(r)) return { kind: "same", text: "Same as all projects" };
  const was = show(r.general);
  return { kind: "differs", text: `Differs from all projects (was ${was})`, reset: `Reset to all projects (${was})` };
}

/** The value a row shows: the project's own under "Only <project>" when it has one, else the general one. */
export const valueOf = <V,>(r: ScopeRow<V>, choice: ScopeChoice): V =>
  choice === "project" && isOverride(r) ? (r.own as V) : r.general;

export const differing = <V,>(rows: readonly ScopeRow<V>[]): ScopeRow<V>[] => rows.filter(isOverride);

/** "N settings differ from all projects · Show them", only under "Only <project>" and only when some do. */
export function summaryText(rows: readonly ScopeRow[], choice: ScopeChoice): string | null {
  if (choice !== "project") return null;
  const n = differing(rows).length;
  if (n === 0) return null;
  return `${n} ${n === 1 ? "setting differs" : "settings differ"} from all projects · Show them`;
}

/** Show filters the page to the differing rows; it only applies under "Only <project>". */
export function visibleRows<V>(rows: readonly ScopeRow<V>[], choice: ScopeChoice, onlyDiffering: boolean): ScopeRow<V>[] {
  return choice === "project" && onlyDiffering ? differing(rows) : [...rows];
}

/** The toast after a reset, in the words of the card. */
export const resetToast = (project: string, label: string): string =>
  `${projectName(project)} now follows all projects for ${label}.`;

/**
 * Reset keeps what it removed. Undo puts the same value back: the one write the
 * page sends is `{ id, own }` with `own` the value the project held.
 */
export interface Reset<V = unknown> { id: string; own: V }
export function resetOf<V>(r: ScopeRow<V>): Reset<V> | null {
  return isOverride(r) ? { id: r.id, own: r.own as V } : null;
}
