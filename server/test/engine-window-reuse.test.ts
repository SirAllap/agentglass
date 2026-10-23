/*
 * "Hand to Claude in a terminal" twice on the same pull request.
 *
 * The first press opens a window named after the pull request and Claude works
 * in it. The panel then offered the same button again, and a second press
 * started a SECOND Claude on the same merge in the same checkout. A window name
 * the app chose itself is a name it can look for first.
 *
 * Against a real tmux on a socket of its own: what matters is what tmux really
 * answers to a name, and tmux matches window names by PREFIX unless told not to.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const SOCKET = `agx-enginereuse-${process.pid}`;
const REAL_SOCKET = process.env.AGENTGLASS_TMUX_SOCKET;
const REAL_TMPDIR = process.env.TMUX_TMPDIR;
process.env.AGENTGLASS_TMUX_SOCKET = SOCKET;
process.env.TMUX_TMPDIR = TMUX_TEST_TMPDIR;

const { engineWindowOutcome, liveWindows, tmux, tmuxCapability } = await import("../src/tmuxpane.ts");
const { findLiveWindow } = await import("../src/livewindow.ts");

let dir = "";
let other = "";
const have = tmuxCapability().available;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-enginereuse-"));
  other = mkdtempSync(join(tmpdir(), "agx-enginereuse-other-"));
});
afterAll(async () => {
  if (have) await tmux(["kill-server"]);
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (other) rmSync(other, { recursive: true, force: true });
  if (REAL_SOCKET === undefined) delete process.env.AGENTGLASS_TMUX_SOCKET;
  else process.env.AGENTGLASS_TMUX_SOCKET = REAL_SOCKET;
  if (REAL_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL_TMPDIR;
});

const names = async (session: string) =>
  (await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_name}"])).stdout.trim().split("\n");
const activeName = async (session: string) =>
  (await tmux(["list-windows", "-t", `=${session}:`, "-F", "#{window_active} #{window_name}"])).stdout
    .trim().split("\n").find((l) => l.startsWith("1 "))?.slice(2);

describe("opening a window by a name the app chose", () => {
  it("a second press selects the window that is there instead of opening another", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit-a", "-n", "work", "sleep", "300"]);
    const first = await engineWindowOutcome(dir, "conflict-1042", ["sleep", "300"], dir, undefined, "orbit-a", true, true);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.reused).toBeUndefined();
    // Somebody went back to their own work in the meantime.
    await tmux(["select-window", "-t", "=orbit-a:work"]);
    expect(await activeName("orbit-a")).toBe("work");

    const second = await engineWindowOutcome(dir, "conflict-1042", ["sleep", "300"], dir, undefined, "orbit-a", true, true);
    expect(second).toMatchObject({ ok: true, reused: true, windowId: first.windowId });
    expect((await names("orbit-a")).filter((n) => n === "conflict-1042").length).toBe(1);
    expect(await activeName("orbit-a")).toBe("conflict-1042");
  });

  it("only an exact name counts, never one that merely starts with it", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit-b", "-n", "conflict-10420", "-c", dir, "sleep", "300"]);
    await tmux(["new-window", "-d", "-t", "=orbit-b:", "-n", "conflict-104", "-c", dir, "sleep", "300"]);
    // tmux itself would answer `-t conflict-104` with the first window it
    // finds by prefix; the app must not.
    const w = await engineWindowOutcome(dir, "conflict-1042", ["sleep", "300"], dir, undefined, "orbit-b", true, true);
    expect(w).toMatchObject({ ok: true });
    if (!w.ok) return;
    expect(w.reused).toBeUndefined();
    expect((await names("orbit-b")).sort()).toEqual(["conflict-104", "conflict-1042", "conflict-10420"]);
  });

  it("a window in another checkout with the same name is not this pull request's", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit-c", "-n", "conflict-7", "-c", other, "sleep", "300"]);
    const w = await engineWindowOutcome(dir, "conflict-7", ["sleep", "300"], dir, undefined, "orbit-c", true, true);
    expect(w).toMatchObject({ ok: true });
    if (!w.ok) return;
    expect(w.reused).toBeUndefined();
    expect((await names("orbit-c")).filter((n) => n === "conflict-7").length).toBe(2);
  });

  it("a window whose command already ended is not running, so a new one opens", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit-d", "-n", "work", "sleep", "300"]);
    await tmux(["set-option", "-t", "=orbit-d", "remain-on-exit", "on"]);
    await tmux(["new-window", "-d", "-t", "=orbit-d:", "-n", "conflict-9", "-c", dir, "true"]);
    await Bun.sleep(300);
    const w = await engineWindowOutcome(dir, "conflict-9", ["sleep", "300"], dir, undefined, "orbit-d", true, true);
    expect(w).toMatchObject({ ok: true });
    if (!w.ok) return;
    expect(w.reused).toBeUndefined();
  });

  it("reuse is opt-in: every other caller still gets a window per call", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit-e", "-n", "work", "sleep", "300"]);
    await engineWindowOutcome(dir, "pr-5", ["sleep", "300"], dir, undefined, "orbit-e", false);
    await engineWindowOutcome(dir, "pr-5", ["sleep", "300"], dir, undefined, "orbit-e", false);
    expect((await names("orbit-e")).filter((n) => n === "pr-5").length).toBe(2);
  });
});

describe("liveWindows, the list the panel reads", () => {
  it("names each live window with its session, checkout and id; dead ones are left out", async () => {
    if (!have) return;
    await tmux(["new-session", "-d", "-s", "orbit-f", "-n", "work", "sleep", "300"]);
    await tmux(["set-option", "-t", "=orbit-f", "remain-on-exit", "on"]);
    const live = await engineWindowOutcome(dir, "conflict-31", ["sleep", "300"], dir, undefined, "orbit-f");
    await tmux(["new-window", "-d", "-t", "=orbit-f:", "-n", "conflict-32", "-c", dir, "true"]);
    await Bun.sleep(300);
    const all = await liveWindows();
    const mine = all.filter((w) => w.session === "orbit-f");
    expect(mine.map((w) => w.name).sort()).toEqual(["conflict-31", "work"]);
    if (!live.ok) return;
    expect(mine.find((w) => w.name === "conflict-31")).toMatchObject({ windowId: live.windowId });
    expect(mine.find((w) => w.name === "conflict-31")?.path).toContain("agx-enginereuse-");
  });
});

describe("findLiveWindow, the answer the pull request card reads", () => {
  /* Two repositories can both have a pull request 1042. The window in the other
     one is not this card's, however exactly its name matches. */
  const repo = (): string => {
    const d = mkdtempSync(join(tmpdir(), "agx-enginereuse-repo-"));
    const g = (...a: string[]) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main");
    g("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    return d;
  };
  it("finds the window in this repository's checkout and not the other repository's", async () => {
    if (!have) return;
    const a = repo();
    const b = repo();
    const wt = `${a}-conflict-feature`;
    spawnSync("git", ["-C", a, "worktree", "add", "-q", "-b", "feature", wt]);
    await tmux(["new-session", "-d", "-s", "orbit-g", "-n", "conflict-1042", "-c", b, "sleep", "300"]);
    // Only the other repository has one so far.
    expect(await findLiveWindow({ root: a, name: "conflict-1042" })).toBeNull();
    const w = await engineWindowOutcome(wt, "conflict-1042", ["sleep", "300"], wt, undefined, "orbit-g");
    expect(w).toMatchObject({ ok: true });
    if (!w.ok) return;
    expect(await findLiveWindow({ root: a, name: "conflict-1042" })).toMatchObject({ windowId: w.windowId });
    // A name that merely starts with it is not it.
    expect(await findLiveWindow({ root: a, name: "conflict-104" })).toBeNull();
    // Nor is the same name in a checkout it was not opened for.
    expect(await findLiveWindow({ root: a, name: "conflict-1042", path: a })).toBeNull();
    expect(await findLiveWindow({ root: a, name: "conflict-1042", path: wt })).toMatchObject({ windowId: w.windowId });
    // Closing the window brings the buttons back.
    await tmux(["kill-window", "-t", w.windowId]);
    expect(await findLiveWindow({ root: a, name: "conflict-1042" })).toBeNull();
    for (const d of [a, wt, b]) rmSync(d, { recursive: true, force: true });
  });
});

describe("the issue command", () => {
  it("reuses only when the caller asked, on both ways it opens a window, and tells the button when it happened", async () => {
    const terminal = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
    const at = terminal.indexOf('if (msg.cmd === "issue") {');
    const block = terminal.slice(at, terminal.indexOf('if (msg.cmd === "resume") {', at))
      .split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");
    expect(block.match(/engineWindowOutcome\([^\n]*, here, true, msg\.reuse === true\)/g)?.length).toBe(2);
    expect(block.match(/answer\(w\.ok, w\.ok \? "" : w\.reason, w\.ok && w\.reused === true\)/g)?.length).toBe(2);
  });
});
