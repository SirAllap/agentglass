/**
 * Every Claude Code session belonging to a project, whichever checkout it ran in.
 *
 * What this exists for: resuming one is three steps by hand — open a tab, start
 * the agent, type `/resume`, find the session in a list — and the list `/resume`
 * shows is scoped to the directory the agent happens to be running in. A card
 * worked on in a worktree is invisible from the main checkout, so the sessions
 * you most want back are the ones the built-in list cannot offer.
 *
 * Read from disk rather than from this app's database, and that is deliberate:
 * `/resume` reads `~/.claude/projects/<slug>/<id>.jsonl`, so reading the same
 * files is the only way to be sure the two lists agree. A session the scanner
 * never ingested — a machine where agentglass was installed last week, a
 * transcript older than the retention window — is still there on disk and is
 * still resumable, and a picker that quietly omitted it would be worse than no
 * picker at all.
 *
 * The cost is bounded on purpose: the slug is a pure function of the path, so a
 * project's transcripts are found by NAMING the directories rather than by
 * walking every project on the machine, and only the head of each transcript is
 * read (the title is in the first user message, and the files run to hundreds of
 * megabytes).
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { claudeHome, projectSlug } from "./agents/claudecode.ts";
import { worktrees } from "./gitwork.ts";
import { inScope } from "./config.ts";

export interface AgentSession {
  /** The id `--resume` takes: the transcript's file name. */
  id: string;
  /** What the session is called: the CLI's own summary when it wrote one, and
   *  the first user message otherwise — the same text `/resume` shows. */
  title: string;
  /** How it started, when that is not already the title. A summary is four
   *  words and a title is not always enough to tell two mornings apart. */
  opening: string;
  /** Where it got to: the last thing said in the transcript. Read from the tail
   *  because "which one was I on" is answered by the end, not the beginning. */
  last: string;
  /** The checkout it ran in — where the resumed session has to start. */
  cwd: string;
  /** Last write to the transcript, ms since epoch. What "3 minutes ago" is. */
  at: number;
  /** Bytes on disk. The CLI's own list shows it, and it is the one honest hint
   *  of how long a conversation is before you open it. */
  size: number;
}

/** How much of a transcript is read to find its first user message. The head
 *  carries a `summary` line, a `user` line and little else; 64 KB is generous
 *  and still a single read. */
const HEAD_BYTES = 64 * 1024;

/** How much of the END is read, for "where it got to". Smaller than the head:
 *  one exchange is all a card shows, and these files are on the hot path of a
 *  menu somebody is waiting on. */
const TAIL_BYTES = 32 * 1024;

/** Newest first, and capped: this is a menu, not an archive. */
const LIMIT = 120;

/**
 * The paths a project's sessions can have run in.
 *
 * Every linked worktree, plus the main checkout. `git worktree list` is the
 * authority — guessing from the directory name (`repo`, `repo-CARD-1`) finds the
 * common case and misses a worktree somebody put elsewhere, which is exactly the
 * one they will be looking for.
 */
async function checkoutsOf(root: string): Promise<string[]> {
  const out = new Set<string>([root]);
  try {
    for (const w of await worktrees(root)) if (w.path) out.add(w.path);
  } catch { /* not a git repo, or git is unavailable: the root alone is honest */ }
  return [...out];
}

/** Text out of one transcript line, whatever shape its content is in. */
function textOf(o: Record<string, unknown>): string {
  const msg = o.message as { content?: unknown } | undefined;
  const c = msg?.content;
  const text = typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text : "")).join(" ")
      : "";
  return text.replace(/\s+/g, " ").trim();
}

/** Is this line worth showing a person? Tool results, hook preambles and slash
 *  commands are the transcript's plumbing, not its conversation. */
function readable(t: string): boolean {
  return !!t && !t.startsWith("<") && !t.startsWith("/") && !t.startsWith("Caveat:");
}

/** The last thing said, from the tail of a transcript. */
function lastFrom(tail: string): string {
  const lines = tail.split("\n");
  // The first line of a tail read is usually half a line; it parses or it does
  // not, and either way the loop below is walking backwards past it.
  for (let i = lines.length - 1; i >= 1; i--) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (o.type !== "assistant" && o.type !== "user") continue;
    const t = textOf(o);
    if (readable(t)) return t.slice(0, 240);
  }
  return "";
}

/** The first user message, ignoring any summary line. This is what the card
 *  shows under a four-word title. */
function openingFrom(head: string): string {
  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (o.type !== "user") continue;
    const t = textOf(o);
    if (readable(t)) return t.slice(0, 240);
  }
  return "";
}

/** The first user message in a transcript's head, as one line. */
function titleFrom(head: string): string {
  for (const line of head.split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    // The CLI's own summary line, when it has written one — that is the text
    // `/resume` shows, so preferring it keeps the two lists reading alike.
    if (o.type === "summary" && typeof o.summary === "string" && o.summary.trim()) {
      return o.summary.trim().slice(0, 200);
    }
    if (o.type !== "user") continue;
    // A slash command or a hook's injected preamble is not what the session was
    // about; keep looking rather than titling forty sessions "/clear".
    const clean = textOf(o);
    if (readable(clean)) return clean.slice(0, 200);
  }
  return "";
}

/**
 * Sessions for this project, newest first.
 *
 * `root` is a repository root; every checkout of it is searched. Paths outside
 * the workspace are refused rather than listed — the same rule the terminal's
 * own frames pass through, because what comes back here becomes a `-c` and a
 * command line.
 */
export async function sessionsForProject(root: string, limit = LIMIT): Promise<AgentSession[]> {
  if (!root || !inScope(root)) return [];
  const projects = join(claudeHome(), "projects");
  if (!existsSync(projects)) return [];
  const rows: AgentSession[] = [];
  for (const cwd of await checkoutsOf(root)) {
    const dir = join(projects, projectSlug(cwd));
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = join(dir, n);
      let st;
      try { st = statSync(file); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue;
      rows.push({ id: n.slice(0, -".jsonl".length), title: "", opening: "", last: "", cwd, at: st.mtimeMs, size: st.size });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  const shown = rows.slice(0, limit);
  // Titles only for what is actually shown. A machine with a thousand
  // transcripts would otherwise pay a read per session to fill a menu of forty.
  await Promise.all(shown.map(async (s) => {
    try {
      const f = Bun.file(join(projects, projectSlug(s.cwd), `${s.id}.jsonl`));
      const head = await f.slice(0, Math.min(HEAD_BYTES, s.size)).text();
      s.title = titleFrom(head);
      const opening = openingFrom(head);
      // Only when it says something the title does not. A card that repeats its
      // own heading in smaller type is two lines of nothing.
      s.opening = opening && opening !== s.title ? opening : "";
      // The tail, for "where did this get to". Skipped on a small file, where
      // the head already covers the whole conversation.
      if (s.size > TAIL_BYTES) s.last = lastFrom(await f.slice(Math.max(0, s.size - TAIL_BYTES), s.size).text());
      else s.last = lastFrom(head);
      if (s.last === s.title || s.last === s.opening) s.last = "";
    } catch { /* unreadable: the row still resumes, it just arrives unnamed */ }
  }));
  return shown;
}
