/*
 * The floating bench's own state: its notes, and what of it is still running.
 *
 * The tabs themselves need nothing here — each is a WINDOW of the checkout's
 * one engine session (see engineBenchArgv), which is what makes them survive
 * the window, the app and the reboot. Two things do not fit in a tmux window,
 * and they are what this file is:
 *
 *   the note      "what I just found out about this branch". It belongs to a
 *                 CHECKOUT and to nothing else.
 *   what is live  which bench windows this checkout still has, so the window
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
import { failed } from "./refused.ts";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeAbs } from "./git.ts";
import { inScopeReal } from "./config.ts";
import { diskAllows } from "./disk.ts";
import { isViewTemp } from "./viewtemp.ts";
import { benchWindowName, engineSessionName, tmux, tmuxSync } from "./tmuxpane.ts";

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
  if (!inScopeReal(root)) return { error: "outside the open project" };
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

/** The command that edits this checkout's note in Neovim, or null with no
 *  nvim on the PATH. The client never sends a path: it says "the note" and the
 *  file is the one `writeNote` saves to, so both editors touch the same bytes.
 *  The folder is made here because nvim will not create a missing directory
 *  and a checkout nobody has written about has none yet. */
export function noteNvimArgv(root: string): string[] | null {
  const nvim = Bun.which("nvim");
  if (!nvim) return null;
  const file = notePath(root);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // The file exists before nvim opens it, and nvim writes it on every
    // change with no swap file. Restarting the app killed nvim mid-edit: the
    // text lived only in the swap, and the next open stopped on E325
    // ATTENTION over a note that "CANNOT BE FOUND". The textarea saves as you
    // type, so this is the same promise from the other editor.
    writeFileSync(file, "", { flag: "a", mode: 0o600 });
  } catch { return null; }
  return [nvim, "-n", "-c", "autocmd TextChanged,TextChangedI,InsertLeave <buffer> silent! update", file];
}

export interface NoteReport { ok: boolean; text: string; at?: number; error?: string; nvim?: boolean }

export function readNote(rootIn: unknown): NoteReport {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, text: "", error: at.error };
  return { ...readNoteText(at.root), nvim: !!Bun.which("nvim") };
}

function readNoteText(root: string): NoteReport {
  const file = notePath(root);
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
    return { ok: false, text: "", error: failed("bench/note", e, "the note could not be saved") };
  }
}

export interface BenchLive {
  ok: boolean;
  /** The slot numbers with a window still on the engine. */
  slots: number[];
  error?: string;
}

/** A window of the engine session, with whether every pane in it is dead. */
interface BenchWindow { id: string; name: string; dead: boolean }

/** Grouped from one `list-panes -s`: a window is dead only when every pane in
 *  it is, and a bench tab is one pane, so the two answers never disagree. */
function windowRowsFrom(out: string): BenchWindow[] {
  const by = new Map<string, BenchWindow>();
  for (const line of out.split("\n")) {
    const [id = "", name = "", dead = ""] = line.split("\t");
    if (!id.startsWith("@")) continue;
    const row = by.get(id) ?? { id, name, dead: true };
    row.dead = row.dead && dead === "1";
    by.set(id, row);
  }
  return [...by.values()];
}

const WINDOWS_FORMAT = "#{window_id}\t#{window_name}\t#{pane_dead}";

/**
 * Every window of this checkout's engine session, by exact name.
 *
 * Asked of tmux rather than remembered here, because the truth is over there:
 * a window ends when its command exits, and a panel that believed its own
 * bookkeeping would offer you tabs that are no longer anything. Nothing is
 * created by asking. The engine session is the ONE session of the checkout —
 * the console and every bench tab are windows in it, see enginePanelArgv.
 */
async function engineWindows(root: string): Promise<BenchWindow[]> {
  const r = await tmux(["list-panes", "-s", "-t", `=${engineSessionName(root)}:`, "-F", WINDOWS_FORMAT]);
  return r.ok ? windowRowsFrom(r.stdout) : [];
}

/** The same read for the one caller that cannot await — see readerSessionState. */
function engineWindowsSync(root: string): BenchWindow[] {
  const r = tmuxSync(["list-panes", "-s", "-t", `=${engineSessionName(root)}:`, "-F", WINDOWS_FORMAT]);
  return r.ok ? windowRowsFrom(r.stdout) : [];
}

