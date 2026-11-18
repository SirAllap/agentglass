/* Every raw Jira write route is the person's (personOnlyJiraRoutes.ts): a worker gets 403, the person does not, the card door still answers a worker. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JIRA_PERSON_ONLY_REFUSED, PERSON_ONLY_JIRA_ROUTES } from "../src/personOnlyJiraRoutes.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-the-person-only-routes";
let dir = "", base = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
let output = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-jira-person-only-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMPDIR: dir, TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "r.db"), AGENTGLASS_TOKEN: TOKEN, AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "pipe", stderr: "pipe",
  });
  for (const s of [proc.stdout, proc.stderr] as ReadableStream[]) void (async () => { for await (const c of s) output += new TextDecoder().decode(c); })();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  if (!(await fetch(base + "/health").then((r) => r.ok).catch(() => false))) throw new Error("the server did not come up: " + output.slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

const post = (path: string, body: unknown, worker: boolean) => fetch(base + path, {
  method: "POST", body: JSON.stringify(body),
  headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(worker ? { "x-agentglass-agent": "worker-1" } : { origin: base }) },
});

describe("person-only Jira writes", () => {
  for (const path of PERSON_ONLY_JIRA_ROUTES) {
    test(`${path}: a worker gets 403, the person does not`, async () => {
      const body = { key: "ORBIT-1042", keys: ["ORBIT-1042"], url: "https://example.com/x", transitionId: "11", updated: 1 };
      const w = await post(path, body, true);
      expect(w.status).toBe(403);
      expect(((await w.json()) as { error: string }).error).toBe(JIRA_PERSON_ONLY_REFUSED);
      expect((await post(path, body, false)).status).not.toBe(403);
    }, 20_000);
  }

  test("the card door still answers a worker (it has its own policy)", async () => {
    const r = await post("/jira/door/steps", {}, true);
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(404);
  }, 20_000);
});
