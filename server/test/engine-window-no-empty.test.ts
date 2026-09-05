/*
 * A session made for a run holds the run, and nothing else.
 *
 * `new-session -d -s x` with no command opens the user's login shell in a
 * window nobody asked for, and the run's window was made one command later —
 * so every session this app created for a run carried a dead shell forever.
 * Nothing closes it: it is not leased, not swept, not named after anything, and
 * it keeps the session alive after the real windows are gone.
 *
 * It was found the way these are found — by looking at a strip. A stray `fish`
 * sat beside the clone's work in `agentglass-understudy`, cwd the project, born
 * at the second the run started, its parent tmux itself. Reproduced on an
 * isolated server: THREE windows for TWO runs.
 *
 * One per session rather than one per run, which is the part worth being
 * precise about — it appears each time the session is recreated, not each time
 * somebody presses a button.
 *
 * The fix is this file's neighbour's answer: `tmuxrestore` has always created
 * the session WITH its first real window, using `new-window` only for the rest.
 * tmux prints `-P -F` ids for `new-session` exactly as it does for
 * `new-window`, and takes `-n` and `-e` on both, so the two argument lists are
 * interchangeable — measured on tmux 3.6a before the code was written.
 *
 * Against a real tmux, isolated on its own socket and TMUX_TMPDIR: a `-L` with
 * the developer's tmpdir lands on the developer's server, and this test counts
 * windows — on his machine it would count HIS.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-noempty-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const { engineWindowRunning, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");

let dir = "";
const have = tmuxCapability().available;

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agx-noempty-")); });
afterAll(async () => {
  // The kill BEFORE the env is put back: restore first and it goes to whichever
  // server the restored socket names, which is his.
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

/** Every window on the server, as `name·command`. */
const windows = async (): Promise<string[]> => {
  const ls = await tmux(["list-windows", "-a", "-F", "#{window_name}·#{pane_current_command}"]);
  return ls.stdout.trim() ? ls.stdout.trim().split("\n") : [];
};

describe("the session a run creates", () => {
  it("has exactly one window, and it is the run", async () => {
    if (!have) return;
    const w = await engineWindowRunning(dir, "orbit-1042", ["sh", "-c", "sleep 30"]);
    expect(w?.paneId).toMatch(/^%\d+$/);
    expect(w?.windowId).toMatch(/^@\d+$/);

    const all = await windows();
    expect(all, `windows: ${all.join(", ")}`).toHaveLength(1);
    expect(all[0]).toStartWith("orbit-1042·");
  });

  it("counts one window per run after that, not one plus one", async () => {
    // The shape that was measured wrong: 3 windows for 2 runs. Two more here,
    // into the session the first one made, so the count is the assertion.
    if (!have) return;
    for (const name of ["orbit-1057", "orbit-1058"]) {
      expect(await engineWindowRunning(dir, name, ["sh", "-c", "sleep 30"]), name).not.toBeNull();
    }
    const all = await windows();
    expect(all, `windows: ${all.join(", ")}`).toHaveLength(3);
  });

  it("leaves no window running a bare login shell", async () => {
    /* The general form, and the one that still bites if somebody adds another
       creation path: every window here was asked for by name, so a window whose
       command is a shell is a window nobody opened. `sh` is what the runs
       above are, so it is the interactive shells that are the tell. */
    if (!have) return;
    for (const w of await windows()) {
      const cmd = w.split("·")[1] ?? "";
      expect(["bash", "fish", "zsh", "dash", "ksh"], `${w} — nobody opened this`).not.toContain(cmd);
    }
  });

  it("still names and places the window the caller asked for", async () => {
    // The creation path is new; everything the caller relies on has to survive
    // it. A dot is a pane separator in a tmux target, so it is stripped.
    if (!have) return;
    await tmux(["kill-server"]);
    const w = await engineWindowRunning(dir, "app.v2", ["sh", "-c", "sleep 30"]);
    expect(w).not.toBeNull();
    const all = await windows();
    expect(all).toHaveLength(1);
    expect(all[0]).toStartWith("app-v2·");
  });

  it("and still passes env to the pane rather than the command line", async () => {
    /* On the session-creating path too. The understudy hands its agent a minted
       credential this way precisely so it stays out of `ps`, and that guarantee
       is not allowed to depend on whether the session already existed. */
    if (!have) return;
    await tmux(["kill-server"]);
    const out = join(dir, "env.txt");
    const w = await engineWindowRunning(
      dir, "orbit-1077",
      ["sh", "-c", `printf %s "$AGX_PROBE" > ${out}; sleep 30`],
      dir, { AGX_PROBE: "reached-the-pane" },
    );
    expect(w).not.toBeNull();
    for (let i = 0; i < 50 && !(await Bun.file(out).exists()); i++) await Bun.sleep(20);
    expect(await Bun.file(out).text()).toBe("reached-the-pane");
  });
});
