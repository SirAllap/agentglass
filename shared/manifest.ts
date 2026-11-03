/*
 * WHAT THE MANIFEST VIEW READS, AND WHAT IT MAY WRITE.
 *
 * One shape shared by the server and the view, so a row drawn on the desk and a
 * row drawn on the phone cannot disagree about what a verdict is.
 */

/** What a person can say about a row. `cleared` is the undo, never stored. */
export type ManifestVerdict = "tested" | "failed" | "cleared";
/** A verdict as it is stored and drawn. */
export type ManifestSigned = "tested" | "failed";

/**
 * Whether this caller may sign off here.
 *
 * `grant` is a paired phone without the `answer` grant: it can read the list
 * and the buttons stay quiet. `off` is every other refused window.
 */
export type ManifestSignOff = "yes" | "grant" | "off";

/** A row's place in the view. The sets are decided on the server once. */
export type ManifestGroup = "toTest" | "done" | "ready";

export interface ManifestRow {
  /** Full commit sha: the row's identity and the key of its verdict. */
  sha: string;
  subject: string;
  /** The commit's committer time, epoch seconds. */
  time: number;
  /** `ORBIT-1042`, when the subject names one. */
  ticket: string | null;
  /**
   * In the build that is running. `null` when this project has no install
   * boundary, which is not the same as "not in the build".
   */
  inBuild: boolean | null;
  verdict: ManifestSigned | null;
  /** When the verdict was given, ms. */
  at: number | null;
  kind: "person" | "phone" | null;
  note: string | null;
  group: ManifestGroup;
}

export interface ManifestInProgress {
  name: string;
  doing: string;
  branch: string;
  /** When the agent said what it is doing, ms. */
  startedAt: number;
  /** The tmux pane behind it, for "Show it". Absent when none is known. */
  paneId?: string;
}

export interface ManifestCounters {
  /** First-parent trunk commits inside the 7-day window. */
  merged: number;
  /** Agents of this project that are working now. */
  running: number;
  /** Window rows outside the running build; `null` when there is no boundary. */
  builtWaiting: number | null;
}

export interface ManifestProject {
  root: string;
  name: string;
  /** `build` when this checkout contains the running build's commit. */
  boundary: "build" | "none";
  /** False when the checkout has no trunk to read. */
  trunk: boolean;
  signOff: ManifestSignOff;
  /** Where the count begins; null when there is no trunk and no line. */
  start: ManifestStart | null;
  rows: ManifestRow[];
  inProgress: ManifestInProgress[];
  counters: ManifestCounters;
  /** Unsigned To test rows, over every row and not only the ones drawn. */
  left: number;
}

/**
 * The commit a project is counted after, and when the line was set.
 *
 * The first read stores the trunk's current commit. Older commits are not
 * rows, counters or strip bars; a verdict already given stays visible.
 */
export interface ManifestStart {
  sha: string;
  /** When the line was set, ms. */
  at: number;
  /** Window commits behind the line that are not drawn because they have no verdict. */
  omitted: number;
}

export interface ManifestSummaryProject {
  root: string;
  name: string;
  /** Zero for a project this caller may not sign in, and for a null trunk. */
  left: number;
  signOff: ManifestSignOff;
  trunk: boolean;
}

/** `GET /manifest` with no project: what the rail dot reads. */
export interface ManifestSummary {
  projects: ManifestSummaryProject[];
}

export const MANIFEST_NOTE_MAX = 500;

/** What `POST /manifest/signoff` answers. */
export interface ManifestWrite {
  ok: boolean;
  error?: string;
  sha?: string;
  verdict?: ManifestSigned;
  kind?: "person" | "phone";
  at?: number;
  note?: string | null;
  cleared?: true;
}

/** What `POST /manifest/start` answers. */
export interface ManifestStartWrite {
  ok: boolean;
  error?: string;
  start?: { sha: string; at: number };
}
