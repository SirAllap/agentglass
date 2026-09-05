/*
 * The understudy: it watches, it guesses, it is scored, and — once a class has
 * earned it — it acts inside a bounded shift and can be wound back.
 *
 * Everything in this file exists to make one number honest — "how often would
 * it have done what he did" — and the whole design is downstream of the two
 * ways that number can be a lie.
 *
 * THE FIRST LIE is fitting the guess to the answer. If a prediction may be
 * written after the decision is already visible, the score measures nothing
 * except the order the code happened to run in. So the situation is HASHED AND
 * SEALED synchronously, before the user can answer it: `sealSituation` writes
 * its row and returns before the route it was called from does anything else.
 * A prediction that lands after his answer is kept anyway, with `late = 1`,
 * because dropping it would quietly select for the situations that were easy to
 * predict fast — the class would look sharp precisely where it was slow.
 *
 * THE SECOND LIE is a denominator full of things nobody agreed with. Only
 * `typed` and `clicked` provenance counts toward a class's `n`. An agent not
 * objecting is not the user agreeing, and an actual that arrives with no seal in
 * front of it is recorded with `unsealed = 1` rather than scored, because those
 * are the rows that flatter a score by pretending a trigger fired when it did
 * not. The unsealed count is the trigger-recall denominator, so it has to be
 * honest even though it is the number that makes us look worst.
 *
 * WHAT IS NOT HERE, and this is the part worth stating first. No request body,
 * no prompt, no keystroke, no free text. `subject` is an identifier — a pull
 * request number, a branch, a pane id — and `predicted`/`actual` are JSON of
 * CATEGORICAL decisions: which branch pattern, which cwd, which of the offered
 * findings were rejected. That is enough to score agreement and not enough to
 * reconstruct what he was working on, which is the trade the whole feature is
 * built around.
 *
 * WHY THE PRIVATE-TERMS GATE LIVES IN THIS FILE rather than at ingest: v1
 * ingests nothing at all, and `sealSituation` is the only path in the server
 * that ever writes raw screen text into an understudy table. Putting the gate
 * anywhere else would be putting it somewhere the text does not go. The gate
 * returns a term INDEX and never the term, so a failing test of it is safe to
 * paste into a public issue — which matters, because this repository is public
 * and the terms file it reads is exactly the list of things that must not
 * appear in it.
 *
 * NOTHING HERE ACTS. There is no writer that launches an agent, answers a gate,
 * merges anything or touches a card. `setMode` cannot lift a class above
 * `UNDERSTUDY_CEILING`, which is `shadow`, and being OFFERED a promotion is not
 * being promoted: a human presses, or nothing happens.
 *
 * EVERY WRITE IS GUARDED and every write swallows its own failure. The
 * understudy must never break the thing it is watching — the merge already
 * happened, and throwing after it is a worse outcome than a missing row — so
 * each writer is wrapped and each returns a falsy id rather than propagating.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { db } from "./db.ts";
import { repoRootOf } from "./git.ts";
import { extraSourceError } from "./understudy-sources.ts";
import { wilsonLower } from "../../shared/wilson.ts";
import type {
  UnderstudyClassRow,
  UnderstudyFrame,
  UnderstudyLock,
  UnderstudyMode,
  UnderstudyStance,
  UnderstudyReach,
  UnderstudyPosture,
} from "../../shared/types.ts";
import { STANCES, REACHES } from "../../shared/types.ts";

// ---------------------------------------------------------------------------
// The classes.

/** One class of decision, as the server knows it. */
export interface UnderstudyClass {
  /** `C1`…`C13`. Stable: it is the key every ledger row is filed under, so it
   *  outlives any renaming of the label beside it. */
  id: string;
  label: string;
  lock: UnderstudyLock;
  /**
   * The routes the class is seen at.
   *
   * Documentation, not a lookup table, and deliberately not exposed as
   * `classFor(route)`. Two classes share `/chat/send` — launching an agent (C7)
   * and handing an agent a reviewer's requested changes (C5) — so a route-to-
   * class map would have to guess, and it would guess wrong at exactly the
   * route that matters most. The call site knows which decision it is making
   * and names its class; this list is here so a person can find the call sites.
   */
  routes: readonly string[];
  /** What raises the class where it has no route of its own. Empty otherwise. */
  trigger: string;
}

/**
 * The thirteen.
 *
 * `lock` is why a class might never climb regardless of what it scores. C6
 * answers a permission prompt on somebody else's behalf, which stays in shadow
 * for the whole of v1 (`key`). C12 would edit somebody else's record of what
 * the work is, which stays in shadow for ever by decision rather than by score
 * (`sealed`). The distinction is kept in the data rather than in the panel's
 * head, because "this one is at 0.81 and still shadow" is the question the
 * scorecard will be asked most often and the answer has to sit next to the
 * number.
 */
export const CLASSES: readonly UnderstudyClass[] = [
  {
    id: "C1",
    label: "starting a worktree or a branch",
    lock: "earn",
    routes: ["/git/worktree-add", "/git/branch-create", "/git/checkout"],
    trigger: "",
  },
  {
    id: "C2",
    label: "a local commit, and the message on it",
    lock: "earn",
    routes: ["/git/commit-staged", "/git/commit", "/git/amend-staged", "/git/amend"],
    trigger: "",
  },
  {
    id: "C3",
    label: "landing on the integration branch, and the cleanup after",
    lock: "earn",
    routes: ["/git/merge", "/git/branch-delete", "/git/worktree-remove"],
    trigger: "",
  },
  {
    id: "C4",
    label: "triaging a bot review, and what gets a reply",
    lock: "earn",
    routes: ["/prs/reply", "/prs/comment-hide", "/prs/thread-resolved"],
    trigger: "",
  },
  {
    id: "C5",
    label: "applying what a reviewer asked for",
    lock: "earn",
    routes: ["/prs/review-with", "/prs/apply-suggestion", "/chat/send"],
    trigger: "",
  },
  {
    id: "C6",
    label: "answering an agent's permission prompt",
    lock: "key",
    routes: ["/gate/decide"],
    trigger: "",
  },
  {
    id: "C7",
    label: "launching an agent",
    lock: "earn",
    routes: ["/chat/send", "/chat/attach"],
    trigger: "",
  },
  {
    id: "C8",
    label: "updating a branch, and rerunning CI",
    lock: "earn",
    routes: ["/prs/update-branch", "/prs/rerun", "/prs/rerun-jobs"],
    trigger: "",
  },
  {
    id: "C9",
    label: "whether a pull request is ready to merge",
    lock: "earn",
    routes: ["/prs/merge", "/prs/draft", "/prs/close"],
    trigger: "",
  },
  {
    id: "C10",
    label: "a review verdict, and the comments under it",
    lock: "earn",
    routes: ["/prs/review", "/prs/line-comment", "/prs/comment"],
    trigger: "",
  },
  {
    id: "C11",
    label: "a pull request body, a scrum line, a worklog line",
    lock: "earn",
    routes: ["/prs/edit"],
    trigger: "",
  },
  {
    id: "C12",
    label: "a card's scope and its fields",
    lock: "sealed",
    routes: [],
    trigger: "a card opened in the tasks view",
  },
  {
    id: "C13",
    label: "what to work on next",
    lock: "earn",
    routes: [],
    trigger: "the workspace opening with nothing chosen",
  },
];

const BY_ID = new Map(CLASSES.map((c) => [c.id, c]));

/** The class, or null. Callers pass a literal `C7`; a typo must not become a
 *  fourteenth class with one row in it. */