/**
 * End a bench tab's window — what closing the Lantern's tab does.
 *
 * A bench tab ordinarily forgets its tab and leaves the window running: that
 * is the feature, a shell or an agent that survives the window. The Lantern's
 * chat is the one tab where that is wrong — an observer nobody is looking at
 * is a Claude sitting in tmux, invisible, showing on the very board it was
 * opened to read, long after the session was closed. So its close ends the
 * window, and this is the verb.
 */
export async function benchEnd(rootIn: unknown, slotIn: unknown): Promise<{ ok: boolean; error?: string; ended?: boolean }> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, error: at.error };
  const slot = Math.floor(Number(slotIn));
  if (!Number.isFinite(slot) || slot < 1 || slot > 99) return { ok: false, error: "no such slot" };
  /* By ID, never by name: tmux matches a window name by prefix, so
     `kill-window -t bench-1` would close `bench-19` on a busy day. */
  const w = (await engineWindows(at.root)).find((x) => x.name === benchWindowName(slot));
  if (!w) return { ok: true, ended: false };
  const r = await tmux(["kill-window", "-t", w.id]);
  return { ok: true, ended: r.ok };
}

export async function benchLive(rootIn: unknown): Promise<BenchLive> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, slots: [], error: at.error };
  /* No engine session is not a failure: it means nothing is live, which is a
     perfectly good answer to this question. */
  const windows = new Map((await engineWindows(at.root)).map((w) => [w.name, w]));
  const slots: number[] = [];
  for (let n = 1; n <= 99; n++) {
    if (n === FINDER_EDIT_SLOT) continue; // the Finder's own editor is not a tab of the bench
    const w = windows.get(benchWindowName(n));
    if (!w) continue;
    /* A window whose command has died is not live, and is closed here so the
       next open starts the command again. An attach reattaches to whatever
       holds the name, corpse included, and would report it live for as long
       as it stood. */
    if (w.dead) { await tmux(["kill-window", "-t", w.id]); continue; }
    slots.push(n);
  }
  return { ok: true, slots };
}

/* ------------------------------------------------------------- the reader */

/**
 * One editor for the files, not one per file.
 *
 * Every file tab of a checkout shares a single window running one nvim,
 * and that is the difference between a viewer and an editor you work in: the
 * buffers accumulate, `:b#` jumps between the two files you are comparing, the
 * jumplist survives leaving the app for the terminal, and the second file opens
 * in the time it takes to type `:e` rather than the time it takes to start
 * neovim with your plugins.
 *
 * The socket is DERIVED from the checkout rather than minted per pane. It has
 * to be: the window outlives the socket that created it, so the next request
 * to open a file has to find the same editor without having been the one to
 * start it. Ours because we hand it to `--listen`; the client never sees it and
 * could not name it — see editorwhere.ts for the same rule at pane scope.
 */
export const BENCH_READER_SLOT = 90;

/**
 * The slot of the nvim the Finder's Editing tab shows inside its own preview.
 *
 * Not a bench tab: the Finder starts it when Editing is chosen and ends it
 * (its `bench-89` window) when Editing is left, so it is never offered to the
 * bench window, and `benchLive` leaves it out. Its own socket, because the
 * reader's is derived from the checkout and two editors cannot listen on one.
 */
export const FINDER_EDIT_SLOT = 89;

export function finderEditSocketPath(root: string): string {
  const hash = createHash("sha1").update(safeAbs(root) ?? root).digest("hex").slice(0, 12);
  return join(tmpdir(), `agx-finder-edit-${hash}.sock`);
}

export interface FinderEditState { ok: boolean; live: boolean; modified: boolean; error?: string }

/** The argv that asks the Finder's nvim how many buffers hold unsaved changes. A constant: nothing from the client reaches it. */
export const finderModifiedArgv = (sock: string): string[] =>
  ["nvim", "--server", sock, "--remote-expr", "len(filter(getbufinfo(), {_, b -> b.changed}))"];

/** The keys that write every changed buffer: constants, so nothing typed by a client ever becomes a keystroke. */
export const FINDER_SAVE_KEYS = "<Esc><Cmd>wa<CR>";

/** Write every changed buffer of the Finder's editor, then say whether any is still unsaved. */
export async function finderEditSave(rootIn: unknown): Promise<FinderEditState> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, live: false, modified: false, error: at.error };
  const sock = finderEditSocketPath(at.root);
  try {
    const proc = Bun.spawn(["nvim", "--server", sock, "--remote-send", FINDER_SAVE_KEYS], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 2000);
    await proc.exited; clearTimeout(kill);
  } catch { /* the state below says what is left */ }
  await Bun.sleep(150);
  return finderEditState(rootIn);
}

