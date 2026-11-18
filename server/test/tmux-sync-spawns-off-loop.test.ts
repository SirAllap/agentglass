/*
 * THE TMUX PROBES OUTSIDE THE SHUTDOWN PATH DO NOT HOLD THE EVENT LOOP.
 *
 * The frame poll's "why did the remount fail" call, the conf gate behind every
 * settings save, the boot sweep of stale confs and the restore capture's
 * process walk each ran a blocking spawn. A slow tmux there was a terminal
 * that stopped echoing. Two guards: the source one fails on the old code, and
 * a live one keeps a timer ticking while a slow fake tmux runs.
 *
 * The fake is this very runtime, linked under the name `tmux`: the socket
 * arguments are a script path, so `tmux <script> switch-client …` runs the
 * script, which waits and then answers like tmux does on a missing client.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { switchClientReason } from "../src/terminal.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const live = (text: string) => text.split("\n").filter((l) => /spawnSyncAs\(|Bun\.spawnSync\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));

describe("tmux probes off the loop (source)", () => {
  test("terminal.ts makes no sync spawn of its own", () => {
    expect(live(src("terminal.ts"))).toEqual([]);
  });
  test("tmuxconf.ts blocks only inside the once-per-process boot check", () => {
    const text = src("tmuxconf.ts");
    const sync = text.slice(text.indexOf("function validateConfSync"), text.indexOf("async function probe("));
    expect(live(text).length).toBe(3);
    expect(live(sync).length).toBe(3);
    expect(text).toContain("validateConfSync(readFileSync(confPath()");
    expect(text).toContain("const check = await validateConf(full);");
    expect((text.match(/timeout: 4000/g) ?? []).length).toBe(3);
  });
  test("the server runs the async conf check before it listens", () => {
    const index = src("index.ts");
    const at = index.indexOf("void checkConfAtBoot();");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(index.indexOf("const server = Bun.serve<WsData>({"));
  });
  test("tmuxrestore.ts blocks only in the exit-time capture", () => {
    const text = src("tmuxrestore.ts");
    const exit = text.slice(text.indexOf("export function captureLayoutSync"), text.indexOf("export function readRestoreState"));
    expect(live(text).length).toBe(1);
    expect(live(exit).length).toBe(1);
  });
  test("themesync.ts repaints a terminal's tmux with no sync spawn", () => {
    const text = src("themesync.ts");
    expect(live(text)).toEqual([]);
    expect(text).not.toContain("credentialsStrippedSync");
    expect(text).toContain("export async function applyThemeTo(");
  });
  test("tmuxctl.ts pane verbs outside the sync wrappers wait on the async strip", () => {
    const text = src("tmuxctl.ts");
    const body = (head: string) => {
      const i = text.indexOf(head);
      expect(i).toBeGreaterThan(-1);
      return text.slice(i, text.indexOf("\n}\n", i));
    };
    for (const name of ["healPrefix", "reopenWindow", "restartWindow", "switchClientToSession", "focusPane", "remountPhoneClient", "releaseStale"]) {
      const b = body(`export async function ${name}(`);
      /* No sync `tmux(` and no sync strip: every pane verb goes through tmuxAsync. */
      expect(b.match(/(?<![\w.])tmux\(/g), name).toBeNull();
      expect(b, name).not.toContain("syncStripOrKick");
    }
    expect(body("export function closePopup(")).toContain("return closePopupAsync(socket, tty)");
    /* The sync strip is left to the two sync wrappers: tmux() and tmuxpane's tmuxSync. */
    expect((text.match(/(?<!function )syncStripOrKick\(socket/g) ?? []).length).toBe(2);
  });
  test("terminal.ts keeps the sync status restore only on the shutdown path", () => {
    const text = src("terminal.ts");
    const calls = text.split("\n").filter((l) => /(?<![\w.])setStatusLine\(/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(calls.length).toBe(1);
    expect(text).toContain("// Sync on purpose: shutdown exits right after, and a promise would never land.");
  });
});

const dir = mkdtempSync(join(tmpdir(), "agx-tmuxsync-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tmux probes off the loop (live)", () => {
  test("a timer keeps firing while a slow tmux answers why switch-client failed", async () => {
    const fake = join(dir, "tmux");
    symlinkSync(process.execPath, fake);
    const script = join(dir, "slow.ts");
    writeFileSync(script, `await Bun.sleep(600); process.stderr.write("can't find client: /dev/pts/99\\n"); process.exit(1);\n`);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 20);
    try {
      const why = await switchClientReason({ pid: 0, socket: [script, ...TMUX_ISOLATED], tty: "/dev/pts/99" }, "$1", fake);
      expect(why).toBe("can't find client: /dev/pts/99");
      /* 600 ms of a 20 ms timer: a blocking spawn leaves this at 0 or 1. */
      expect(ticks).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(timer);
    }
  });
});