export function classOf(id: string): UnderstudyClass | null {
  return BY_ID.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Thresholds.

/**
 * When a class may be OFFERED as guided.
 *
 * Three gates, and the third is the one that does the work. At n = 80 a raw
 * ratio of 0.70 is exactly 56 agreements, and 56 of 80 has a Wilson lower bound
 * of 0.5923 — under the floor. 57 of 80 is 0.6054, over it. That pair is the
 * entire argument for scoring against the bound rather than the ratio: the
 * ratio calls 56 and 57 the same claim, and they are not.
 *
 * Being offered is not being on. Nothing in this file promotes anything.
 */
export const OFFER_MIN_N = 80;
export const OFFER_MIN_RAW = 0.7;
export const OFFER_MIN_LB = 0.6;
/*
 * And it has to beat the dumbest possible rule by this much.
 *
 * The gate did not have this, and without it the three thresholds above can all
 * be cleared by a class with nothing in it to learn. C2 is the worked example
 * on real data: over 1,193 commits the model agrees 97% of the time, and
 * "always answer what you answered last time" agrees 98%. Every bar above is
 * comfortably cleared, and promoting it would hand somebody a constant wearing
 * a 97% badge.
 *
 * Ten points is not arbitrary — it is the criterion the backtest was
 * pre-registered against before any of this was measured, and the one C3 passed
 * with +32. Using the same number here means the panel promotes on the same
 * evidence the offline test accepts.
 */
export const OFFER_MIN_EDGE = 0.1;

/**
 * The rung no class may pass in v1, whatever it has earned.
 *
 * One constant, checked by `setMode`, so raising the ceiling later is a
 * deliberate edit in one place rather than the discovery that a setter never
 * had a limit in the first place.
 */
/*
 * `auto-undo`, and the ceiling stops there for a reason it can state.
 *
 * `auto` means acting with no way back. Everything the understudy may do is in
 * the bridge table and every entry there is reversible with its recipe written
 * out, so `auto` describes a thing this build cannot do — a ceiling above the
 * highest rung would be a promise nothing keeps.
 *
 * It sat at `shadow` for as long as nothing acted, which then made the LEDGER
 * wrong rather than safe: `mode` records the posture a row happened under, and
 * a fixed shadow meant every row claimed to have been taken while watching,
 * including the ones taken while acting. A record that cannot say what the
 * posture was is a record nobody can audit afterwards.
 */
export const UNDERSTUDY_CEILING: UnderstudyMode = "auto-undo";

const MODE_RANK: Record<UnderstudyMode, number> = { shadow: 0, guided: 1, "auto-undo": 2, auto: 3 };

/**
 * How long after a seal an actual may still attach to it.
 *
 * Thirty minutes is a working session's worth of slack: he opens a worktree,
 * gets interrupted, comes back and commits. Past that the seal is stale and the
 * honest record is a second row with `unsealed = 1`, not a match to a situation
 * that has moved on. Guessing wrong in that direction costs trigger recall,
 * which is visible; guessing wrong the other way inflates agreement, which is
 * not.
 */
export const ATTACH_WINDOW_MS = 30 * 60 * 1000;

/**
 * The one partition whose situation bodies are kept.
 *
 * This repository is public, so its text is already published and storing it
 * costs nothing that is not already on GitHub. Every other partition is by
 * definition somebody else's material, and a table of their screen text with a
 * ninety-day retention is precisely the second copy this feature promised not
 * to make. So: hash, class and subject for everyone, body for this one only.
 */
export const OPEN_PARTITION = "agentglass";

// ---------------------------------------------------------------------------
// On/off, and where the flag lives.

interface Store {
  enabled: boolean;
  /** Per-class mode, by class id. Absent means `shadow`. */
  modes: Record<string, UnderstudyMode>;
  /** How much initiative it takes. See UnderstudyStance. */
  stance: UnderstudyStance;
  /** What it may touch, whatever its stance. See UnderstudyReach. */
  reach: UnderstudyReach;
  /** Per-class brakes. Only ever HOLD A CLASS BACK — never lift one. */
  perClass: Record<string, UnderstudyStance>;
  /*
   * Where it may DRAFT an action. Reading is governed separately and always
   * was; this is only about proposals.
   *
   * `open-only` is the default and stays the default. It is not a judgement
   * about which of somebody's work matters — the bank learns from all of it —
   * it is that a proposal is a draft of a real request against a real
   * repository, and the first ones should land somewhere a mistake is cheap.
   * Widening it is a decision with consequences at work, so it is his to take
   * explicitly rather than one I quietly assume.
   */
  proposeScope?: "open-only" | "everywhere";
  /*
   * Which project is the OPEN one — the side it may draft and act in.
   *
   * A setting rather than a constant, and not for flexibility's sake. It was
   * hard-coded to this application's own name, which put the name of one
   * person's public project into logic in a public repository and defined
   * everything else as "not that". Both halves are facts about one machine and
   * neither belongs in source.
   *
   * Empty means "the checkout this server is running from" — right nearly
   * always, and it asks nobody to configure anything.
   */
  openProject?: string;
  /*
   * Whether it may ask a model when its own tables decline.
   *
   * Off by default and it stays off. Everything else in this feature runs on
   * this machine; this one sends a prompt somewhere. He uses that same channel
   * by hand all day, which is why it is the channel rather than some new
   * service with a new key — but him typing into it and this app doing so on
   * his behalf while he is away are different acts.
   */
  judge?: boolean;
  /** Which sources the user has said yes to being taught from. */
  allow: Record<string, boolean>;
  /** Places the user pointed it at by hand. */
  extra: { id: string; path: string; label?: string; kind?: "rules" | "precedents" }[];
  /**
   * The must-not-see list: substrings that veto a path or a line outright.
   *
   * A plain list of strings and not a clever matcher, because this is the one
   * setting where a person has to be able to predict the behaviour exactly. If
   * it appears in the path or in the text, that material is not read.
   */
  never: string[];
}

/* ────────────────────────────────────── posture ─────────────────────────── */



const rung = (x: UnderstudyStance): number => STANCES.indexOf(x);







/* ──────────────────────────────── consent and the never list ────────────── */

export function consent(): { allow: Record<string, boolean>; extra: Store["extra"]; never: string[] } {
  const st = load();
  return { allow: st.allow, extra: st.extra, never: st.never };
}

export function setAllowed(id: string, allowed: boolean): void {
  const st = load();
  save({ ...st, allow: { ...st.allow, [id]: allowed } });
}

/**
 * Register a path of the person's own as a source. Refused — thrown, with the
 * reason as the message — when `extraSourceError` says so: the reader behind
 * this opens every parseable file below the path, and the first version took
 * `~/.ssh`. A throw rather than a sentinel because the route's contract is
 * "an id, then allow it", and an id for something not registered would be
 * allowed into nothing while the panel said it worked.
 */
/** A path this app will not read, refused by rule. Its message is ours. */
export class SourceRefused extends Error {}

export function addExtraSource(path: string, label?: string, kind?: "rules" | "precedents"): string {
  const refused = extraSourceError(path);
  /* Its own type, so a route can tell "this path is not one we read" — a
     sentence written here, safe to show — from a filesystem or database error,
     whose text carries absolute paths and internals a caller has no business
     seeing. */
  if (refused) throw new SourceRefused(refused);
  const st = load();
  const id = `added:${sha256(path).slice(0, 12)}`;
  if (st.extra.some((e) => e.id === id)) return id;
  save({ ...st, extra: [...st.extra, { id, path, label, kind }] });
  return id;
}

export function removeExtraSource(id: string): void {
  const st = load();
  save({ ...st, extra: st.extra.filter((e) => e.id !== id), allow: { ...st.allow, [id]: false } });
}

/** Whether it may ask a model when counting is not enough. Off until asked. */
export function judgeEnabled(): boolean {
  return load().judge === true;
}

export function setJudge(on: boolean): boolean {
  const st = load();
  st.judge = on === true;
  save(st);
  return st.judge;
}

/*
 * The open project's name, and how a path is tested against it.
 *
 * DERIVED, NOT DECLARED, when nobody has set one: the checkout this server runs
 * from is the project it belongs to, which is true on every install and needs
 * no configuration. Setting it is for the case where somebody wants the loop
 * pointed somewhere else.
 *
 * THE CHECKOUT, NOT THE WORKING DIRECTORY. This read `process.cwd()` and took
 * its last segment, so the directory the process happened to be started in
 * decided the answer — and the documented way to start it is `cd server && bun
 * run start`, which made the open project `server`. Wrong in both directions at
 * once: the matcher below then opens on any path with a `server` segment in it,
 * which is most repositories on the machine, while `openProjectRepos` filters
 * the checkouts it actually found by that same name, matches none of them, and
 * the loop declines every task it is offered. Asking git for the repository
 * root gives the same answer from anywhere inside the checkout.
 *
 * The matcher is a segment test rather than a substring one. `foo` must not
 * match `foobar-private`, and `a/foo/b`, `a/foo-2`, and a path ending in `foo`
 * must all match — which is the difference between "the project and its
 * worktrees" and "anything with those letters in it".
 */

/*
 * Resolved once per working directory, because `repoRootOf` is a synchronous
 * `git rev-parse` and this is asked once per path while a transcript is banked.
 * One spawn the first time it is asked is the one-off probe the sync-spawn rule
 * allows for; one per banked line is the outage that rule exists to prevent.
 *
 * Only a resolved root is remembered. A failure is not an answer worth keeping —
 * git missing for a moment would otherwise fix the wrong name in place for the
 * life of the process.
 */
let openProjectRoot: { cwd: string; root: string } | null = null;

export function openProjectName(): string {
  const set = load().openProject?.trim();
  if (set) return set;
  /*
   * NOT `workspaceRoot()`, AND THE MEASUREMENT IS THE WHOLE ARGUMENT.
   *
   * That was the obvious fix — the root the app was launched with, set on
   * purpose, printed at startup as "Project →". Measured on this machine, it
   * returns the EMPLOYER'S repository, because the application is pointed at
   * the work being watched, and the fence would have taken its name from it.
   *
   * The fault this replaced opened the fence by accident. That one would have
   * aimed it.
   *
   * The app's scope is "what am I watching". The understudy's fence is "where
   * may something act on my behalf". They are different questions and the same
   * machine answers them differently, so the second may not be derived from
   * the first.
   *
   * What is left is the checkout this process is inside, which on an installed
   * server is nothing — and nothing is the right answer. The fence has an
   * explicit setting and a control on the Work tab; a fence worth trusting is
   * one somebody pointed, not one that guessed.
   */
  const cwd = process.cwd();
  if (openProjectRoot?.cwd !== cwd) {
    const root = repoRootOf(cwd);
    openProjectRoot = root ? { cwd, root } : null;
  }
  /*
   * NOT A REPOSITORY: NOTHING IS OPEN. It fails CLOSED, and it did not.
   *
   * The fallback was the working directory's last segment. The installed
   * server runs with cwd `/home/you` — the home directory, not a git
   * checkout — so the open project became `you`, and the matcher below,
   * which is deliberately a segment test, matched `/home/you/anything`.
   * Every repository on the machine was inside the fence, including his
   * employer's, which is the one thing this must never do.
   *
   * Measured on the running server rather than reasoned about: the fence
   * listed thirty checkouts of somebody's work.
   *
   * A fence that does not know where it is has exactly one safe answer, and it
   * is not a guess. Empty here means `openProjectRepos` finds nothing and the
   * loop declines every task — visibly, on the Work tab, in red.
   */
  if (!openProjectRoot?.root) return "";

  const here = openProjectRoot.root.split("/").filter(Boolean);
  const name = (here[here.length - 1] ?? "").split("-")[0] ?? "";

  /*
   * And a name that would match the home directory is refused for the same
   * reason. `repoRootOf` answering with a repository at or above $HOME — a
   * dotfiles checkout, which is a normal thing to have — puts the whole disk
   * inside the fence by a different route than the one above.
   */
  return name && !wouldMatchEverything(name) ? name : "";
}

/**
 * Names that would put the whole machine inside the fence.
 *
 * `isOpenProjectPath` is a SEGMENT test — `orbit` matches `orbit`,
 * `orbit-feature` and `orbit/server` — which is what makes it useful and what
 * makes a bad name catastrophic. Any segment of the path every repository
 * lives under matches every repository: `you`, `code`, `home`.
 *
 * Measured before writing this: each of those three made
 * `isOpenProjectPath("/home/you/code/…")` true for an unrelated project.
 *
 * The derived name already refused them. The EXPLICIT setting did not, and the
 * explicit setting is the one that wins — so the only path with a check was
 * the one that could not be reached while the other was set.
 */
function wouldMatchEverything(name: string, checkouts: string[] = []): boolean {
  const n = name.toLowerCase();
  if (!n) return false;                       // empty is "nothing open", which is safe

  /*
   * A NAME, NEVER A PATH — and this one holds without a checkout list.
   *
   * Every test below needs to know where projects live on this machine, so
   * with an empty list they all pass and `"/"` was accepted: measured, reading
   * a hand-written store back gave a fence that matched every absolute path on
   * the disk. `isOpenProjectPath` compares SEGMENTS, so a value with a
   * separator in it is not a project name at all — whatever the caller knows
   * about the machine.
   */
  if (n.includes("/") || n.includes("\\") || n === "." || n === "..") return true;

  /*
   * Every segment of a directory that CONTAINS projects, not just of $HOME.
   *
   * The first version tested `$HOME` alone and let `code` through — which is
   * not a segment of `/home/you`, and is the folder every repository on
   * this machine sits in. Measured: with `code` set,
   * `isOpenProjectPath("/home/you/code/…")` was true for every project.
   *
   * So the set is $HOME plus the PARENT of each known checkout: those are
   * exactly the names that describe "where projects live" rather than a
   * project. A checkout's own last segment is not in it, which is what keeps
   * the real answers working.
   */
  const banned = new Set<string>();
  for (const seg of (process.env.HOME ?? "").toLowerCase().split("/")) if (seg) banned.add(seg);
  for (const c of checkouts) {
    const parts = c.toLowerCase().split("/").filter(Boolean);
    // Everything above the checkout itself.
    for (const seg of parts.slice(0, -1)) banned.add(seg);
  }
  /*
   * AND THE FOLDER PROJECTS LIVE IN, EVEN ON A DATABASE THAT KNOWS NOTHING.
   *
   * Every test above needs a list of checkouts to work from, and that list
   * comes from the transcript table — which is empty on a fresh install, after
   * a reset, or simply before the first scan. On such a machine
   * `setOpenProject("code")` was accepted, and `code` is a segment of every
   * repository path here: the fence would have admitted somebody's employer's
   * checkout sitting two directories away.
   *
   * `$HOME/code` and its usual siblings are not project names on any machine,
   * so they are refused without needing to be discovered. A real project called
   * `src` is a price worth paying against a fence that opens by accident.
   */
  for (const seg of ["code", "src", "repos", "projects", "work", "dev", "git", "workspace", "tmp"]) banned.add(seg);
  return banned.has(n);
}

/**
 * Point the fence at a project, or refuse.
 *
 * Returns the name in force afterwards, which is the OLD one when the new one
 * was refused — a caller that assumes its value took hold would otherwise
 * report a fence it does not have.
 */
export function setOpenProject(name: string, checkouts: string[] = []): string {
  const want = name.trim().slice(0, 100);
  if (wouldMatchEverything(want, checkouts)) return openProjectName();
  const st = load();
  st.openProject = want;
  save(st);
  return openProjectName();
}

/**
 * WHY IT HAS NOWHERE TO WORK, in the words of whatever is actually wrong.
 *
 * The banner said "It has nowhere to work, so it will decline every task" and
 * stopped there. Measured this morning the answer was: the app had been
 * relaunched by its own installer, so the server process started outside any
 * checkout, and discovery — which is telemetry, work done THROUGH the app —
 * had never seen the project either, because it is worked from a terminal.
 * Nothing on the screen said so, and the one control offered ("Pick a
 * checkout") was built from that same empty discovery, so the way out was not
 * in the application at all.
 *
 * Pure, and takes the three facts the caller already has, so the sentence can
 * be settled without a filesystem: the fence, the checkout the server runs
 * from, and the projects this machine has opened.
 *
 * Null when the setup itself is fine — the caller only asks once the allowed
 * list came back empty, and null there means the fence named something real
 * that then failed `isOpenProjectPath`, which is the fence doing its job and
 * not a fault to print.
 */
export function nowhereReason(s: {
  /** The fence, as `openProjectName()` returns it. */
  project: string;
  /** The checkout the server process runs from, or null when it is not in one. */
  here: string | null;
  /** The projects this machine has opened, as paths. */
  known: string[];
}): { why: string; fix: string } | null {
  const project = s.project.trim();
  if (!project) {
    return {
      why: "No project is named, so nothing is inside the fence.",
      fix: "Name the project it may work in.",
    };
  }

  /* Neither route found anything: not the checkout the server runs from, not a
     project somebody has opened here. This is the morning that prompted the
     line, and it is the only one whose fix is outside this screen. */
  const candidates = [...(s.here ? [s.here] : []), ...s.known];
  if (candidates.length === 0) {
    return {
      why: "The server was started outside a git checkout and no project has been opened in this app, so discovery had nowhere to look.",
      fix: `Open ${project} in this app, or start the server from inside the checkout.`,
    };
  }

  /* Something was found — it is simply not called what the fence says. The
     names are printed because a bare text field with no list of what is valid
     is the complaint the project list was added for. */
  const leaves = candidates.map((p) => p.split("/").filter(Boolean).pop() ?? "").filter(Boolean);
  if (!leaves.some((leaf) => project === leaf || project.startsWith(`${leaf}-`))) {
    const seen = Array.from(new Set(leaves)).slice(0, 6);
    return {
      why: `Nothing on this machine is called "${project}". It has: ${seen.join(", ")}.`,
      fix: "Name one of those instead.",
    };
  }

  return null;
}

/** Whether a name is one this will accept, so a route can say why it did not. */
export function openProjectNameAllowed(name: string, checkouts: string[] = []): boolean {
  return !wouldMatchEverything(name.trim().slice(0, 100), checkouts);
}

/** Is this path part of the open project, or one of its worktrees? */
export function isOpenProjectPath(path: string): boolean {
  const name = openProjectName();
  if (!name) return false;
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[/-])${safe}([/-]|$)`, "i").test(path);
}

/** Where it may draft actions. Defaults closed, and stays closed until asked. */
export function proposeScope(): "open-only" | "everywhere" {
  return load().proposeScope === "everywhere" ? "everywhere" : "open-only";
}

export function setProposeScope(scope: "open-only" | "everywhere"): "open-only" | "everywhere" {
  const st = load();
  st.proposeScope = scope === "everywhere" ? "everywhere" : "open-only";
  save(st);
  return st.proposeScope;
}

export function setNever(list: string[]): string[] {
  const st = load();
  const clean = Array.from(new Set(list.map((x) => x.trim()).filter(Boolean))).slice(0, 200);
  save({ ...st, never: clean });
  return clean;
}

/**
 * Does this path or text hit the must-not-see list.
 *
 * Case-insensitive substring, and deliberately nothing cleverer. A person has
 * to be able to predict this one exactly: they typed a word, and anything with
 * that word in it is not read. A regex would be more powerful and would make
 * the answer to "will it read my bank folder" a thing you have to reason about.
 */
export function isForbidden(s: string): boolean {
  const never = load().never;
  if (!never.length) return false;
  const hay = s.toLowerCase();
  return never.some((n) => hay.includes(n.toLowerCase()));
}

/** Test seam, so a suite never reads or writes his own setting. */
let storeOverride: string | null = null;
export function __setUnderstudyStorePath(p: string | null): void {
  storeOverride = p;
  cache = undefined;
}

const storePath = (): string =>
  storeOverride ??
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentglass", "understudy.json");

let cache: Store | undefined;

function load(): Store {
  if (cache) return cache;
  let s: Store = { enabled: false, modes: {}, stance: "watching", reach: "draft", perClass: {}, allow: {}, extra: [], never: [] };
  try {
    const p = storePath();
    if (existsSync(p)) s = { ...s, ...(JSON.parse(readFileSync(p, "utf8")) as Partial<Store>) };
  } catch {
    // A malformed file means OFF, which is the same as the default and is the
    // only safe direction for a file that decides whether we record anything.
  }
  /*
   * EVERY FIELD, or the ones left out are erased at the next write.
   *
   * This literal rebuilt the cache from eight keys and `Store` has eleven, so
   * `openProject`, `judge` and `proposeScope` were read off disk into `s` and
   * dropped here — and `save(cache)` then wrote the truncated object back. The
   * effect is not "it forgets on restart": it is that a person's choice is
   * erased from the file by the first unrelated setting write after it.
   *
   * Measured this morning: the deputy had nowhere to work, its fence read
   * `0 checkouts`, and picking a checkout in the UI did not survive a relaunch.
   * This machine relaunches a dozen times a day.
   *
   * Every one of the three is a decision a person made deliberately — where it
   * may act, whether it may ask a model, how wide it may propose — which is
   * exactly the kind of thing a normaliser must not quietly drop.
   */
  cache = {
    enabled: s.enabled === true,
    modes: s.modes && typeof s.modes === "object" ? s.modes : {},
    stance: STANCES.includes(s.stance as UnderstudyStance) ? (s.stance as UnderstudyStance) : "watching",
    reach: REACHES.includes(s.reach as UnderstudyReach) ? (s.reach as UnderstudyReach) : "draft",
    perClass: s.perClass && typeof s.perClass === "object" ? s.perClass : {},
    allow: s.allow && typeof s.allow === "object" ? s.allow : {},
    extra: Array.isArray(s.extra) ? s.extra : [],
    never: Array.isArray(s.never) ? s.never : [],
    /*
     * And the stored fence name is re-checked ON THE WAY IN, not only when it
     * is set. A name written before `wouldMatchEverything` existed, or edited
     * into the file by hand, would otherwise be trusted for ever — and the one
     * thing this fence must never do is match every repository on the machine.
     * Refused reads as "nothing open", which is the closed direction.
     */
    openProject: typeof s.openProject === "string" && !wouldMatchEverything(s.openProject.trim().slice(0, 100), [])
      ? s.openProject.trim().slice(0, 100)
      : undefined,
    judge: s.judge === true,
    proposeScope: s.proposeScope === "everywhere" ? "everywhere" : "open-only",
  };
  return cache;
}

function save(s: Store): void {
  cache = s;
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(s, null, 2) + "\n");
  } catch {
    // It holds for this process and will not survive a restart. Failing the
    // caller over a preference file would be worse than losing the preference.
  }
}

/**
 * Something stopped it, as opposed to somebody switching it off.
 *
 * Deliberately not the same fact as `enabled`. `enabled` is a preference the
 * user expressed; `halted` is a state the process got into. A view showing an
 * empty scorecard has to be able to say which of the two it is looking at, and
 * a single boolean cannot.
 */
let halted = false;

/**
 * Whether the understudy is recording at all. Default OFF.
 *
 * `AGENTGLASS_UNDERSTUDY=0` is a kill switch and wins over the stored flag in
 * one direction only: it can force off, it can never force on. A switch that
 * could turn a watcher on from the environment would mean an install could
 * start recording because of a variable inherited from a shell, and the one
 * property this feature has to be able to promise is that it is off unless
 * somebody said otherwise in a file they can read.
 */
export function enabled(): boolean {
  if (process.env.AGENTGLASS_UNDERSTUDY === "0") return false;
  return load().enabled;
}

/**
 * Turn it on or off, and persist that.
 *
 * Switching it back ON also clears a halt. That is the deliberate act — a halt
 * is a fence somebody or something raised, and the way through a fence is to
 * say so explicitly rather than to have it quietly expire on a timer.
 */
export function setEnabled(b: boolean): void {
  const s = load();
  save({ ...s, enabled: b === true });
  if (b) halted = false;
}

/** Is the process actually writing rows right now. */
function recording(): boolean {
  return enabled() && !halted;
}


// ---------------------------------------------------------------------------
// Hashing, and canonical categorical values.

/** sha256, hex. The seal's identity and nothing else — it is never reversed,
 *  never compared against anything but another hash of the same shape. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The hash a seal is filed under.
 *
 * Class, subject, repo and partition go in alongside the body, so two different
 * classes looking at the same screen do not collide onto one snapshot row and
 * then disagree about what it was evidence of. `JSON.stringify` of the array
 * does the separating: it cannot be fooled by a body that contains whatever
 * character we picked as a delimiter, which a joined string can.
 */
export function situationHash(
  cls: string,
  s: { subject: string; repo: string; partition: string; body: string },
): string {
  return sha256(JSON.stringify([cls, s.subject, s.repo, s.partition, s.body]));
}

/**
 * A categorical value, written the same way every time.
 *
 * Object keys are sorted, so `{a:1,b:2}` and `{b:2,a:1}` are one decision
 * rather than two. Agreement is then string equality, which is the comparison
 * that cannot drift: a hand-written deep-equal would eventually disagree with
 * whatever the panel does, and the disagreement would read as a scoring bug
 * rather than as two comparisons.
 */
function canon(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// The private-terms gate.

/** Test seam. Same reason as the store: never the user's own file. */
let termsOverride: string | null = null;
export function __setPrivateTermsPath(p: string | null): void {
  termsOverride = p;
  termCache = undefined;
}
/** Test seam: the override in force, so a suite can put back what it found. */
export function __privateTermsPath(): string | null { return termsOverride; }

/**
 * Where the list lives. `AGENTGLASS_PRIVATE_TERMS` names it outright; otherwise
 * it is `private-terms.txt` beside the app's own config. A list at
 * `~/.config/git/private-terms.txt` is honoured when the app's own is absent,
 * because a git pre-commit hook that blocks the same names is the usual reason
 * a person already has such a file, and one list is better than two.
 */
const termsPath = (): string => {
  if (termsOverride) return termsOverride;
  const env = (process.env.AGENTGLASS_PRIVATE_TERMS || "").trim();
  if (env) return env;
  const cfg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const own = join(cfg, "agentglass", "private-terms.txt");
  if (existsSync(own)) return own;
  const git = join(cfg, "git", "private-terms.txt");
  return existsSync(git) ? git : own;
};

interface Term {
  re: RegExp;
  /** Zero-based line in the terms file. A person can open the file at that line
   *  and see for themselves; nothing here ever has to name the term. */
  index: number;
}

let termCache: Term[] | undefined;

/**
 * The terms, compiled once.
 *
 * The file is a list of extended regexes, one per line, `#` for a comment —
 * the same file a git pre-commit hook reads, which is why it is read from
 * where git keeps it rather than copied into this app's own config.
 *
 * ERE is not quite JavaScript's dialect: a POSIX class like the alpha bracket
 * form compiles under `grep -E` and throws here. A line we cannot compile is a
 * term we promised to catch and silently would not, which is the worst
 * available outcome for this particular file, so the fallback is to match the
 * line LITERALLY rather than to drop it. That catches the common case — most
 * lines are a plain name with at most a word-boundary anchor — and where it
 * does not, it is still strictly more coverage than skipping the line.
 */
function terms(): Term[] {
  if (termCache) return termCache;
  const out: Term[] = [];
  try {
    const text = readFileSync(termsPath(), "utf8");
    text.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      try {
        out.push({ re: new RegExp(line, "gi"), index: i });
      } catch {
        try {
          out.push({ re: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), index: i });
        } catch {
          // Unreachable in practice: an escaped literal always compiles.
        }
      }
    });
  } catch {
    // No file. Nothing has been declared private on this machine, so nothing is.
  }
  termCache = out;
  return out;
}

