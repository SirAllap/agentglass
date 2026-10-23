/*
 * POST /finder/bookmarks against a running server whose config folder is a scratch one: only the
 * desktop app (its Origin and desk key) writes the bookmarks file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

const TOKEN = "orbit-pins-token-0123456789abcdef", AUTH = { authorization: `Bearer ${TOKEN}` };
const DESK = "x-agentglass-desk", KEY = "k".repeat(48);
/** The desktop app's own request: its Origin and the desk key it holds. */
const person = (): Record<string, string> => ({ Origin: base, [DESK]: KEY });
let claimRes: Response | null = null, claimCtl: AbortController | null = null;
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null, errText = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-pins-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
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

const pin = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/finder/bookmarks`, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify({ path }) });
const file = () => join(dir, "gtk-3.0", "bookmarks");
const list = async () => ((await (await fetch(`${base}/finder/bookmarks`, { headers: AUTH })).json()) as { bookmarks: { path?: string; uri: string }[] }).bookmarks;

describe("who may pin a place", () => {
  test("a caller with only the machine token is refused, and the file is not written", async () => {
    expect((await pin("/home/ann/orbit")).status).toBe(403);
    expect(existsSync(file())).toBe(false);
  });
  test("a page on another origin is refused, desk key or not", async () => {
    expect((await pin("/home/ann/orbit", { Origin: "https://evil.example", [DESK]: KEY })).status).toBe(403);
    expect(existsSync(file())).toBe(false);
  });
  test("the desktop app's own request pins it, and the same request unpins it", async () => {
    const r = await pin("/home/ann/orbit", person());
    expect(r.status).toBe(200);
    expect(readFileSync(file(), "utf8")).toContain("file:///home/ann/orbit orbit");
    expect((await list()).map((b) => b.path)).toEqual(["/home/ann/orbit"]);
    expect((await pin("/home/ann/orbit", person())).status).toBe(200);
    expect(await list()).toEqual([]);
  });
  test("a pinned remote is unpinned by its address, and every other line stays", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file(), "# mine\nfile:///home/ann/orbit orbit\nsftp://ann@10.0.0.7/home/ann Workstation\n");
    const gone = (uri: string, headers: Record<string, string>) => fetch(`${base}/finder/bookmarks`, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: JSON.stringify({ uri }) });
    expect((await gone("sftp://ann@10.0.0.7/home/ann", {})).status).toBe(403);
    expect((await gone("sftp://ann@10.0.0.7/home/ann", person())).status).toBe(200);
    expect(readFileSync(file(), "utf8")).toBe("# mine\nfile:///home/ann/orbit orbit\n");
    expect((await gone("not a uri", person())).status).toBe(400);
  });
});
