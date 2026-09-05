/*
 * Where the understudy may be taught from, and nothing is read without a yes.
 *
 * The premise of the whole feature is that a person's own machine already holds
 * most of what it would take to predict them: the conventions they wrote down,
 * the corrections they made, the decisions they logged. This module finds those
 * places and describes them. It reads nothing on its own.
 *
 * TWO KINDS OF MATERIAL, and the distinction runs through everything below.
 *
 *   RULES are the user saying what they do — CLAUDE.md, the feedback files,
 *   the conventions kept by whatever memory tool they use. Deliberate, written
 *   for an audience, and the highest quality thing here. They compile into the
 *   policy.
 *
 *   PRECEDENTS are the user actually doing it — transcripts, the worklog, the
 *   action log. Messier, far larger, and the only material that can say what
 *   somebody does rather than what they say they do.
 *
 * A policy without precedents is a well-mannered assistant that has read a
 * style guide. Precedents are what make a prediction belong to a person.
 *
 * CONSENT IS PER SOURCE AND DEFAULTS TO NO. Not because a checkbox is good
 * manners, but because these paths differ enormously in what they contain: a
 * conventions file is a page the user wrote on purpose, and a transcript
 * directory is two gigabytes of everything they have said to a machine for a
 * year, most of it about an employer's private work. Treating those as one
 * decision would be the whole feature's worst mistake.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { runs as workRuns } from "./understudy-work.ts";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { UnderstudySource } from "../../shared/types.ts";

const HOME = homedir();

/* ────────────────────── what a person may add as a source ────────────────── */

/** The home as the shell means it, read when asked — `homedir()` is settled
 *  at start-up and a test cannot move it, so a boundary on top of it would be
 *  a boundary nobody can prove. Same choice disk.ts makes. */
const homeNow = (): string => process.env.HOME || homedir();

const isUnder = (p: string, dir: string): boolean => {
  const back = relative(dir, p);
  return back === "" || (!back.startsWith("..") && !back.startsWith(sep));
};

/** Resolved through its symlinks as far as it exists — a link named in
 *  `~/Documents` and pointing at `~/.ssh` is `~/.ssh`. */
function realish(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(head), ...tail); } catch { /* climb */ }
    const up = dirname(head);
    if (up === head) return abs;
    tail.unshift(head.slice(up.length + 1));
    head = up;
  }
  return abs;
}

/**
 * Why this path may not be registered as a source, or null when it may.
 *
 * `POST /understudy/source/add` took any absolute path that existed, and the
 * reader behind it opens every parseable file underneath: `~/.ssh` and
 * `~/.aws` were one request away from being read into the policy bank.
 *
 * Three rules, on the spelling AND the real path:
 *
 *   - `~/.ssh`, `~/.gnupg`, `~/.aws` and the app's own configuration are
 *     refused outright, whatever else is true;
 *   - the hidden homes the recommended list itself offers — shell setup and
 *     history, git, tmux, the agent's own settings — stay addable, since the
 *     list already hands them out one click away; `.claude` is allowed as a
 *     segment anywhere because a project keeps its agent rules under that
 *     name too, and that is the shape the ingest tests register;
 *   - any other hidden segment is refused. A dotted directory is where a
 *     machine keeps what it does not show, and "rules I wrote down" do not
 *     live there.
 */
export function extraSourceError(path: string): string | null {
  const h = homeNow();
  const spelled = resolve(path);
  const real = realish(spelled);
  const cfg = process.env.XDG_CONFIG_HOME || join(h, ".config");
  const denied = [join(h, ".ssh"), join(h, ".gnupg"), join(h, ".aws"), join(h, ".config", "agentglass"), join(cfg, "agentglass")];
  for (const d of denied) {
    if (isUnder(spelled, d) || isUnder(real, d)) return `${d} holds keys or the app's own configuration and is never read as a source`;
  }
  const histfile = process.env.HISTFILE && process.env.HISTFILE.startsWith(h) ? [resolve(process.env.HISTFILE)] : [];
  const wellKnown = [
    join(h, ".config", "fish"), join(h, ".claude"), join(h, ".gitconfig"), join(h, ".tmux.conf"),
    join(h, ".zshrc"), join(h, ".bashrc"), join(h, ".zsh_history"), join(h, ".bash_history"),
    join(h, ".local", "share", "fish"), ...histfile,
  ];
  for (const candidate of [spelled, real]) {
    if (wellKnown.some((w) => isUnder(candidate, w))) continue;
    const hidden = candidate.split(sep).filter(Boolean).find((seg) => seg.startsWith(".") && seg !== ".claude");
    if (hidden) return `${candidate} is under a hidden folder (${hidden}); only the shell, git, tmux and agent homes the list offers may be added`;
  }
  return null;
}

