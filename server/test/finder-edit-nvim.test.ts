/*
 * The Finder's Editing tab runs nvim in a tmux session of its own (slot
 * FINDER_EDIT_SLOT) inside the preview. What is pinned here: it has its own
 * socket (the reader's is shared by every other slot of the checkout, and two
 * editors cannot listen on one), it never shows up as a bench tab, the only
 * text that reaches nvim is a constant, and ending it leaves no tmux session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = ["AGENTGLASS_ROOT", "AGENTGLASS_TMUX_SOCKET", "TMUX_TMPDIR"] as const;
const was = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let box: string, repo: string, sock: string;
const lib = async () => ({ ...(await import("../src/bench.ts")), ...(await import("../src/tmuxpane.ts")) });

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), "agx-fedit-"));
  repo = join(box, "orbit");
  Bun.spawnSync(["mkdir", "-p", repo, join(box, "tmux")]);
  sock = `agx-fedit-${process.pid}`;
  process.env.AGENTGLASS_ROOT = box;
  process.env.TMUX_TMPDIR = join(box, "tmux");
  process.env.AGENTGLASS_TMUX_SOCKET = sock;
});
afterAll(async () => {
  Bun.spawnSync(["env", "-u", "TMUX", "tmux", "-L", sock, "kill-server"], { env: { ...process.env } });
  for (const k of ENV) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
  rmSync(box, { recursive: true, force: true });
});

describe("the Finder's editor", () => {
  it("has a socket of its own, apart from the bench reader's", async () => {
    const b = await lib();
    expect(b.finderEditSocketPath(repo)).not.toBe(b.readerSocketPath(repo));
    expect(b.finderEditSocketPath(repo)).toBe(b.finderEditSocketPath(repo));
    expect(b.FINDER_EDIT_SLOT).not.toBe(b.BENCH_READER_SLOT);
  });

  it("sends nvim constants only", async () => {
    const b = await lib();
    expect(b.finderModifiedArgv("/s.sock")).toEqual(["nvim", "--server", "/s.sock", "--remote-expr", "len(filter(getbufinfo(), {_, b -> b.changed}))"]);
    expect(b.FINDER_SAVE_KEYS).toBe("<Esc><Cmd>wa<CR>");
    expect(b.FINDER_QUIT_KEYS).toBe("<Esc><Cmd>qa!<CR>");
  });

  it("is no editor when there is no socket", async () => {
    const b = await lib();
    expect(await b.finderEditState(repo)).toEqual({ ok: true, live: false, modified: false });
  });

  it("is not a bench tab, and ending it leaves no tmux session behind", async () => {
    const b = await lib();
    const name = b.benchSessionName(repo, b.FINDER_EDIT_SLOT);
    const other = b.benchSessionName(repo, 3);
    for (const n of [name, other]) expect((await b.tmux(["new-session", "-d", "-s", n, "sleep", "300"])).ok).toBe(true);
    expect((await b.benchLive(repo)).slots).toEqual([3]);
    expect(await b.finderEditEnd(repo)).toMatchObject({ ok: true, ended: true });
    const left = (await b.tmux(["list-sessions", "-F", "#{session_name}"])).stdout.split("\n");
    expect(left).not.toContain(name);
    expect(left).toContain(other);
    await b.benchEnd(repo, 3);
    expect((await b.tmux(["list-sessions", "-F", "#{session_name}"])).stdout.split("\n")).not.toContain(other);
  });
});