/** The keys that quit nvim without writing: constants. Asked of nvim itself so it removes its own swap file, which a bare kill-window leaves behind (and the next open then warns about). */
export const FINDER_QUIT_KEYS = "<Esc><Cmd>qa!<CR>";

/**
 * End the Finder's editor: nvim quits itself, then whatever is left of its
 * window is ended, so nothing outlives the tab. Callers have already
 * asked about unsaved changes; this one does not.
 */
export async function finderEditEnd(rootIn: unknown): Promise<{ ok: boolean; ended?: boolean; error?: string }> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, error: at.error };
  const sock = finderEditSocketPath(at.root);
  try {
    statSync(sock);
    const proc = Bun.spawn(["nvim", "--server", sock, "--remote-send", FINDER_QUIT_KEYS], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 1500);
    await proc.exited; clearTimeout(kill);
    await Bun.sleep(150);
  } catch { /* no socket: no editor to ask */ }
  return benchEnd(at.root, FINDER_EDIT_SLOT);
}

/** Is the Finder's editor running, and has it unsaved changes? `live: false` is "no editor", not a failure. */
export async function finderEditState(rootIn: unknown): Promise<FinderEditState> {
  const at = checkout(rootIn);
  if ("error" in at) return { ok: false, live: false, modified: false, error: at.error };
  const sock = finderEditSocketPath(at.root);
  try { statSync(sock); } catch { return { ok: true, live: false, modified: false }; }
  try {
    const proc = Bun.spawn(finderModifiedArgv(sock), { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 2000);
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    clearTimeout(kill);
    // A socket left by an editor that died answers nothing: that is "no editor".
    if (code !== 0 || !/^\d+$/.test(out)) return { ok: true, live: false, modified: false };
    return { ok: true, live: true, modified: Number(out) > 0 };
  } catch {
    return { ok: true, live: false, modified: false };
  }
}

export function readerSocketPath(root: string): string {
  const hash = createHash("sha1").update(safeAbs(root) ?? root).digest("hex").slice(0, 12);
  return join(tmpdir(), `agx-bench-${hash}.sock`);
}

/**
 * What the reader's window of this checkout is, before anything attaches to it.
 *
 * - `none`: there is no window; the next open creates one with the editor.
 * - `editor`: a live pane started with a command — the editor this server
 *   started. Attaching to it is the whole point of the reader.
 * - `other`: a window that is NOT the editor, and that nothing will ever turn
 *   into one. An attach reattaches to whatever holds the name and ignores the
 *   command, so a reader that began as a plain shell (its first file was gone,
 *   or refused) stayed a shell for every file opened after it, and
 *   `/bench/edit` had no editor socket to reach. Measured on an isolated
 *   server: "Edit in nvim" on a valid file showed the checkout's prompt,
 *   indefinitely. A dead pane is the same case — the engine keeps a pane whose
 *   command failed.
 *
 * A shell's pane has an empty start command; the editor's is its argv. That is
 * the test, and not the editor socket, so an editor that takes no `--listen`
 * (vim) is still recognised and not restarted on every attach.
 */
export function readerSessionState(root: string): "none" | "editor" | "other" {
  const name = benchWindowName(BENCH_READER_SLOT);
  const r = tmuxSync(["list-panes", "-s", "-t", `=${engineSessionName(root)}:`, "-F", "#{window_name}\t#{pane_dead}\t#{pane_start_command}"]);
  if (!r.ok) return "none";
  const panes = r.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")).filter(([w]) => w === name);
  if (!panes.length) return "none";
  return panes.some(([, dead, ...cmd]) => dead !== "1" && !!cmd.join("\t").trim()) ? "editor" : "other";
}

/** End the reader's window, synchronously — see readerSessionState. */
export function endReaderSession(root: string): boolean {
  const w = engineWindowsSync(root).find((x) => x.name === benchWindowName(BENCH_READER_SLOT));
  if (!w) return false;
  return tmuxSync(["kill-window", "-t", w.id]).ok;
}

/** A path the bench may open: in the project, in your home (the machine tab's
 *  rule), or one of the read-only copies this server itself wrote for a pull
 *  request or a ref. Anything else is refused before it reaches an editor. */
function openable(pathIn: unknown): { abs: string } | { error: string } {
  const abs = safeAbs(pathIn);
  if (!abs) return { error: "no file given" };
  try { if (!statSync(abs).isFile()) return { error: "not a file" }; }
  catch { return { error: "no such file" }; }
  if (!inScopeReal(abs) && !diskAllows(abs) && !isViewTemp(abs)) return { error: "outside what the bench may open" };
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
