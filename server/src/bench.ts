/*
 * The floating bench's own state: its notes, and what of it is still running.
 *
 * The tabs themselves need nothing here — each is a tmux session on the engine
 * (see engineBenchArgv), which is what makes them survive the window, the app
 * and the reboot. Two things do not fit in a tmux session, and they are what
 * this file is:
 *
 *   the note      "what I just found out about this branch". It belongs to a
 *                 CHECKOUT and to nothing else.
 *   what is live  which bench sessions this checkout still has, so the window
 *                 can say "3 open" about a worktree you are not looking at
 *                 rather than quietly losing them.
 *
 * On where a note is kept, because the obvious answer is wrong: NOT a file in
 * the checkout. An untracked file in somebody's repository turns up in their
 * status, in `git add -A`, and eventually in a commit nobody meant to make —
 * this app has already been bitten by notes-in-the-repo once and the rule that
 * came out of it was "work notes live outside the repository". So it goes in
 * the app's own data directory, keyed by the checkout's path.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeAbs } from "./git.ts";
import { inScope } from "./config.ts";
import { diskAllows } from "./disk.ts";
import { isViewTemp } from "./viewtemp.ts";
import { benchSessionName, tmux } from "./tmuxpane.ts";

/** Big enough for a page of notes, small enough that this is not a file store:
 *  the thing being written is a paragraph you will read tomorrow. */
const MAX_NOTE = 256 * 1024;

/** Where the notes live. Its own directory under the app's data dir, so
 *  deleting notes is deleting one folder rather than picking rows out of a
 *  database that also holds a month of telemetry. */
function notesDir(): string {
  return join(
    process.env.AGENTGLASS_BENCH_NOTES
      ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentglass"),
    "bench-notes",
  );
}

/**
 * A checkout, or a refusal.
 *
 * Same rule as everything else that takes a path from a client: resolved
 * first, then checked against the open project. A note is written to disk, so
 * "which directory" is not a label — it decides the filename.
 */
function checkout(rootIn: unknown): { root: string } | { error: string } {
  const root = safeAbs(rootIn);
  if (!root) return { error: "no checkout given" };
  try { if (!statSync(root).isDirectory()) return { error: "not a directory" }; }
  catch { return { error: "no such directory" }; }
  if (!inScope(root)) return { error: "outside the open project" };
  return { root };
}

/** The note's file. The path is hashed rather than flattened: two worktrees can
 *  differ only in a character a filename would not keep, and a note that
 *  silently belongs to the wrong branch is worse than no note. The readable
 *  half is kept as a prefix so the folder can be browsed by a human. */
export function notePath(root: string): string {
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 12);
  const name = (root.split("/").filter(Boolean).pop() ?? "checkout").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);
  return join(notesDir(), `${name}-${hash}.md`);
}

export interface NoteReport { ok: boolean; text: string; at?: number; error?: string }

export function readNote(rootIn: unknown): NoteReport {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, text: "", error: at.error };
  const file = notePath(at.root);
  try {
    const text = readFileSync(file, "utf8");
    return { ok: true, text: text.slice(0, MAX_NOTE), at: statSync(file).mtimeMs };
  } catch {
    // No note yet is not an error: it is the normal state of a checkout nobody
    // has written about, and the client should get an empty page rather than a
    // red line.
    return { ok: true, text: "" };
  }
}

export function writeNote(rootIn: unknown, textIn: unknown): NoteReport {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, text: "", error: at.error };
  if (typeof textIn !== "string") return { ok: false, text: "", error: "a note is text" };
  const text = textIn.slice(0, MAX_NOTE);
  const file = notePath(at.root);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    /* 0600, like every other file this app writes that is nobody else's
       business. A note about a branch is somebody's working thinking. */
    if (!text.trim()) { rmSync(file, { force: true }); return { ok: true, text: "" }; }
    writeFileSync(file, text, { mode: 0o600 });
    return { ok: true, text, at: Date.now() };
  } catch (e) {
    return { ok: false, text: "", error: String(e) };
  }
}

