/*
 * The bench, on the server side: a session per tab, and a note per checkout.
 *
 * Two things are pinned here and both are the kind that fail quietly.
 *
 * The SESSION NAME, because the failure it prevents has already happened twice
 * in this app: two clients attached to one tmux session mirror each other, so a
 * bench tab sharing a name with the terminal view — or with another bench tab —
 * would show that session's screen and fight it for the size. On this machine
 * that has meant real work being resized under somebody's hands.
 *
 * The NOTE'S HOME, because the obvious place is inside the checkout, and an
 * untracked file in somebody's repository ends up in `git add -A` and then in a
 * commit nobody meant to make.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineAttachArgv, engineBenchArgv, engineConsoleArgv, engineSessionName, benchSessionName } from "../src/tmuxpane.ts";

const ROOT0 = process.env.AGENTGLASS_ROOT;
const NOTES0 = process.env.AGENTGLASS_BENCH_NOTES;

let box: string;
let repo: string;
let notes: string;

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), "agx-bench-"));
  repo = join(box, "orbit");
  rmSync(repo, { recursive: true, force: true });
  Bun.spawnSync(["mkdir", "-p", join(repo, "src")]);
  notes = join(box, "notes-home");
  process.env.AGENTGLASS_ROOT = box;
  process.env.AGENTGLASS_BENCH_NOTES = notes;
});

afterAll(() => {
  if (ROOT0 === undefined) delete process.env.AGENTGLASS_ROOT; else process.env.AGENTGLASS_ROOT = ROOT0;
  if (NOTES0 === undefined) delete process.env.AGENTGLASS_BENCH_NOTES; else process.env.AGENTGLASS_BENCH_NOTES = NOTES0;
  rmSync(box, { recursive: true, force: true });
});

/** Lazy, like every other suite that moves the scope: config.ts settles the
 *  workspace on first read, and the env has to be set before that happens. */
const bench = async () => await import("../src/bench.ts");

describe("a tab is a session of its own", () => {
  it("is not the terminal view's session, and not the console's", () => {
    const desk = engineAttachArgv("/home/someone/code/orbit");
    const con = engineConsoleArgv("/home/someone/code/orbit");
    const tab = engineBenchArgv("/home/someone/code/orbit", 1);
    if (!desk || !con || !tab) return; // no tmux here — nothing to compare
    expect(tab).not.toEqual(desk);
    expect(tab).not.toEqual(con);
    expect(tab.join(" ")).toContain(`${engineSessionName("/home/someone/code/orbit")}-bench1`);
  });

  it("gives each tab its own name, and each checkout its own space", () => {
    expect(benchSessionName("/a/orbit", 1)).not.toBe(benchSessionName("/a/orbit", 2));
    expect(benchSessionName("/a/orbit", 1)).not.toBe(benchSessionName("/b/atlas", 1));
    // The name the argv builds is the name the reads look for. Two spellings of
    // it is how "3 open" ends up pointing at nothing.
    const tab = engineBenchArgv("/a/orbit", 3);
    if (tab) expect(tab).toContain(benchSessionName("/a/orbit", 3));
  });

  it("clamps the slot, because it arrives from a client", () => {
    expect(benchSessionName("/a/orbit", 0)).toBe(benchSessionName("/a/orbit", 1));
    expect(benchSessionName("/a/orbit", 1e9)).toBe(benchSessionName("/a/orbit", 99));
    expect(benchSessionName("/a/orbit", -4)).toBe(benchSessionName("/a/orbit", 1));
  });

  it("keeps every flag the terminal's attach uses, and adds the command", () => {
    const desk = engineAttachArgv("/home/someone/code/orbit");
    const tab = engineBenchArgv("/home/someone/code/orbit", 2, ["nvim", "-R", "/tmp/x.py"]);
    if (!desk || !tab) return;
    expect(tab).toContain("-L");
    expect(tab).toContain("-f");
    expect(tab).toContain("-A");
    // The command is argv, handed to tmux — never a string for a shell to
    // reinterpret. That is what lets a path with a space in it be a path.
    expect(tab.slice(-3)).toEqual(["nvim", "-R", "/tmp/x.py"]);
  });

  it("answers null exactly when the terminal's attach does", () => {
    for (const root of ["", "/home/someone/code/orbit", "/tmp"]) {
      expect(engineBenchArgv(root, 1) === null, root).toBe(engineAttachArgv(root) === null);
    }
  });
});

