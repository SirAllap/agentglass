/*
 * EVERY verb, addressed to a lane.
 *
 * `--lane` was carried by the one ask the CLI sends, so the verbs the relay
 * answers by asking the window several times itself (`do`, `record`,
 * `download`, `events`, `scrape`, `whoami`) sent their steps with no lane, and
 * they landed in the person's visible tab; a closed lane fell through to it too.
 * This walks the whole verb list against a real server with a person's window
 * and a lane host on the other side of real sockets, and asks two things of
 * each: with the lane open, nothing reaches the person's window; with the lane
 * gone, or somebody else's, nothing does either, and the refusal says why.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_OPS } from "../src/browserdrive.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
const sockets: WebSocket[] = [];
const seen: Array<{ to: string; op: string; args: Record<string, any> }> = [];
const postJson = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", Origin: base }, body: JSON.stringify(body) });

/** What a window says to any ask: enough of every shape for the relay's own composing to carry on. */
const answer = (op: string): Record<string, unknown> => {
  const page = { title: "t", url: "http://localhost/", text: "", tabs: [{ id: "t1", title: "t", url: "http://localhost/", active: true }], frames: [], profiles: ["default"], png: "", console: [], network: [], rows: [] };
  return { ok: true, value: op === "tabs" ? { tabs: page.tabs } : page };
};

async function windowNamed(name: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/stream");
  sockets.push(ws);
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: name, browser: true }));
  ws.addEventListener("message", async (ev) => {
    let f: any;
    try { f = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (f.type !== "browser") return;
    seen.push({ to: name, op: f.data.op, args: f.data.args ?? {} });
    if (f.data.op === "lane" && typeof f.data.args?.make === "string") {
      void windowNamed(`host-${f.data.args.make}`).then(() => postJson("/browser/ready", { client: `host-${f.data.args.make}`, on: true, lanes: [f.data.args.make] }));
    }
    await postJson("/browser/result", { client: name, id: f.data.id, ...answer(f.data.op) });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-laneverbs-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  await windowNamed("visible");
  await postJson("/browser/ready", { client: "visible", on: true });
  await windowNamed("mgr");
  await postJson("/browser/ready", { client: "mgr", on: true, manager: true });
  await Bun.sleep(150);
}, SERVER_BOOT_MS);

afterAll(() => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** A valid body for every verb that will not take `{}`. Anything missing here fails the walk with the server's own complaint. */
const BODIES: Record<string, Record<string, unknown>> = {
  do: { steps: [{ op: "tabs", args: {} }, { op: "read", args: {} }] },
  record: { frames: 2, every: 50, dir: "" },
  download: { selector: "#dl", dir: "", timeoutMs: 1000 },
  events: { wait: 0.3 },
  trace: { action: "stop", dir: "" },
  scrape: { urls: ["http://localhost/a"] },
};

const SKIP = new Set(["lane", "audit"]);

describe.skipIf(!Bun.which("bun"))("every verb, addressed to a lane", () => {
  let lane = "";
  beforeAll(async () => {
    const r: any = await (await postJson("/browser/lane", { action: "new", as: "orbit" })).json();
    lane = r.value.lane.id;
  }, 30_000);

  for (const op of BROWSER_OPS.filter((o) => !SKIP.has(o))) {
    test(`${op}: an open lane never reaches the person's window`, async () => {
      seen.length = 0;
      const body: Record<string, unknown> = { as: "orbit", lane, ...(BODIES[op] ?? {}) };
      if (op === "record" || op === "download" || op === "trace") body.dir = dir;
      const r: any = await (await postJson("/browser/" + op, body)).json().catch(() => ({}));
      expect(r.error ?? "").not.toContain("no lane called");
      expect(seen.filter((s) => s.to === "visible")).toEqual([]);
    }, 20_000);

    test(`${op}: a closed or unknown lane is a named refusal and nothing is asked`, async () => {
      seen.length = 0;
      const body: Record<string, unknown> = { as: "orbit", lane: "lgone0000", ...(BODIES[op] ?? {}) };
      if (op === "record" || op === "download" || op === "trace") body.dir = dir;
      const r: any = await (await postJson("/browser/" + op, body)).json();
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("no lane called lgone0000");
      expect(seen).toEqual([]);
    }, 20_000);
  }

  test("somebody else's lane is refused for a verb that forwards and one the relay composes", async () => {
    seen.length = 0;
    for (const [op, extra] of [["read", {}], ["do", BODIES.do], ["whoami", {}]] as const) {
      const r: any = await (await postJson("/browser/" + op, { as: "acme", lane, ...extra })).json();
      expect(r.ok).toBe(false);
      expect(String(r.error)).toContain("was opened by orbit");
    }
    expect(seen).toEqual([]);
  });
});