export interface BenchLive {
  ok: boolean;
  /** The slot numbers with a session still on the engine. */
  slots: number[];
  error?: string;
}

/**
 * Which of this checkout's bench tabs are still running.
 *
 * Asked of tmux rather than remembered here, because the truth is over there:
 * a session ends when its command exits, and a window that believed its own
 * bookkeeping would offer you tabs that are no longer anything. Nothing is
 * created by asking.
 */
/**
 * End a bench slot's session — what closing the Lantern's tab does.
 *
 * A bench tab ordinarily forgets its tab and leaves the session running:
 * that is the feature, a shell or an agent that survives the window. The
 * Lantern's chat is the one tab where that is wrong — an observer nobody is
 * looking at is a Claude sitting in tmux, invisible, showing on the very
 * board it was opened to read ("But I had closed that session"). So its
 * close ends the session, and this is the verb.
 */
export async function benchEnd(rootIn: unknown, slotIn: unknown): Promise<{ ok: boolean; error?: string; ended?: boolean }> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, error: at.error };
  const slot = Math.floor(Number(slotIn));
  if (!Number.isFinite(slot) || slot < 1 || slot > 99) return { ok: false, error: "no such slot" };
  const r = await tmux(["kill-session", "-t", `=${benchSessionName(at.root, slot)}`]);
  return { ok: true, ended: r.ok };
}

export async function benchLive(rootIn: unknown): Promise<BenchLive> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, slots: [], error: at.error };
  const r = await tmux(["list-sessions", "-F", "#{session_name}"]);
  // No server running is not a failure: it means nothing is live, which is a
  // perfectly good answer to this question.
  if (!r.ok) return { ok: true, slots: [] };
  const names = new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  const slots: number[] = [];
  for (let n = 1; n <= 99; n++) if (names.has(benchSessionName(at.root, n))) slots.push(n);
  return { ok: true, slots };
}

/* ------------------------------------------------------------- the reader */

/**
 * One editor for the files, not one per file.
 *
 * Every file tab of a checkout shares a single tmux session running one nvim,
 * and that is the difference between a viewer and an editor you work in: the
 * buffers accumulate, `:b#` jumps between the two files you are comparing, the
 * jumplist survives leaving the app for the terminal, and the second file opens
 * in the time it takes to type `:e` rather than the time it takes to start
 * neovim with your plugins.
 *
 * The socket is DERIVED from the checkout rather than minted per pane. It has
 * to be: the session outlives the socket that created it, so the next request
 * to open a file has to find the same editor without having been the one to
 * start it. Ours because we hand it to `--listen`; the client never sees it and
 * could not name it — see editorwhere.ts for the same rule at pane scope.
 */
export const BENCH_READER_SLOT = 90;

export function readerSocketPath(root: string): string {
  const hash = createHash("sha1").update(safeAbs(root) ?? root).digest("hex").slice(0, 12);
  return join(tmpdir(), `agx-bench-${hash}.sock`);
}

/** A path the bench may open: in the project, in your home (the machine tab's
 *  rule), or one of the read-only copies this server itself wrote for a pull
 *  request or a ref. Anything else is refused before it reaches an editor. */
function openable(pathIn: unknown): { abs: string } | { error: string } {
  const abs = safeAbs(pathIn);
  if (!abs) return { error: "no file given" };
  try { if (!statSync(abs).isFile()) return { error: "not a file" }; }
  catch { return { error: "no such file" }; }
  if (!inScope(abs) && !diskAllows(abs) && !isViewTemp(abs)) return { error: "outside what the bench may open" };
  return { abs };
}

export interface BenchEdit { ok: boolean; live: boolean; error?: string }