/**
 * Does this text carry something that must never be written down.
 *
 * Returns the INDEX of the first term that matched and nothing else — not the
 * term, not the matched text, not an excerpt. That is the whole point of the
 * shape: a test of this function, a quarantine row written by it, and a stack
 * trace containing it are all safe to paste in public, which is what makes the
 * gate usable in a repository that is itself public.
 */
/**
 * Is the terms list actually loaded, and how many terms are in it.
 *
 * This exists because of a bug found by running the ingest for the first time:
 * `privateTermsGate` returned null both when nothing matched AND when the
 * terms file could not be found, and those are opposite answers. With
 * XDG_CONFIG_HOME pointed somewhere else the list silently became empty, the
 * gate approved every window, and a hundred and twenty-seven private terms
 * were written into a compiled policy file.
 *
 * A privacy control that cannot find its list must not report "nothing
 * forbidden". It reports that it does not know, and the caller decides — which
 * for anything that READS A CORPUS means refusing to start.
 */
export function termsStatus(): { ok: boolean; count: number; path: string } {
  const path = termsPath();
  const count = terms().length;
  return { ok: count > 0, count, path };
}

export function privateTermsGate(text: string): { termIndex: number } | null {
  if (!text) return null;
  for (const t of terms()) {
    t.re.lastIndex = 0;
    if (t.re.test(text)) return { termIndex: t.index };
  }
  return null;
}