/** Only ever files we can actually parse. */
const READABLE = new Set([".md", ".jsonl", ".json", ".txt", ".db", ".fish", ".conf", ".gitconfig", ".lua", ".toml", ".yml", ".yaml"]);

/**
 * Count files under a path, cheaply and with a cap.
 *
 * Capped because one of these paths is a 2 GB tree of transcripts and the
 * consent screen has to render in a moment; the number a person needs is "a lot
 * of them" and not the exact integer. Depth-limited for the same reason.
 */
function survey(path: string, maxDepth = 3): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || files > 20_000) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") && e !== ".claude") continue;
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const dot = e.lastIndexOf(".");
        if (dot > 0 && READABLE.has(e.slice(dot))) {
          files++;
          bytes += st.size;
        }
      }
    }
  };
  try {
    const st = statSync(path);
    // A named file is always readable whatever it is called: `fish_history`
    // and `.gitconfig` carry no extension and are two of the best sources here.
    if (st.isFile()) return { files: 1, bytes: st.size };
    walk(path, 0);
  } catch {
    return { files: 0, bytes: 0 };
  }
  return { files, bytes };
}

interface Candidate {
  id: string;
  label: string;
  path: string;
  kind: "rules" | "precedents";
  what: string;
}

/**
 * The places worth looking, in the order a person should meet them.
 *
 * Rules first and smallest first, which is not arrangement for its own sake:
 * the first thing on this list is a page the user wrote by hand and the last is
 * every conversation they have had with a machine. Someone reading down it
 * should feel the stakes rise, and should be able to stop anywhere.
 */
