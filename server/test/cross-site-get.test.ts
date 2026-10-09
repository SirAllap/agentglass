/*
 * On a server with no token, a GET with no Origin passed the Origin rule as if
 * it were curl. A browser loading the server as an image or a script from
 * another site sends no Origin either, but it does say Sec-Fetch-Site:
 * cross-site, so that request is refused while a navigation and a caller with
 * no fetch metadata (curl, the hooks) still get through. With a token the token
 * gate answers instead, and the desktop renderer's own `<img>` loads, which are
 * cross-site and carry the token, keep working (second server below).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-cross-site-"));
const TOKEN = "orbit-test-token";
const procs: ReturnType<typeof Bun.spawn>[] = [];
let base = "", withToken = "";

async function boot(name: string, extra: Record<string, string>): Promise<string> {
  const port = await freePort();
  const at = `http://127.0.0.1:${port}`;
  const home = join(dir, name);
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
      AGENTGLASS_STATE_DIR: join(home, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(home, "c.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      ...extra,
    },
    stdout: "ignore", stderr: "pipe",
  });
  procs.push(proc);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(at + "/health")).status < 500) return at; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

beforeAll(async () => {
  [base, withToken] = await Promise.all([boot("open", {}), boot("keyed", { AGENTGLASS_TOKEN: TOKEN })]);
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

const get = (headers: Record<string, string>) => fetch(base + "/clickup/prefs", { headers });

describe("a GET with no Origin on a server with no token", () => {
  test("from another site's image or script is refused", async () => {
    for (const mode of ["no-cors", "cors"]) {
      const r = await get({ "sec-fetch-site": "cross-site", "sec-fetch-mode": mode, "sec-fetch-dest": "image" });
      expect(r.status, mode).toBe(403);
    }
  });
  test("a navigation, the server's own page and a caller with no fetch metadata still get through", async () => {
    expect((await get({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })).status).toBe(200);
    expect((await get({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" })).status).toBe(200);
    expect((await get({})).status).toBe(200);
  });
});

describe("a server with a token", () => {
  test("a cross-site image load that carries the token is answered", async () => {
    const r = await fetch(`${withToken}/clickup/prefs?token=${TOKEN}`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } });
    expect(r.status).toBe(200);
  });
});