/**
 * The same text with every private term replaced by its index.
 *
 * Used where a field cannot simply be dropped because it is the key rows are
 * filed under — `subject` is how an actual finds its seal — so it is scrubbed
 * instead. Scrubbing is deterministic, so a seal and the decision that attaches
 * to it half an hour later still produce the same string and still join.
 *
 * The replacement carries the index rather than a flat marker so that two
 * different private things in one branch name stay two different things, and so
 * he can look up which line of his own file matched without this app ever
 * having held the answer.
 */
export function translate(text: string): string {
  if (!text) return text;
  let out = text;
  for (const t of terms()) {
    t.re.lastIndex = 0;
    out = out.replace(t.re, `[private:${t.index}]`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ledger.

/** One row, as it is stored. Column names, not camel case, because that is what
 *  comes back out of sqlite and renaming them here would be one more place for
 *  the two to drift. */
export interface UnderstudyLedgerRow {
  id: number;
  kind: string;
  class: string;
  route: string;
  method: string;
  subject: string;
  repo: string;
  partition: string;
  actor: string;
  provenance: string;
  sealed_at: number;
  situation_hash: string;
  predicted: string | null;
  predicted_at: number | null;
  late: number;
  actual: string | null;
  actual_at: number | null;
  unsealed: number;
  verdict: string | null;
  mode: string;
  status: number | null;
  tokens: number;
}

const stubInsert = db.query(
  `INSERT INTO understudy_ledger (kind, route, method, actor, sealed_at)
   VALUES ('stub', $route, $method, $actor, $at)`,
);

const sealInsert = db.query(
  `INSERT INTO understudy_ledger
     (kind, class, subject, repo, partition, sealed_at, situation_hash, mode)
   VALUES ('decision', $class, $subject, $repo, $partition, $at, $hash, $mode)`,
);

const unsealedInsert = db.query(
  `INSERT INTO understudy_ledger
     (kind, class, subject, repo, partition, provenance, sealed_at, actual, actual_at, unsealed, verdict, mode)
   VALUES ('decision', $class, $subject, $repo, $partition, $provenance, $at, $actual, $at, 1, 'unscored', $mode)`,
);

const fenceInsert = db.query(
  `INSERT INTO understudy_ledger (kind, route, method, actor, sealed_at)
   VALUES ('fence', $route, $method, 'understudy', $at)`,
);

const snapshotInsert = db.query(
  `INSERT OR REPLACE INTO understudy_snapshots (hash, at, repo, partition, body)
   VALUES ($hash, $at, $repo, $partition, $body)`,
);

const quarantineInsert = db.query(
  // `$termIndex`, not `$term`. The value is a POSITION in the term list and
  // never the term, which is the entire reason this table is defensible — and
  // a binding named `$term` invites the day somebody passes the string.
  `INSERT INTO understudy_quarantine (source_ref, class, term_index, at)
   VALUES ($ref, $class, $termIndex, $at)`,
);

/**
 * How much has ever been refused for holding a private term.
 *
 * The table recorded it and NOTHING READ IT. Meanwhile the Teach tab showed
 * "refused 0" — a different number, counted in memory during the last read and
 * thrown away after it — so a machine with eight refusals on record displayed a
 * zero.
 *
 * Wrong in the dangerous direction. That figure is the only evidence the
 * privacy gate has ever had to act, and a zero reads as "this has never needed
 * to stop anything", which is the opposite of what eight rows mean.
 *
 * The row holds a hash and a term INDEX, never the term: a table of the exact
 * strings we promised not to keep would be the worst possible shape for the
 * table whose whole purpose is that promise.
 */
export function quarantinedEver(): number {
  try {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM understudy_quarantine").get()?.n ?? 0;
  } catch {
    return 0;
  }
}

const rowById = db.query<UnderstudyLedgerRow, [number]>(
  `SELECT * FROM understudy_ledger WHERE id = ?`,
);

/**
 * One row by id — and the `__` says what it is for now.
 *
 * It answered `/understudy/why`, which was removed with the screen that called
 * it: the Ledger tab showed the predictor's rows and nothing else, and every
 * row was one class saying it had agreed with him. What is left is ten uses
 * across two test files, both asking the question this exists for — what did
 * the seal ACTUALLY record — including the one that checks a private term
 * never reaches the table.
 *
 * The prefix is this repository's convention for "exists for a test", and it
 * is honest about the state rather than hiding it behind an exemption list.
 * Give it a caller again and the name should lose the underscores.
 */
export function __ledgerRow(id: number): UnderstudyLedgerRow | null {
  if (!id) return null;
  try {
    return rowById.get(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The universal net: something wrote, here is the row.
 *
 * NO BODY, and the signature is the enforcement — there is no parameter a
 * request body could be passed through, so no future call site can add one
 * without changing this line and being asked why. Route, method, actor and the
 * status it eventually answered with is the whole of it, and it is enough to
 * answer "did a write happen that no class was watching", which is the question
 * the per-class seams cannot answer about themselves.
 *
 * Returns the row id, or 0 when the understudy is not recording. A 0 is a safe
 * thing to hand to `settleLedger`, which is why it is 0 and not null: the call
 * site should not have to branch.
 */
export function openStub(w: { route: string; method: string; actor: string }): number {
  if (!recording()) return 0;
  try {
    return Number(
      stubInsert.run({
        $route: w.route,
        $method: w.method,
        $actor: w.actor,
        $at: Date.now(),
      } as any).lastInsertRowid,
    );
  } catch {
    return 0;
  }
}

/**
 * How a stub answered. First answer wins.
 *
 * The `status IS NULL` in the UPDATE is the whole of the "first wins" rule, and
 * it is there because a route can answer more than once in the presence of a
 * retry or an error path that falls through to a generic handler. The first
 * status is the one that describes what the caller saw; a later 500 from a
 * cleanup path would overwrite the 200 that actually happened.
 *
 * A NULL status that stays NULL means the route answered outside the `json()`
 * helper, which is worth being able to see rather than worth guessing at.
 */
export function settleLedger(id: number, status: number): void {
  if (!id) return;
  try {
    db.run(`UPDATE understudy_ledger SET status = ? WHERE id = ? AND status IS NULL`, [status, id]);
  } catch {
    // The request already answered. Losing its status is the lesser harm.
  }
}

/**
 * Hash the situation and write it down, before anybody can answer it.
 *
 * Synchronous on purpose and top to bottom: by the time this returns, the row
 * exists with its `sealed_at`, so any prediction and any actual that follow can
 * be ordered against it. Nothing here awaits, nothing here schedules, and no
 * part of it is allowed to become a queue — a sealed situation that is written
 * "soon" is not sealed.
 *
 * The body is kept only for the open partition (see OPEN_PARTITION). For every
 * other partition the row keeps hash, class and subject and the body is dropped
 * on the floor, with a quarantine row recording THAT it was dropped and why —
 * never the text, never the term. `term_index` is -1 there, which is the
 * column's documented way of saying the refusal was not a term match at all.
 *
 * `subject` and `repo` are translated rather than dropped, because they are how
 * a later actual finds this row. You cannot drop the key you file under, so it
 * is scrubbed instead, and scrubbing is deterministic so the join survives it.
 *
 * `at` exists so a caller with a real event time can pass it. It must never be
 * taken from a request body: a caller who can choose a seal time can choose to
 * seal after the fact, which is the one thing this function exists to prevent.
 */
export function sealSituation(
  cls: string,
  s: { subject: string; repo?: string; partition?: string; body: string; at?: number },
): number {
  if (!recording()) return 0;
  const def = classOf(cls);
  if (!def) return 0;

  const at = s.at ?? Date.now();
  const partition = s.partition || "global";
  const subject = translate(s.subject || "");
  const repo = translate(s.repo || "");
  const hash = situationHash(cls, { subject, repo, partition, body: s.body || "" });

  try {
    const id = Number(
      sealInsert.run({
        $class: cls,
        $subject: subject,
        $repo: repo,
        $partition: partition,
        $at: at,
        $hash: hash,
        $mode: effectiveMode(def),
      } as any).lastInsertRowid,
    );

    // The gate runs on the way in, not on the way out. There is no path where
    // the body is written first and cleaned up afterwards, because a cleanup
    // that fails leaves the thing we promised never to store on disk.
    const hit = privateTermsGate(s.body || "");
    if (hit) {
      quarantineInsert.run({ $ref: hash, $class: cls, $termIndex: hit.termIndex, $at: at } as any);
    } else if (partition !== OPEN_PARTITION) {
      quarantineInsert.run({ $ref: hash, $class: cls, $termIndex: -1, $at: at } as any);
    } else {
      snapshotInsert.run({ $hash: hash, $at: at, $repo: repo, $partition: partition, $body: s.body || "" } as any);
    }
    return id;
  } catch {
    return 0;
  }
}

/**
 * What the understudy thinks he will do.
 *
 * `late` is set here, by comparing against the actual that may already be on
 * the row: a prediction that arrives after the answer is already recorded is
 * marked and KEPT. It was the original bug to drop those, and the reason it
 * looked reasonable at the time is that a late prediction is worthless as a
 * prediction. It is not worthless as a measurement — a class that is only ever
 * late on the hard situations scores beautifully on the easy ones, and the
 * `late` count is the only place that shows up.
 *
 * If the actual is already there, the verdict is computed now. That is the
 * whole of what "kept" buys us: a late row is scored like any other.
 */
export function recordPrediction(id: number, predicted: unknown, at = Date.now()): void {
  if (!recording() || !id) return;
  try {
    const row = rowById.get(id);
    if (!row) return;
    const value = translate(canon(predicted));
    const late = row.actual_at !== null && row.actual_at < at ? 1 : 0;
    const verdict = row.actual === null ? null : value === row.actual ? "agree" : "differ";
    db.run(
      `UPDATE understudy_ledger SET predicted = ?, predicted_at = ?, late = ?, verdict = COALESCE(?, verdict) WHERE id = ?`,
      [value, at, late, verdict, id],
    );
  } catch {
    // Losing a prediction costs us a scored row. Throwing costs the user the
    // route that was about to answer them.
  }
}

const openSeal = db.query<UnderstudyLedgerRow, [string, string, number]>(
  `SELECT * FROM understudy_ledger
    WHERE kind = 'decision' AND class = ? AND subject = ? AND actual_at IS NULL AND sealed_at >= ?
    ORDER BY sealed_at DESC, id DESC LIMIT 1`,
);

/**
 * What he actually did.
 *
 * Attaches to the newest seal for this (class, subject) inside the attach
 * window, and otherwise opens its own row with `unsealed = 1`. The second half
 * is the part that has to be right: an actual with no seal in front of it is a
 * trigger that did not fire, and quietly discarding it would remove the only
 * evidence that the seams are missing decisions. It is the denominator of
 * trigger recall, so it is counted even though it is the number that makes the
 * feature look worst.
 *
 * A row opened this way is never scored — there was no prediction and there
 * could not have been one — so its verdict is `unscored` and it stays out of
 * both `n` and `hits`.
 */
export function recordDecision(
  cls: string,
  s: {
    subject: string;
    repo?: string;
    partition?: string;
    actual: unknown;
    provenance: string;
    at?: number;
  },
): number {
  if (!recording()) return 0;
  const def = classOf(cls);
  if (!def) return 0;

  const at = s.at ?? Date.now();
  const subject = translate(s.subject || "");
  const value = translate(canon(s.actual));

  try {
    const seal = openSeal.get(cls, subject, at - ATTACH_WINDOW_MS);
    if (seal) {
      const verdict = seal.predicted === null ? "unscored" : value === seal.predicted ? "agree" : "differ";
      db.run(
        `UPDATE understudy_ledger SET actual = ?, actual_at = ?, provenance = ?, verdict = ? WHERE id = ?`,
        [value, at, s.provenance || "", verdict, seal.id],
      );
      return seal.id;
    }
    return Number(
      unsealedInsert.run({
        $class: cls,
        $subject: subject,
        $repo: translate(s.repo || ""),
        $partition: s.partition || "global",
        $provenance: s.provenance || "",
        $at: at,
        $actual: value,
        $mode: effectiveMode(def),
      } as any).lastInsertRowid,
    );
  } catch {
    return 0;
  }
}

/**
 * A refusal, kept.
 *
 * The understudy principal is narrowed by an allowlist in auth.ts, and a 403
 * for it means something asked this feature to do a thing the design says it
 * never does. That is exactly the row worth having for ever, which is why a
 * fence is `kind = 'fence'` and outlives the ninety-day stub sweep.
 *
 * It is still guarded by `recording()`. "Off" has to mean no rows at all or it
 * is not a promise anybody can check by looking at the tables — and a 403 while
 * the feature is off is already visible where it was refused.
 */
/* ────────────────────────────────── the precedent bank ─────────────────── */

/*
 * Which of the thirteen a piece of text is about.
 *
 * It lives here, in the core, because there were briefly two copies of it — one
 * in the ingest that decides which drawer a row is filed in, one in `ask` that
 * decides which drawer a question opens. Two copies of thirteen regexes drift,
 * and when they drift a question retrieves confidently out of the wrong drawer,
 * which reads as a bad answer rather than as a bug. A test could have watched
 * them for equality; one table cannot be unequal to itself.
 */
export const CLASS_WORDS: [string, RegExp][] = [
  ["C1", /\b(worktree|branch|rama|checkout)\b/i],
  ["C2", /\b(commit|mensaje|message|stage)\b/i],
  ["C3", /\b(merge|rebase|land|integrat|cleanup|borrar la rama)\b/i],
  ["C4", /\b(bot|review|approve|lgtm|nit)\b/i],
  ["C5", /\b(test|suite|red|green|fail)\b/i],
  ["C6", /\b(gate|permission|allow|deny|permiso)\b/i],
  ["C7", /\b(install|instal|build|deploy|reinstall)\b/i],
  ["C8", /\b(agent|subagent|worker|fan.?out)\b/i],
  ["C9", /\b(halt|stop|abort|para|kill)\b/i],
  ["C10", /\b(review|lgtm|approve|verdict|comment)\b/i],
  ["C11", /\b(pr body|scrum|worklog|gherkin|testing criteria|daily)\b/i],
  ["C12", /\b(clickup|card|sprint|squad|scope)\b/i],
  ["C13", /\b(next|priority|what to work|triage)\b/i],
];

/** The class a piece of text belongs to, or `general` when none of them claim it. */
export function classify(text: string): string {
  for (const [cls, re] of CLASS_WORDS) if (re.test(text)) return cls;
  return "general";
}

export interface PrecedentIn {
  cls: string;
  partition: string;
  repo?: string;
  /** What was going on, in the fewest words that still identify the case. */
  situation: string;
  /** What he did about it. Categorical where possible. */
  decision: string;
  /** His own words, capped — the part a prediction can quote back. */
  hisWords?: string;
  alternatives?: string;
  outcome?: string;
  /** Which source this came out of, and its stable id inside that source. */
  source: string;
  sourceRef: string;
  provenance?: string;
  at: number;
  weight?: number;
}

const insertPrecedent = db.query<{ id: number }, [
  string, string, string, string, string, string, string, string, string, string, string, number, number
]>(
  `INSERT INTO understudy_precedents
     (class, partition, repo, situation, decision, his_words, alternatives, outcome,
      source, source_ref, provenance, at, weight)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(source, source_ref, class) DO UPDATE SET
     situation = excluded.situation, decision = excluded.decision,
     his_words = excluded.his_words, at = excluded.at, weight = excluded.weight
   RETURNING id`,
);

const insertPrecedentFts = db.query<never, [number, string, string, string, string, string, string]>(
  `INSERT INTO understudy_precedents_fts (rowid, class, repo, situation, decision, his_words, source_ref)
   VALUES (?,?,?,?,?,?,?)`,
);
const dropPrecedentFts = db.query<never, [number, string, string, string, string, string, string]>(
  `INSERT INTO understudy_precedents_fts (understudy_precedents_fts, rowid, class, repo, situation, decision, his_words, source_ref)
   VALUES ('delete', ?,?,?,?,?,?,?)`,
);
const precedentById = db.query<
  { id: number; class: string; repo: string; situation: string; decision: string; his_words: string; source_ref: string },
  [number]
>(`SELECT id, class, repo, situation, decision, his_words, source_ref FROM understudy_precedents WHERE id = ?`);

/**
 * Bank one precedent, and keep the full-text index in step BY HAND.
 *
 * There is not one trigger in server/src and this does not introduce the first.
 * fts5 does not synchronise an external-content table on its own, so the delete
 * of the old row and the insert of the new one are written out here — and the
 * delete has to carry the OLD column values, which is why it reads the row back
 * before overwriting it. Getting that wrong does not throw; it corrupts the
 * index quietly and retrieval starts returning rows that no longer say what the
 * index thinks they say.
 */
export function addPrecedent(p: PrecedentIn): number {
  if (!p.cls || !p.source || !p.sourceRef) return 0;
  const words = (p.hisWords ?? "").slice(0, 240);
  return db.transaction(() => {
    const existing = db
      .query<{ id: number }, [string, string, string]>(
        `SELECT id FROM understudy_precedents WHERE source = ? AND source_ref = ? AND class = ?`,
      )
      .get(p.source, p.sourceRef, p.cls);
    if (existing) {
      const old = precedentById.get(existing.id);
      if (old) {
        dropPrecedentFts.run(old.id, old.class, old.repo, old.situation, old.decision, old.his_words, old.source_ref);
      }
    }
    const row = insertPrecedent.get(
      p.cls, p.partition, p.repo ?? "", p.situation, p.decision, words,
      p.alternatives ?? "", p.outcome ?? "", p.source, p.sourceRef, p.provenance ?? "", p.at, p.weight ?? 1,
    );
    if (!row) return 0;
    insertPrecedentFts.run(row.id, p.cls, p.repo ?? "", p.situation, p.decision, words, p.sourceRef);
    return row.id;
  })();
}

export function precedentCount(): number {
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM understudy_precedents`).get()?.n ?? 0;
  } catch {
    return 0;
  }
}

export function precedentsByClass(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const r of db.query<{ class: string; n: number }, []>(
      `SELECT class, COUNT(*) AS n FROM understudy_precedents GROUP BY class`,
    ).all()) out[r.class] = r.n;
  } catch { /* an empty bank is a valid answer */ }
  return out;
}

export interface Precedent {
  id: number;
  cls: string;
  situation: string;
  decision: string;
  hisWords: string;
  at: number;
  weight: number;
  source: string;
}

/**
 * The nearest precedents to a situation, WITHIN ONE PARTITION.
 *
 * `partition` and `class` are WHERE clauses on the base table and never terms
 * in the match string, and the difference is the whole safety property: BM25
 * ranks, and a rank can be outvoted by a strong enough text hit. A constraint
 * that can be outvoted is not a constraint. Written this way, no query can
 * return a row from another partition however well it matches.
 *
 * Throws on a missing partition rather than defaulting to one, because the
 * default that would be convenient here — search everything — is the exact
 * mistake this function exists to make impossible.
 */
/**
 * How much material each side holds.
 *
 * The panel offers two sides and defaults to one of them, and on this machine
 * the default is the smaller: 3,606 rows against 6,857. Somebody asking their
 * first question lands on the thinner half, gets little back, and concludes it
 * knows nothing about them — which is the opposite of true.
 *
 * Rather than pick the bigger side for them, the panel shows both numbers. A
 * default that quietly switched to the private half would be making a decision
 * about somebody's material without saying so.
 */
export function bankByPartition(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const r of db.query<{ partition: string; n: number }, []>(
      "SELECT partition, COUNT(*) AS n FROM understudy_precedents GROUP BY partition",
    ).all()) {
      out[r.partition] = r.n;
    }
  } catch {
    // An unreadable bank shows no counts rather than taking the tab down.
  }
  return out;
}

export function retrieve(q: { cls: string; partition: string; text: string; limit?: number; all?: boolean }): Precedent[] {
  if (!q.partition) throw new Error("retrieve: a partition is required");
  const limit = Math.max(1, Math.min(24, q.limit ?? 8));
  const terms = q.text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 12);
  try {
    if (!terms.length) {
      return db.query<
        { id: number; class: string; situation: string; decision: string; his_words: string; at: number; weight: number; source: string },
        [string, string, number]
      >(
        `SELECT id, class, situation, decision, his_words, at, weight, source
           FROM understudy_precedents
          WHERE class = ? AND partition = ?
          ORDER BY weight DESC, at DESC LIMIT ?`,
      ).all(q.cls, q.partition, limit).map(toPrecedent);
    }
    /*
     * AND when the caller asks for it, and it usually should.
     *
     * OR across every term matches a row that contains any one of them, so
     * asking "do I squash when I merge" returns every line that ever said the
     * word merge — including "Complete the merge", which is a button label. The
     * caller falls back to OR when AND finds nothing, so precision is tried
     * first and breadth is the fallback rather than the default.
     */
    const match = terms.map((t) => `"${t}"`).join(q.all ? " AND " : " OR ");
    return db.query<
      { id: number; class: string; situation: string; decision: string; his_words: string; at: number; weight: number; source: string },
      [string, string, string, number]
    >(
      `SELECT p.id, p.class, p.situation, p.decision, p.his_words, p.at, p.weight, p.source
         FROM understudy_precedents_fts f
         JOIN understudy_precedents p ON p.id = f.rowid
        WHERE f.understudy_precedents_fts MATCH ?
          AND p.class = ? AND p.partition = ?
        ORDER BY rank, p.weight DESC, p.at DESC
        LIMIT ?`,
    ).all(match, q.cls, q.partition, limit).map(toPrecedent);
  } catch {
    return [];
  }
}

function toPrecedent(r: {
  id: number; class: string; situation: string; decision: string; his_words: string; at: number; weight: number; source: string;
}): Precedent {
  return {
    id: r.id, cls: r.class, situation: r.situation, decision: r.decision,
    hisWords: r.his_words, at: r.at, weight: r.weight, source: r.source,
  };
}

export function recordFence(route: string, method: string): number {
  if (!recording()) return 0;
  try {
    return Number(fenceInsert.run({ $route: route, $method: method, $at: Date.now() } as any).lastInsertRowid);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Modes.

function effectiveMode(def: UnderstudyClass): UnderstudyMode {
  if (def.lock !== "earn") return "shadow";
  const want = load().modes[def.id];
  if (want && MODE_RANK[want] !== undefined) {
    return MODE_RANK[want] > MODE_RANK[UNDERSTUDY_CEILING] ? UNDERSTUDY_CEILING : want;
  }
  /*
   * With no per-class mode set, the STANCE is what the row happened under.
   *
   * Returning a flat `shadow` was right while nothing acted and became a lie
   * the moment something did: `mode` is the posture recorded against each
   * ledger row, and every row claiming "shadow" while the thing was acting
   * makes the record unauditable in exactly the situation somebody would go
   * back and audit it.
   */
  /*
   * THE STANCE NO LONGER DECIDES THIS, and removing it changes nothing today.
   *
   * The stance was the predictor's initiative dial — off, watching, asked,
   * offering, queued, undo, acting — and it governed nothing the work loop
   * does. Its controls were removed after counting the callers: `setStance`,
   * `setReach` and `stanceFor` had none outside their own tests. Reading a
   * setting that nothing can write is the worse half of that: it looks like a
   * live input and is a constant.
   *
   * Measured before cutting: the stored stance is `watching`, which fell
   * through to `shadow` — the same answer this returns.
   *
   * What decides a mode now is what a class has EARNED (`lock`), what has been
   * set for it deliberately (`/understudy/mode`, still live and still on the
   * understudy's own two-route allow-list), and the ceiling. All three are
   * things somebody chose.
   */
  return "shadow";
}

/** Where a class actually is. `shadow` for all thirteen in v1. */
export function modeOf(cls: string): UnderstudyMode {
  const def = classOf(cls);
  return def ? effectiveMode(def) : "shadow";
}

/**
 * Put a class on a rung, or refuse.
 *
 * Refuses an unknown class, an unknown mode, anything at all above `shadow` for
 * a `key` or `sealed` class, and anything above `UNDERSTUDY_CEILING` for the
 * rest. In v1 the ceiling is `shadow`, so the only accepted mode is `shadow`
 * and this setter cannot promote anything — which is the point. The route
 * exists, the ladder exists in the type, and the limit is one constant, so v2
 * raises it on purpose in one place rather than finding out the hard way that
 * the setter never had one.
 *
 * Returns whether the class is now at the requested mode.
 */
export function setMode(cls: string, mode: UnderstudyMode): boolean {
  const def = classOf(cls);
  if (!def) return false;
  if (MODE_RANK[mode] === undefined) return false;
  if (def.lock !== "earn" && mode !== "shadow") return false;
  if (MODE_RANK[mode] > MODE_RANK[UNDERSTUDY_CEILING]) return false;
  const s = load();
  save({ ...s, modes: { ...s.modes, [def.id]: mode } });
  return true;
}

/**
 * Stop.
 *
 * Every class drops to shadow and the process records that it is halted, which
 * is a different fact from being switched off — see `halted`. Returns how many
 * classes were above shadow when it ran, because "halt did nothing because
 * nothing was above shadow" and "halt caught four classes mid-ladder" are the
 * two outcomes and the caller should be able to say which happened.
 */
export function halt(): number {
  const s = load();
  let dropped = 0;
  const modes: Record<string, UnderstudyMode> = {};
  for (const def of CLASSES) {
    const want = s.modes[def.id];
    if (want && want !== "shadow") dropped++;
    modes[def.id] = "shadow";
  }
  if (recording()) recordFence("/understudy/halt", "POST");
  save({ ...s, modes });
  halted = true;
  return dropped;
}

/*
 * Whether something stopped it.
 *
 * Read by the frame — and, since the day the understudy learned to act, by the
 * actuator too. It had existed for months gating nothing but the RECORDING,
 * which made the emergency stop a great deal less than it looked: pressing halt
 * wound back what a shift had done, and then the next shift carried on acting,
 * because the only thing consulting this was the code that writes ledger rows.
 *
 * A stop the following thirty seconds can walk around is not a stop.
 *
 * See the field's comment in shared/types.ts for why it is not folded into
 * `enabled`, and note that switching the feature on is what lifts it — an
 * explicit sentence rather than a timer.
 */
export function isHalted(): boolean {
  return halted;
}

// ---------------------------------------------------------------------------
// The score.

interface ClassStats {
  n: number;
  hits: number;
  raw: number;
  lb: number;
  bank: number;
}

/*
 * WHAT COUNTS, stated once because it is the argument the scorecard will keep
 * having with itself.
 *
 * `n` is scored decisions: a row that has BOTH a prediction and an actual, with
 * provenance he typed or clicked. A sealed situation the understudy never
 * predicted is not a wrong answer, it is a missing one, and folding it into the
 * denominator would mean a class that predicts rarely and well scores worse
 * than a class that predicts always and badly. The missing ones are not hidden
 * — `seals.sealed` minus `seals.predicted` is exactly that number, on the same
 * frame — they are just not counted as disagreements.
 *
 * `agent-tolerated` is excluded on the same principle as the ledger comment in
 * db.ts: an agent not objecting is not the user agreeing.
 */
const SCORED = `kind = 'decision' AND provenance IN ('typed','clicked')
  AND predicted_at IS NOT NULL AND actual_at IS NOT NULL`;

const scoredByClass = db.query<{ class: string; n: number; hits: number }, []>(
  `SELECT class, COUNT(*) AS n, SUM(CASE WHEN verdict = 'agree' THEN 1 ELSE 0 END) AS hits
     FROM understudy_ledger WHERE ${SCORED} GROUP BY class`,
);

/**
 * The same count, but only over the last N days.
 *
 * A separate prepared statement rather than a parameter on the one above,
 * because the unwindowed form is the one the gate reads and it must not
 * accidentally acquire a window: a class that has earned its 80 does not
 * un-earn them because somebody left the panel on 7d.
 */
const scoredByClassSince = db.query<{ class: string; n: number; hits: number }, [number]>(
  `SELECT class, COUNT(*) AS n, SUM(CASE WHEN verdict = 'agree' THEN 1 ELSE 0 END) AS hits
     FROM understudy_ledger WHERE ${SCORED} AND sealed_at >= ? GROUP BY class`,
);

/**
 * The streak, newest first, capped.
 *
 * Two hundred is a cap on the query rather than on the truth: a bank of 200 and
 * a bank of 2000 read identically to a person, and an unbounded scan here would
 * be the one query in this file that grows with the age of the install.
 */
const recentVerdicts = db.query<{ verdict: string | null }, [string]>(
  `SELECT verdict FROM understudy_ledger WHERE ${SCORED} AND class = ?
    ORDER BY actual_at DESC, id DESC LIMIT 200`,
);

function bankOf(cls: string): number {
  let bank = 0;
  try {
    for (const r of recentVerdicts.all(cls)) {
      if (r.verdict !== "agree") break;
      bank++;
    }
  } catch {
    // Same rule as the rest of the read path: an unreadable ledger draws a zero
    // rather than taking the view down with it.
  }
  return bank;
}

const scoredForClass = db.query<{ n: number; hits: number }, [string]>(
  `SELECT COUNT(*) AS n, SUM(CASE WHEN verdict = 'agree' THEN 1 ELSE 0 END) AS hits
     FROM understudy_ledger WHERE ${SCORED} AND class = ?`,
);

function statsFor(cls: string): ClassStats {
  try {
    const row = scoredForClass.get(cls);
    return derive(row?.n ?? 0, row?.hits ?? 0, cls);
  } catch {
    return derive(0, 0, cls);
  }
}

function derive(n: number, hits: number, cls: string): ClassStats {
  const raw = n > 0 ? hits / n : 0;
  return { n, hits, raw, lb: wilsonLower(hits, n), bank: n > 0 ? bankOf(cls) : 0 };
}

function meetsThreshold(s: ClassStats, base?: Baseline): boolean {
  if (!(s.n >= OFFER_MIN_N && s.raw >= OFFER_MIN_RAW && s.lb >= OFFER_MIN_LB)) return false;
  /*
   * The edge, and it is the only one of the four bars that is about the MODEL.
   * The other three are satisfied by any class where the person is consistent,
   * which is most of them — being predictable is not the same as having been
   * learned.
   *
   * A baseline with no rows behind it cannot rule anything out, so it does not:
   * an unmeasured baseline is missing evidence, not evidence of an edge.
   */
  if (!base || base.n < OFFER_MIN_N) return false;
  return s.raw - base.raw >= OFFER_MIN_EDGE;
}

/**
 * Has this class earned the right to be ASKED about.
 *
 * Always false for a `key` or a `sealed` class, whatever the record says, and
 * the ordering of the checks is deliberate: the lock is consulted before the
 * arithmetic, so no amount of agreement can be mistaken for permission.
 *
 * And it is worth saying again where somebody will read it: offered is not on.
 * Nothing in this file promotes a class. A human presses, or nothing happens.
 */
export function offered(cls: string): boolean {
  const def = classOf(cls);
  if (!def || def.lock !== "earn") return false;
  /*
   * The baseline goes in here too, and forgetting it the first time is the
   * argument for reading this comment.
   *
   * This is the second place that decides whether a class is offered — the
   * scorecard is the other — and when the gate gained a fourth bar only the
   * scorecard got it. The panel said "offered" and the function that anything
   * acting would actually call said no. A test caught it, but only because a
   * test happened to assert both; nothing structural was stopping them from
   * disagreeing quietly for as long as nobody looked.
   */
  return meetsThreshold(statsFor(cls), baselines()[cls]);
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Why a class is not being offered, in sentences the browser prints verbatim.
 *
 * Sentences rather than codes, and the panel derives NOTHING. A client that has
 * to turn `["lb"]` into "the pessimistic reading of that record is 0.59" is a
 * client that owns half the policy: it needs the threshold, it needs to know
 * which bound, and the day the threshold moves there are two places to change
 * and one of them is shipped in a bundle somebody has cached. The structured
 * form is not lost — `n`, `hits`, `raw`, `lb` and `lock` are all on the same
 * row — so a panel that wants to draw a chip has the numbers without parsing a
 * word of this.
 */
function blockedFor(def: UnderstudyClass, s: ClassStats, base?: Baseline): string[] {
  const out: string[] = [];
  if (def.lock === "key") {
    out.push(
      `${def.id} answers on somebody else's behalf, so it stays in shadow for the whole of v1 however well it scores.`,
    );
  } else if (def.lock === "sealed") {
    out.push(
      `${def.id} would touch somebody else's record of what the work is, so it stays in shadow for ever by decision rather than by score.`,
    );
  }
  if (s.n < OFFER_MIN_N) {
    out.push(
      `Not enough scored decisions yet: ${s.n} of the ${OFFER_MIN_N} needed, counting only what you typed or clicked.`,
    );
  }
  if (s.n > 0 && s.raw < OFFER_MIN_RAW) {
    out.push(`It agreed ${pct(s.raw)} of the time, and ${pct(OFFER_MIN_RAW)} is the floor.`);
  }
  if (s.n > 0 && s.lb < OFFER_MIN_LB) {
    out.push(
      `The pessimistic reading of ${s.hits} out of ${s.n} is ${s.lb.toFixed(2)}, under the ${OFFER_MIN_LB.toFixed(2)} the bound has to clear.`,
    );
  }
  /*
   * The one that says "you are predictable" rather than "it learned you", and
   * the reason it is worth a sentence of its own: a person reading a 97% with
   * no other explanation would reasonably conclude the thing knows them.
   */
  if (s.n >= OFFER_MIN_N && base && base.n >= OFFER_MIN_N && s.raw - base.raw < OFFER_MIN_EDGE) {
    out.push(
      `It agreed ${pct(s.raw)} of the time and simply repeating your usual answer would have agreed ${pct(base.raw)} — ` +
      `that is ${pct(Math.max(0, s.raw - base.raw))} of its own, under the ${pct(OFFER_MIN_EDGE)} it has to add.`,
    );
  }
  return out;
}

/**
 * The baseline: what "your usual" would have scored on the same rows.
 *
 * THIS IS THE NUMBER THAT DECIDES WHETHER ANY OF THIS IS WORTH KEEPING, and
 * without it the agreement figure is unreadable. A class where somebody does
 * the same thing ninety per cent of the time is a class where a constant
 * scores ninety per cent — and a predictor that also scores ninety has learned
 * precisely nothing about the person. It has learned that they have a setting.
 *
 * So: the same rows, scored by the dumbest possible rule — always answer
 * whatever they have answered most often so far — and the difference between
 * the two is the only part of the agreement figure that belongs to the model.
 *
 * An EXPANDING WINDOW, which is the whole reason this is not two lines. Each
 * row is scored against the majority of the rows BEFORE it, never including
 * itself and never including its own future. Computing one modal answer over
 * the whole set and scoring every row against it would let the baseline see
 * outcomes it could not have known, and would flatter it — which, since the
 * baseline is the thing we are trying to beat, is the direction of error that
 * quietly turns a real result into a fake one.
 */
const scoredRows = db.query<{ class: string; actual: string; verdict: string | null; at: number }, []>(
  `SELECT class, actual, verdict, COALESCE(actual_at, sealed_at) AS at
     FROM understudy_ledger
    WHERE ${SCORED}
    ORDER BY at ASC`,
);

export interface Baseline {
  /** Rows the baseline was scored on — the same denominator as the class. */
  n: number;
  hits: number;
  raw: number;
}

export function baselines(): Record<string, Baseline> {
  const out: Record<string, Baseline> = {};
  let rows: { class: string; actual: string; verdict: string | null; at: number }[] = [];
  try {
    rows = scoredRows.all();
  } catch {
    return out;
  }

  const seen = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const tally = seen.get(r.class) ?? new Map<string, number>();

    // What the majority rule WOULD have said, knowing only what came before.
    let modal = "";
    let modalN = 0;
    for (const [k, n] of tally) if (n > modalN) { modal = k; modalN = n; }

    const b = out[r.class] ?? { n: 0, hits: 0, raw: 0 };
    // A baseline with no history yet has no answer, and an empty guess is not
    // a hit. Counted in the denominator all the same, because the model was
    // scored on this row too and the two have to share a denominator or the
    // comparison is between different questions.
    b.n += 1;
    if (modal && modal === r.actual) b.hits += 1;
    out[r.class] = b;

    tally.set(r.actual, (tally.get(r.actual) ?? 0) + 1);
    seen.set(r.class, tally);
  }
  for (const k of Object.keys(out)) {
    const b = out[k]!;
    b.raw = b.n ? b.hits / b.n : 0;
  }
  return out;
}

const sealCounts = db.query<
  { sealed: number | null; predicted: number | null; late: number | null; unsealed: number | null;
    lastUnsealed: number | null; lastLate: number | null },
  []
>(
  `SELECT
     SUM(CASE WHEN unsealed = 0 THEN 1 ELSE 0 END) AS sealed,
     SUM(CASE WHEN unsealed = 0 AND predicted_at IS NOT NULL THEN 1 ELSE 0 END) AS predicted,
     SUM(CASE WHEN late = 1 THEN 1 ELSE 0 END) AS late,
     SUM(CASE WHEN unsealed = 1 THEN 1 ELSE 0 END) AS unsealed,
     /* WHEN it last happened, which is the difference between a hole and a
        scar. A coverage gap that has since been fixed poisons this indicator
        for as long as the window is wide, and nothing on the panel could tell
        that from one still open. */
     MAX(CASE WHEN unsealed = 1 THEN COALESCE(actual_at, sealed_at) END) AS lastUnsealed,
     MAX(CASE WHEN late = 1 THEN COALESCE(actual_at, sealed_at) END) AS lastLate
   FROM understudy_ledger WHERE kind = 'decision'`,
);

const sealCountsSince = db.query<
  { sealed: number | null; predicted: number | null; late: number | null; unsealed: number | null;
    lastUnsealed: number | null; lastLate: number | null },
  [number]
>(
  `SELECT
     SUM(CASE WHEN unsealed = 0 THEN 1 ELSE 0 END) AS sealed,
     SUM(CASE WHEN unsealed = 0 AND predicted_at IS NOT NULL THEN 1 ELSE 0 END) AS predicted,
     SUM(CASE WHEN late = 1 THEN 1 ELSE 0 END) AS late,
     SUM(CASE WHEN unsealed = 1 THEN 1 ELSE 0 END) AS unsealed,
     MAX(CASE WHEN unsealed = 1 THEN COALESCE(actual_at, sealed_at) END) AS lastUnsealed,
     MAX(CASE WHEN late = 1 THEN COALESCE(actual_at, sealed_at) END) AS lastLate
   FROM understudy_ledger WHERE kind = 'decision' AND sealed_at >= ?`,
);

/**
 * The last few decisions, newest first — what the Ledger tab reads.
 *
 * Only decision rows, and only the columns a person can be shown: the class,
 * what it was about, when, whether a prediction beat the answer, and how it was
 * scored. `predicted` and `actual` are categorical JSON by construction (see
 * recordDecision), so there is nothing in them a body could have leaked into.
 */
const recentDecisions = db.query<
  {
    id: number; class: string; subject: string; repo: string; sealed_at: number;
    predicted: string | null; actual: string | null; verdict: string | null;
    late: number; unsealed: number; provenance: string; situation_hash: string;
  },
  [number]
>(
  `SELECT id, class, subject, repo, sealed_at, predicted, actual, verdict, late, unsealed,
          provenance, situation_hash
     FROM understudy_ledger
    WHERE kind = 'decision'
    ORDER BY COALESCE(actual_at, sealed_at) DESC
    LIMIT ?`,
);

export interface UnderstudyFeedRow {
  id: number;
  cls: string;
  label: string;
  subject: string;
  repo: string;
  at: number;
  predicted: string | null;
  actual: string | null;
  verdict: string | null;
  late: boolean;
  unsealed: boolean;
  provenance: string;
  hasSnapshot: boolean;
}

/** The Ledger tab's feed. Capped by the caller; 200 is the ceiling. */
export function feed(limit = 50): UnderstudyFeedRow[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  try {
    return recentDecisions.all(n).map((r) => ({
      id: r.id,
      cls: r.class,
      label: classOf(r.class)?.label ?? r.class,
      subject: r.subject,
      repo: r.repo,
      at: r.sealed_at,
      predicted: r.predicted,
      actual: r.actual,
      verdict: r.verdict,
      late: r.late === 1,
      unsealed: r.unsealed === 1,
      provenance: r.provenance,
      hasSnapshot: !!r.situation_hash,
    }));
  } catch {
    return [];
  }
}

/**
 * Everything the view draws, computed on the server.
 *
 * Whole rather than a delta: it is thirteen rows, and a diff of thirteen rows
 * costs more to reason about than it saves on the wire.
 *
 * The seal counts are over the whole ledger rather than a window, because
 * decision rows never expire — there is no window for them to differ from.
 */
/**
 * @param windowDays  How far back to count, or null for everything. The panel's
 *   7d / 30d / All control passes this through. It narrows what is DISPLAYED
 *   and never what the gate reads — `offered()` has no window and must not grow
 *   one, or a class would lose its promotion because somebody changed a filter.
 */
export function scorecard(windowDays: number | null = null): UnderstudyFrame {
  const asOf = Date.now();
  const since = windowDays && windowDays > 0 ? asOf - windowDays * 86_400_000 : null;
  let byClass = new Map<string, { n: number; hits: number }>();
  let seals = { sealed: 0, predicted: 0, late: 0, unsealed: 0, lastUnsealed: 0, lastLate: 0 };
  try {
    const rows = since === null ? scoredByClass.all() : scoredByClassSince.all(since);
    byClass = new Map(rows.map((r) => [r.class, { n: r.n ?? 0, hits: r.hits ?? 0 }]));
    const c = since === null ? sealCounts.get() : sealCountsSince.get(since);
    seals = {
      sealed: c?.sealed ?? 0,
      predicted: c?.predicted ?? 0,
      late: c?.late ?? 0,
      unsealed: c?.unsealed ?? 0,
      lastUnsealed: c?.lastUnsealed ?? 0,
      lastLate: c?.lastLate ?? 0,
    };
  } catch {
    // An unreadable ledger is an empty scorecard, not a dead view. The frame
    // still carries `enabled` and `halted`, which is what a person needs to
    // work out why they are looking at zeros.
  }

  const base = baselines();
  const classes: UnderstudyClassRow[] = CLASSES.map((def) => {
    const got = byClass.get(def.id);
    const s = derive(got?.n ?? 0, got?.hits ?? 0, def.id);
    const isOffered = def.lock === "earn" && meetsThreshold(s, base[def.id]);
    return {
      id: def.id,
      label: def.label,
      lock: def.lock,
      mode: effectiveMode(def),
      offered: isOffered,
      n: s.n,
      hits: s.hits,
      raw: s.raw,
      lb: s.lb,
      bank: s.bank,
      blocked: isOffered ? [] : blockedFor(def, s, base[def.id]),
      /* The gates, decided here so the panel can draw them without owning a
         copy of the policy. `sealed` and `key` never clear on measurement, so
         they report the bars honestly rather than pretending to be close. */
      countMet: s.n >= OFFER_MIN_N,
      countBar: OFFER_MIN_N,
      agreementMet: s.n >= OFFER_MIN_N && s.raw >= OFFER_MIN_RAW && s.lb >= OFFER_MIN_LB,
      agreementBarAt: def.lock === "sealed" ? null : Math.round(OFFER_MIN_RAW * 100),
      /* What the dumbest rule would have scored on the same rows. The gap is
         the only part of the agreement figure that belongs to the model. */
      baseRaw: base[def.id]?.raw ?? 0,
      baseN: base[def.id]?.n ?? 0,
    };
  });

  /*
   * The two aggregates the panel is not allowed to work out for itself.
   *
   * `agreement` is the headline the feature is named for and it was computed
   * nowhere: every row carried `hits`, nothing ever summed them, and the
   * scorecard shipped without a score. `toNextRung` is the smallest remaining
   * count gap, which is the only forward-looking number on the screen.
   *
   * Both live here because OFFER_MIN_N does, and a panel that subtracted `n`
   * from a bar it had a copy of would be the thresholds in two places — see
   * web/test/understudy-no-thresholds.test.ts.
   */
  const totalN = classes.reduce((a, c) => a + c.n, 0);
  const totalHits = classes.reduce((a, c) => a + c.hits, 0);
  const agreement = totalN > 0 ? Math.round((totalHits / totalN) * 100) : null;
  const toNextRung = classes
    .filter((c) => c.lock === "earn" && !c.offered && c.countBar > c.n)
    .reduce<number | null>((min, c) => {
      const gap = c.countBar - c.n;
      return min === null || gap < min ? gap : min;
    }, null);

  return { asOf, halted, enabled: enabled(), level: UNDERSTUDY_CEILING, classes, seals, agreement, toNextRung };
}