function candidates(): Candidate[] {
  const claudeDir = join(HOME, ".claude");
  const projects = join(claudeDir, "projects");
  const out: Candidate[] = [
    {
      id: "conventions",
      label: "Your conventions",
      path: join(claudeDir, "CLAUDE.md"),
      kind: "rules",
      what: "The house rules you wrote for every session. The single densest statement of how you want work done.",
    },
    {
      id: "skills",
      label: "Your skills",
      path: join(claudeDir, "skills"),
      kind: "rules",
      what: "Procedures you wrote out in full — the exact format of a thing, and the order you do it in.",
    },
    {
      id: "worklog",
      label: "Your worklog",
      path: join(HOME, "Documents", "notes", "worklog"),
      kind: "precedents",
      what: "A dated daily log, if you keep one: what you actually did each day, in your own words.",
    },
  ];

  /*
   * A MEMORY STORE IS NOT LISTED HERE, and that is on purpose. Plenty of people
   * keep one — decisions and corrections recorded across sessions, each with
   * its reason — and it is the densest rule material a machine holds. But the
   * tool is a personal choice, and its name and the path under $HOME belong to
   * the person rather than to this file: naming one here would ship somebody's
   * private setup in a public repository. It is declared instead as a source of
   * the user's own (`POST /understudy/source/add`, `kind: "rules"`, a path
   * ending in `.db`), and `understudy-ingest.ts` reads any sqlite that answers
   * the shape it documents.
   *
   * How the person WORKS, as opposed to what they wrote down about working.
   *
   * These were missing from the first pass and they are some of the densest
   * material on the machine. A shell history is five thousand decisions about
   * which tool, in which order, with which flags — the texture of how somebody
   * operates, which no prose file records because nobody writes it down.
   * Aliases and abbreviations are the same thing pre-compressed: a person only
   * makes a shortcut for something they do constantly.
   */
  for (const [id, path, label, kind, what] of [
    ["shell-history", join(HOME, ".local", "share", "fish", "fish_history"), "Your shell history",
      "precedents", "Every command you have run: which tool, in what order, with which flags. Nobody writes this down, which is exactly why it is worth reading."],
    ["shell-history-bash", join(HOME, ".bash_history"), "Your shell history (bash)",
      "precedents", "The same commands, as bash recorded them."],
    ["shell-history-zsh", process.env.HISTFILE && process.env.HISTFILE.startsWith(HOME) ? process.env.HISTFILE : join(HOME, ".zsh_history"), "Your shell history (zsh)",
      "precedents", "The same commands, as zsh recorded them, with the clock zsh keeps."],
    ["shell-config", join(HOME, ".config", "fish"), "Your shell setup (fish)",
      "rules", "Aliases, abbreviations and functions. A person only makes a shortcut for something they do constantly."],
    ["shell-config-zsh", join(HOME, ".zshrc"), "Your shell setup (zsh)",
      "rules", "Aliases and functions, read the same way as the fish setup."],
    ["shell-config-bash", join(HOME, ".bashrc"), "Your shell setup (bash)",
      "rules", "Aliases and functions, read the same way as the fish setup."],
    ["git-config", join(HOME, ".gitconfig"), "Your git settings",
      "rules", "Aliases, your merge and pull defaults, your editor. Small, and unusually direct about how you like to work."],
    ["tmux-config", join(HOME, ".tmux.conf"), "Your tmux setup",
      "rules", "How you arrange a screen, and which keys you reach for."],
    ["claude-settings", join(HOME, ".claude", "settings.json"), "Your agent settings",
      "rules", "Permissions, hooks and defaults — the rules you already gave agents, written as configuration."],
    ["notes", join(HOME, "Documents", "notes"), "Your notes",
      "precedents", "Everything you keep outside a repository: investigations, specs, findings, the daily log."],
    ["projects", join(HOME, "Documents", "projects"), "Your proof-of-work folder",
      "precedents", "The evidence you assemble for a piece of work — how you decide something is finished and demonstrated."],
  ] as const) {
    out.push({ id, label, path, kind: kind as "rules" | "precedents", what });
  }

  // Per-project memory, one entry each, because a project is the unit somebody
  // says yes or no to. Lumping them would make the employer's project and a
  // hobby project a single checkbox.
  try {
    for (const dir of readdirSync(projects)) {
      const mem = join(projects, dir, "memory");
      if (!existsSync(mem)) continue;
      out.push({
        id: `memory:${dir}`,
        label: `Project memory — ${prettyProject(dir)}`,
        path: mem,
        kind: "rules",
        what: "Rules and corrections recorded while working on this project, each written down the day it was learned.",
      });
    }
  } catch { /* no projects dir is a normal, empty answer */ }

  /*
   * THE CLONE'S OWN SESSIONS ARE NOT MATERIAL TO LEARN FROM.
   *
   * Every run cuts a worktree, and every session in it leaves a transcript
   * project of its own — so each finished task added another "Transcripts — …"
   * row to this list, waiting to be ticked. Tick them and the bank fills with
   * the understudy's words instead of his, which is the one thing it must not
   * hold: it exists to answer how HE decides, and a copy of a copy is not that.
   *
   * Recognised from the runs table rather than guessed from the name. The
   * worktree path of every run it has ever made is recorded, and the transcript
   * project for a directory is that path with the separators flattened — so
   * this is a lookup, not a pattern that will mistake somebody's real project
   * for one of these.
   */
  const mine = new Set(
    workRuns(200)
      .map((r) => r.worktree)
      .filter(Boolean)
      .map((w) => w.replace(/[/.]/g, "-")),
  );

  // Transcripts last, and per project for the same reason.
  try {
    for (const dir of readdirSync(projects)) {
      const p = join(projects, dir);
      if (!statSync(p).isDirectory()) continue;
      if (mine.has(dir)) continue;
      out.push({
        id: `transcripts:${dir}`,
        label: `Transcripts — ${prettyProject(dir)}`,
        path: p,
        kind: "precedents",
        what: "Every session on this project: what you were asked, what you typed back, and what you stopped.",
      });
    }
  } catch { /* same */ }

  return out;
}

