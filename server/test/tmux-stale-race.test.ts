/**
 * THE STALE SWEEP DOES NOT GIVE BACK A STATUS LINE A LIVE PANEL JUST TOOK.
 *
 * `releaseStale` is fired without an await on first contact with a tmux
 * server (terminal.ts) and it awaits `list-sessions` before it releases
 * anything. A panel that hides the bar in that gap queues its hide first on the
 * session's chain; the sweep then reads the claim it finds (the dead run's, or
 * the panel's own) and queues a show behind the hide, so the bar comes back
 * under a panel that is still using it.
 *
 * tmux itself is faked: `process.execPath` linked under the name `tmux`, with a
 * script in the socket argv that keeps each session's options in a JSON file.
 * `list-sessions` answers slowly, which is the gap the race lives in.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-stalerace-"));
const state = join(dir, "state.json");
const script = join(dir, "faketmux.ts");
const SOCK = [script, ...TMUX_ISOLATED, "-L", "agx-stale-race"];
const ID = "$1";
const REAL = { PATH: process.env.PATH, TMUX_TMPDIR: process.env.TMUX_TMPDIR };

const read = (): Record<string, string> => JSON.parse(readFileSync(state, "utf8"));

beforeAll(() => {
  symlinkSync(process.execPath, join(dir, "tmux"));
  writeFileSync(state, "{}");
  writeFileSync(script, `
import { readFileSync, writeFileSync } from "node:fs";
const state = ${JSON.stringify(state)};
let a = process.argv.slice(2);
while (a[0] === "-L" || a[0] === "-S" || a[0] === "-f") a = a.slice(2);
const o = JSON.parse(readFileSync(state, "utf8"));
const save = () => writeFileSync(state, JSON.stringify(o));
const [verb, ...rest] = a;
if (verb === "list-sessions") {
  await Bun.sleep(150);
  process.stdout.write(${JSON.stringify(ID)} + "\\t" + (JSON.parse(readFileSync(state, "utf8"))["@agx-owned"] ?? "") + "\\n");
} else if (verb === "set-option") {
  const unset = rest.some((x) => /^-\\w*u/.test(x));
  const words = rest.filter((x, i) => !x.startsWith("-") && rest[i - 1] !== "-t");
  if (unset) delete o[words[0]]; else o[words[0]] = words[1] ?? "";
  save();
} else if (verb === "show-options") {
  const name = rest[rest.length - 1];
  if (rest.includes("-gv") && name === "status") process.stdout.write("on\\n");
  else process.stdout.write((o[name] ?? "") + "\\n");
}
`);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.TMUX_TMPDIR = dir;
});

afterAll(() => {
  process.env.PATH = REAL.PATH;
  if (REAL.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR;
  else process.env.TMUX_TMPDIR = REAL.TMUX_TMPDIR;
  rmSync(dir, { recursive: true, force: true });
});

test("a panel that hides the bar while the sweep is still listing sessions keeps it hidden", async () => {
  const ctl = await import("../src/tmuxctl.ts");
  // What a killed run left behind: the claim and the blanked row.
  writeFileSync(state, JSON.stringify({ "@agx-owned": "1", status: "on", "status-format[0]": "" }));
  const t = { pid: 0, socket: SOCK, session: "race", id: ID };
  const sweep = ctl.releaseStale({ pid: 0, socket: SOCK, tty: "/dev/null" });
  const hide = ctl.setStatusLineAsync(t, false);
  expect(await hide).toBe(true);
  await sweep;
  expect(read()["@agx-owned"]).toBe("1");
  expect(read()["status-format[0]"]).toBe("");
});