describe("the note belongs to the checkout, and lives outside it", () => {
  it("writes nothing inside the repository", async () => {
    const b = await bench();
    const w = b.writeNote(repo, "# what I found\n- the agent stays busy\n");
    expect(w.ok).toBe(true);

    // The whole point: nothing new in the checkout for git to notice.
    expect(existsSync(join(repo, "NOTES.md"))).toBe(false);
    expect(b.notePath(repo).startsWith(notes)).toBe(true);
    expect(readFileSync(b.notePath(repo), "utf8")).toContain("stays busy");
  });

  it("is owner-only, because it is somebody's working thinking", async () => {
    const b = await bench();
    b.writeNote(repo, "private");
    expect(statSync(b.notePath(repo)).mode & 0o777).toBe(0o600);
  });

  it("comes back for the same checkout and not for another", async () => {
    const b = await bench();
    const other = join(box, "atlas");
    Bun.spawnSync(["mkdir", "-p", other]);
    b.writeNote(repo, "orbit only");
    expect(b.readNote(repo).text).toBe("orbit only");
    expect(b.readNote(other).text).toBe("");
  });

  it("an empty note removes the file rather than leaving a blank one", async () => {
    const b = await bench();
    b.writeNote(repo, "something");
    b.writeNote(repo, "   \n ");
    expect(existsSync(b.notePath(repo))).toBe(false);
    expect(b.readNote(repo).ok).toBe(true);
  });

  it("no note yet is an empty page, not an error", async () => {
    const b = await bench();
    const fresh = join(box, "fresh");
    Bun.spawnSync(["mkdir", "-p", fresh]);
    const r = b.readNote(fresh);
    expect(r.ok).toBe(true);
    expect(r.text).toBe("");
  });

  it("refuses a checkout outside the open project", async () => {
    const b = await bench();
    const outside = mkdtempSync(join(tmpdir(), "agx-elsewhere-"));
    try {
      expect(b.writeNote(outside, "no").ok).toBe(false);
      expect(b.readNote(outside).error).toContain("outside");
      expect(b.readNote("/etc").ok).toBe(false);
      // A note for something that is not a directory is not a note.
      expect(b.writeNote(join(repo, "src", "nope.py"), "x").ok).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it("takes text and nothing else, and caps how much", async () => {
    const b = await bench();
    expect(b.writeNote(repo, { evil: true }).ok).toBe(false);
    const huge = "x".repeat(400 * 1024);
    expect(b.writeNote(repo, huge).text.length).toBe(256 * 1024);
  });

  it("two checkouts whose folder names match keep separate notes", async () => {
    const b = await bench();
    const a = join(box, "one", "orbit");
    const c = join(box, "two", "orbit");
    Bun.spawnSync(["mkdir", "-p", a]);
    Bun.spawnSync(["mkdir", "-p", c]);
    b.writeNote(a, "first");
    b.writeNote(c, "second");
    expect(b.notePath(a)).not.toBe(b.notePath(c));
    expect(b.readNote(a).text).toBe("first");
    expect(b.readNote(c).text).toBe("second");
  });
});

describe("one editor per checkout, and what it may open", () => {
  it("derives the socket from the checkout, not from the pane that asked", async () => {
    const b = await bench();
    // Same checkout, same socket — twice, minutes apart, from different panes.
    expect(b.readerSocketPath(repo)).toBe(b.readerSocketPath(repo));
    // Different checkouts never share an editor: one nvim holding two
    // worktrees' buffers is one `:w` away from writing to the wrong branch.
    expect(b.readerSocketPath(repo)).not.toBe(b.readerSocketPath(box));
  });

  it("the client and the server agree on which session the editor is", async () => {
    const b = await bench();
    const web = await Bun.file(new URL("../../web/src/lib/benchStore.ts", import.meta.url)).text();
    // Two numbers that must be one. If they drift, file tabs attach to a
    // session nobody is editing in and every file opens a second editor.
    expect(web).toContain(`export const READER_SLOT = ${b.BENCH_READER_SLOT};`);
  });

  it("refuses a file it has no business opening", async () => {
    const b = await bench();
    expect((await b.benchEdit(repo, "/etc/shadow", 1, true)).ok).toBe(false);
    expect((await b.benchEdit(repo, join(repo, "src"), 1, true)).error).toContain("not a file");
    expect((await b.benchEdit(repo, join(repo, "nope.py"), 1, true)).error).toContain("no such file");
    expect((await b.benchEdit("/etc", join(repo, "src", "a.py"), 1, true)).ok).toBe(false);
  });

  it("the file's name never enters a keystroke string", async () => {
    /*
     * An `:e` argument is a command line — backticks run a shell, `|` ends the
     * command — and the old single `--remote-send` put the path inside one with
     * only spaces escaped. Measured on a private headless nvim: opening
     * x`touch probe`.md created `probe` in the editor's cwd. So the property
     * pinned here is structural: the path is its own argv element after
     * `--remote`, and no `--remote-send` string contains it.
     */
    const b = await bench();
    const nasty = join(repo, "src", "x`touch probe`|!id>owned #%$~{}.md");
    const steps = b.benchEditArgv("/tmp/agx-bench-x.sock", nasty, 42, true);
    expect(steps).toHaveLength(2);
    const [open, keys] = steps;
    expect(open).toEqual(["nvim", "--server", "/tmp/agx-bench-x.sock", "--remote", nasty]);
    const sent = keys!.indexOf("--remote-send");
    expect(sent).toBeGreaterThan(0);
    const text = keys![sent + 1]!;
    expect(text).not.toContain("touch");
    expect(text).not.toContain(nasty);
    expect(text).not.toContain("/");
    /* And the two things the keystrokes ARE for still arrive. */
    expect(text).toContain("<Cmd>setl readonly nomodifiable<CR>");
    expect(text).toContain("<Cmd>42<CR>zt");
    expect(b.benchEditArgv("/s", nasty, 0, false)[1]![4]).toBe("<Esc><Cmd>setl noreadonly modifiable<CR>");
  });

  it("opens the file, by that name, in a real editor — and runs nothing", async () => {
    /*
     * The structural check above cannot see whether `--remote` does what the
     * comment says, so this drives a headless nvim of its own on a socket of
     * its own, with an XDG home of its own — never the person's editor. Skipped
     * where there is no nvim; the argv test above still holds the property.
     */
    if (!Bun.which("nvim")) return;
    const home = join(box, "nvim-home");
    Bun.spawnSync(["mkdir", "-p", home, join(repo, "src")]);
    const file = join(repo, "src", "x`touch probe`.md");
    Bun.spawnSync(["bash", "-c", `echo 'hello' > "$1"`, "_", file]);
    const b = await bench();
    const sock = b.readerSocketPath(repo);
    const ed = Bun.spawn(["nvim", "--headless", "--clean", "--listen", sock], {
      cwd: home, stdout: "ignore", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home },
    });
    try {
      for (let i = 0; i < 50 && !existsSync(sock); i++) await Bun.sleep(100);
      expect(existsSync(sock), "the probe editor never listened").toBe(true);
      const r = await b.benchEdit(repo, file, 1, true);
      expect(r).toEqual({ ok: true, live: true });
      const expr = (e: string) => Bun.spawnSync(["nvim", "--server", sock, "--remote-expr", e]).stdout.toString().trim();
      expect(expr('expand("%:t")')).toBe("x`touch probe`.md");
      expect(expr("&readonly")).toBe("1");
      expect(existsSync(join(home, "probe")), "the filename ran a shell in the editor").toBe(false);
      expect(existsSync(join(repo, "src", "probe"))).toBe(false);
    } finally {
      Bun.spawnSync(["nvim", "--server", sock, "--remote-send", "<Cmd>qa!<CR>"]);
      try { ed.kill(); } catch { /* gone */ }
      await ed.exited;
    }
  });

  it("no editor yet is an answer, not a failure", async () => {
    const b = await bench();
    const file = join(repo, "src", "a.py");
    Bun.spawnSync(["bash", "-lc", `echo 'x = 1' > ${JSON.stringify(file)}`]);
    const r = await b.benchEdit(repo, file, 12, false);
    // Nothing is spawned by asking: an editor started here would have no
    // terminal attached and nobody would ever see it. The caller answers a
    // dead socket by connecting a tab, which starts one with this file.
    expect(r.ok).toBe(true);
    expect(r.live).toBe(false);
  });
});