/** `-home-you-code-agentglass` -> `agentglass`. */
function prettyProject(dir: string): string {
  const parts = dir.split("-").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

/**
 * Everything on offer, with consent applied.
 *
 * `allowed` comes from the store and defaults to false for every one of them.
 * A source the user added by hand is included even when it no longer exists, so
 * that a path which moved reads as "not found" rather than silently vanishing
 * from a list they curated.
 */
/**
 * Is this path the user's own open project, rather than somebody else's work.
 *
 * THE USERNAME MUST NOT COUNT, and getting that wrong shipped: the first
 * version tested /agentglass|you/ against the whole path, and every path
 * on the machine contains /home/you/. So the username matched everything,
 * every source was classified as the user's own, and "set this up for me"
 * ticked 646 files and 400 MB of an employer's transcripts while labelling
 * them `yours` and `suggested`. Exactly the material the recommendation exists
 * to leave alone.
 *
 * A Claude project directory encodes the home path in its own name —
 * `-home-<user>-code-<project>` — so the home prefix has to be stripped from
 * the DIRECTORY NAME too, not merely from the path. What is left is the part
 * that actually says which project this is.
 *
 * The default is closed. A path we cannot place is not "probably fine": it is
 * unknown, and unknown material stays out of the suggested set and out of the
 * open partition.
 */
const OPEN_PROJECTS = /(^|[-/])agentglass([-/]|$)/i;

function isOpenProject(path: string): boolean {
  const dir = path.split("/").find((seg) => seg.startsWith("-home-")) ?? "";
  // `-home-dev-code-orbit` -> `code-orbit`; `-home-dev` -> ``.
  const project = dir.replace(/^-home-[^-]+-?/, "");
  if (project) return OPEN_PROJECTS.test(project);
  // Not a project directory at all — a worklog, a folder the user added. Those
  // are judged by their own path, with the home prefix removed so the username
  // cannot vote.
  const rest = path.startsWith(HOME) ? path.slice(HOME.length) : path;
  return OPEN_PROJECTS.test(rest);
}

/**
 * Which PARTITION this source lands in, and whether we suggest it.
 *
 * `sensitive` was a bad name for this and the label it produced —
 * "somebody else's work" — told the user the opposite of the truth. It is all
 * their work. Every one of these directories is a record of things they did.
 *
 * What the flag actually decides is where the material is FILED. Anything that
 * is not the user's own public project is filed `closed`, and retrieval can
 * never cross a partition — so a prediction bound for a public repository can
 * never surface a row that came out of a private one. That is the entire
 * protection, and it is about where a name may end up, not about who did the
 * work.
 *
 * Which is why reading it is not the risk, and why the suggested set now
 * includes it. A set that reads only somebody's tidy open-source project
 * learns a tidier person than exists: the professional decisions — the
 * reviewing, the merging, the triage under a deadline — are almost all in the
 * closed half. Leaving them out does not make the understudy safer, it makes it
 * a model of a side project.
 *
 * The one thing the partition cannot do is know a name nobody has told it
 * about, which is what the exclusion list is for and why it is step one.
 */
function judge(c: Candidate): { sensitive: boolean; recommended: boolean } {
  const open = isOpenProject(c.path);
  // Anything under a project directory that is not demonstrably the user's own
  // open work is treated as somebody else's. The default matters more than the
  // detection: unknown is not "probably fine".
  const sensitive = c.id.startsWith("transcripts:") || c.id.startsWith("memory:")
    ? !open
    : false;
  /*
   * NOTHING SENSITIVE IS EVER SUGGESTED, whatever kind it is.
   *
   * The first version returned `recommended: true` for every rules source, on
   * the reasoning that rules are the user's own writing. They are — but rules
   * recorded while working on an employer's project are still about that
   * project, and a set that ticks them by default is making a decision that
   * belongs to the person. It can be ticked by hand in one click; being asked
   * is the whole point.
   */
  /*
   * Everything real is suggested, closed or open.
   *
   * The earlier version excluded the closed half on a value-per-risk argument,
   * and the argument was wrong on both halves: the value is higher there — that
   * is where the professional decisions are — and the risk is not in reading,
   * it is in a private name reaching a public artifact, which the partition and
   * the exclusion list handle wherever the material came from.
   *
   * The one exception is a scratchpad: a temporary directory is not a record of
   * anything and is only ever noise in a bank.
   */
  if (/[-/]tmp([-/]|$)|scratchpad/i.test(c.path)) return { sensitive, recommended: false };
  return { sensitive, recommended: true };
}

export function listSources(
  allow: Record<string, boolean>,
  extra: { id: string; path: string; label?: string; kind?: "rules" | "precedents" }[] = [],
): UnderstudySource[] {
  const rows: UnderstudySource[] = [];

  for (const c of candidates()) {
    const found = existsSync(c.path);
    const { files, bytes } = found ? survey(c.path) : { files: 0, bytes: 0 };
    // A source with nothing in it is not a choice, it is a row of furniture.
    // The first version listed every project directory it found, including
    // scratchpads with zero readable files, and the screen read as a wall.
    if (found && files === 0) continue;
    rows.push({
      ...c,
      found,
      files,
      bytes,
      allowed: allow[c.id] === true,
      added: false,
      ...judge(c),
    });
  }

  for (const e of extra) {
    const found = existsSync(e.path);
    const { files, bytes } = found ? survey(e.path) : { files: 0, bytes: 0 };
    rows.push({
      id: e.id,
      label: e.label || e.path.replace(HOME, "~"),
      path: e.path,
      kind: e.kind || "precedents",
      what: "A place you pointed it at yourself.",
      found,
      files,
      bytes,
      allowed: allow[e.id] === true,
      added: true,
      // Somewhere the person pointed at deliberately. We do not second-guess
      // it, and we do not put it in the recommended set either.
      sensitive: false,
      recommended: false,
    });
  }

  return rows;
}

/** The paths the user has actually said yes to, ready to read. */
export function allowedSources(
  allow: Record<string, boolean>,
  extra: { id: string; path: string; label?: string; kind?: "rules" | "precedents" }[] = [],
): UnderstudySource[] {
  return listSources(allow, extra).filter((s) => s.allowed && s.found && s.files > 0);
}
