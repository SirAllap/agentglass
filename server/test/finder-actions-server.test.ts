/*
 * The ACTIONS routes against a running server and a stub program on its PATH.
 * Pinned: an agent (the machine token, no desk key) may list and match actions
 * but never define, change, delete or run one; the person's own window may; and a
 * page on another origin may not, whichever it holds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

const TOKEN = "orbit-actions-token-0123456789abcdef", AUTH = { authorization: `Bearer ${TOKEN}` };
const DESK = "x-agentglass-desk", KEY = "k".repeat(48);
/** The desktop app's own request: its Origin and the desk key it holds. */
const person = (): Record<string, string> => ({ Origin: base, [DESK]: KEY });
let claimRes: Response | null = null, claimCtl: AbortController | null = null;
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null, errText = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-volumes-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "recorder"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv.txt"\n`);
  chmodSync(join(bin, "recorder"), 0o755);
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "a.txt"), "x");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"), AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "pipe", stderr: "pipe",
  });
  // Both pipes are read, or a chatty server stops on a full one.
  void (async () => { for await (const c of proc!.stderr as ReadableStream<Uint8Array>) errText += new TextDecoder().decode(c); })();
  void (async () => { for await (const c of proc!.stdout as ReadableStream<Uint8Array>) errText += new TextDecoder().decode(c); })();
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) { claimCtl = new AbortController(); claimRes = await fetch(base + "/desk/claim", { method: "POST", headers: { ...AUTH, [DESK]: KEY }, signal: claimCtl.signal }); if (claimRes.status !== 200) throw new Error("the desk claim was refused: " + claimRes.status); return; } } catch (e) { if (String(e).includes("desk claim")) throw e; /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up");
}, SERVER_BOOT_MS);

afterAll(() => {
  try { claimCtl?.abort(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/finder/actions/${route}`, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify(body) });
const MANIFEST = { schema_version: 1, id: "demo", name: "Demo", description: "", icon: "play", enabled: true, menu: "submenu", when: { kinds: ["file"], extensions: ["txt"], mime_types: [], min_items: 1, max_items: null }, run: { runtime: "command", entrypoint: "", program: "recorder", args: ["{paths}"], mode: "whole-selection", on_error: "continue", working_directory: "parent", confirm: false } };
const file = () => join(dir, "work", "a.txt");

describe("who may define and run an action", () => {
  test("a caller with only the machine token is refused every write, and nothing is stored", async () => {
    for (const [route, body] of [["save", { manifest: MANIFEST, create: true }], ["run", { id: "demo", paths: [file()], source: "selection" }], ["delete", { id: "demo" }]] as const) {
      expect((await post(route, body)).status).toBe(403);
    }
    expect(existsSync(join(dir, "agentglass", "finder-actions"))).toBe(false);
  });
  test("a page on another origin is refused, desk key or not", async () => {
    expect((await post("save", { manifest: MANIFEST, create: true }, { Origin: "https://evil.example", [DESK]: KEY })).status).toBe(403);
  });
  test("the person's window defines one; an agent may then list and match it but not run it", async () => {
    const s = await post("save", { manifest: MANIFEST, create: true }, person());
    expect(s.status).toBe(200);
    const list = await (await fetch(base + "/finder/actions", { headers: AUTH })).json() as { actions: { id: string }[] };
    expect(list.actions.map((a) => a.id)).toEqual(["demo"]);
    const m = await (await fetch(`${base}/finder/actions/match?source=selection&path=${encodeURIComponent(file())}`, { headers: AUTH })).json() as { actions: { id: string }[] };
    expect(m.actions.map((a) => a.id)).toEqual(["demo"]);
    expect((await post("run", { id: "demo", paths: [file()], source: "selection" })).status).toBe(403);
    expect(existsSync(join(dir, "argv.txt"))).toBe(false);
  });
  test("the person's window runs it, and the program gets the file as its own argument", async () => {
    const r = await post("run", { id: "demo", paths: [file()], source: "selection" }, person());
    expect(r.status).toBe(200);
    for (let i = 0; i < 100 && !existsSync(join(dir, "argv.txt")); i++) await Bun.sleep(30);
    expect(readFileSync(join(dir, "argv.txt"), "utf8")).toBe(file() + "\n");
  });
});