/**
 * Put this file in front of you in the checkout's editor.
 *
 * `live: false` is not a failure — it is "there is no editor yet", and the
 * caller answers it by connecting a tab, which starts one with this file. That
 * split is why this never spawns anything itself: an editor started here would
 * have no terminal attached to it and nobody would ever see it.
 */
export async function benchEdit(rootIn: unknown, pathIn: unknown, lineIn: unknown, readonlyIn: unknown): Promise<BenchEdit> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, live: false, error: at.error };
  const file = openable(pathIn);
  if ("error" in file) return { ok: false, live: false, error: file.error };
  const line = Math.min(Math.max(Math.floor(Number(lineIn) || 0), 0), 10_000_000);
  const sock = readerSocketPath(at.root);
  try { if (!statSync(sock)) return { ok: true, live: false }; } catch { return { ok: true, live: false }; }

  const steps = benchEditArgv(sock, file.abs, line, !!readonlyIn);
  try {
    for (const argv of steps) {
      const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      const kill = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 2000);
      const code = await proc.exited;
      clearTimeout(kill);
      // A socket left behind by an editor that died accepts and never answers;
      // that comes back non-zero here and is reported as "no editor yet", which
      // is the state the caller can actually do something about. The first
      // step failing also means the second is not sent: keys typed into an
      // editor that did not open the file would land in whatever buffer it has.
      if (code !== 0) return { ok: true, live: false };
    }
    return { ok: true, live: true };
  } catch {
    return { ok: true, live: false };
  }
}

/**
 * The two commands that put a file in front of you, and why it is two.
 *
 * It was one: a single `--remote-send` typing `<Cmd>e <path><CR>` and the rest
 * into the running editor. The path was escaped for spaces and nothing else,
 * and an `:e` argument is a command line: backticks in it run a shell, `|`
 * ends the command and starts the next. Measured on a private headless nvim
 * (0.11, `--clean`): opening a file named x`touch probe`.md through that
 * string created `probe` in the editor's working directory and left the
 * buffer called `x.md`; opening x|!cmd.md left the buffer called `x` with the
 * rest handed to `:!`. Every file the bench may open is one the checkout or a
 * pull request put on disk, so the name is the attacker's.
 *
 * So the path never enters a keystroke string again. It goes to `--remote`,
 * where it is ONE ARGV ELEMENT: nvim receives it as a string, runs
 * `fnameescape()` on it itself and hands the result to `:drop`, which reuses
 * the buffer if it is already open — the same thing `:e` was here for. The
 * argv route cannot be escaped wrongly because nothing here escapes it.
 *
 * What `--remote` cannot do is the rest: the line, and the read-only flag for
 * a copy of a commit. Those still go by `--remote-send`, in a SECOND call that
 * carries no caller-controlled text at all — a number and two option names.
 * Two round trips on a local socket, measured, are not visible; one keystroke
 * string with a filename in it is a hole.
 *
 * `<Cmd>` rather than `:`, measured on screen: a colon command is echoed and
 * the last one sits in the command line under the file you came to read —
 * ":setl noreadonly modifiable" is not a thing anybody asked to be told.
 * `zt` puts the line at the TOP of the window rather than wherever it landed,
 * the same jump the pane rail sends.
 *
 * Exported so the test can hold the argv up to the light rather than needing
 * an editor: the property is "the path is its own argv element and appears in
 * no `--remote-send` string", and that is true or false of the arrays.
 */
export function benchEditArgv(sock: string, abs: string, line: number, readonly: boolean): string[][] {
  const keys = [
    "<Esc>",
    readonly ? "<Cmd>setl readonly nomodifiable<CR>" : "<Cmd>setl noreadonly modifiable<CR>",
    line > 1 ? `<Cmd>${Math.floor(line)}<CR>zt` : "",
  ].join("");
  return [
    ["nvim", "--server", sock, "--remote", abs],
    ["nvim", "--server", sock, "--remote-send", keys],
  ];
}
