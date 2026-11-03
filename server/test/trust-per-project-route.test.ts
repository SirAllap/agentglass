/*
 * A seat's own project, through a booted server with a real seat credential.
 *
 * With the person's switch on for the seat's project AND for another one, the
 * wall lets the seat at POST /orchestration because its own project says yes;
 * the pin in the handler is what keeps the root its own. Without it the same
 * request lands in the other project, which is a project the seat does not
 * speak for. A path that climbs out with `..` or ends in a slash names that
 * project too, and is refused the same way.
 *
 * The seat is adopted rather than opened: adoption hands back the same kind of
 * credential (`/seat/adopt` → `st_…`) without starting an engine, and the pane
 * it points at is a `sleep` this file starts. The project is a git repository
 * of its own because `seatable` measures a root against the projects the app
 * knows, and a plain directory inside another checkout folds into that one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { Policy } from "../../shared/orchestration.ts";

const have = !!Bun.which("tmux") && !!Bun.which("git");
const TOKEN = "tok-trust-route-example";
const SOCKET = `agx-trustroute-${process.pid}`;
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let dir: string, other: string, aliases: string[], seatToken: string, base: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

type View = { ok: boolean; scope: string; root?: string; policy: Policy };

const rule = (id: string) => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "always" }],
  workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] },
});

const get = async (path: string): Promise<Record<string, any>> =>
  (await fetch(base + path, { headers: auth })).json() as Promise<Record<string, any>>;
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: "POST", headers: { ...auth, Origin: base }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const view = async (root: string): Promise<View> => (await get(`/orchestration?root=${encodeURIComponent(root)}`)) as View;
const rulesAt = async (root: string) => (await view(root)).policy.rules.map((r) => r.id);
const trustedAt = async (root: string) => (await get(`/settings/door?root=${encodeURIComponent(root)}`)).trusted as boolean;
const save = (root: string, policy: unknown) => post("/orchestration", { root, policy });
const asSeat = (root: string, policy: unknown) =>
  fetch(`${base}/orchestration`, { method: "POST", headers: { ...auth, Authorization: `Bearer ${seatToken}`, Origin: base }, body: JSON.stringify({ root, policy }) });

/** A tab in `cwd` running a `sleep`, the way somebody's already-running session does. */
async function handTab(cwd: string): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "new-session", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, "sleep", "300"],
    { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
  const pane = (await new Response(p.stdout).text()).trim();
  if (await p.exited !== 0 || !pane) throw new Error("the tab did not open");
  return pane;
}

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "agx-trustroute-"));
  const init = Bun.spawn(["git", "init", "-q", dir], { stdout: "ignore", stderr: "ignore" });
  if (await init.exited !== 0) throw new Error("the project did not become a repository");
  // A sibling of the seat's project, so it is not a directory under it.
  other = `${dir}-orbit-b`;
  mkdirSync(other, { recursive: true });

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "t.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }

  const adopted = await post("/seat/adopt", { root: dir, session: "s-trust-route", pane: await handTab(dir), powers: "assign" });
  if (!adopted.body.ok) throw new Error(`the seat was not adopted: ${JSON.stringify(adopted.body)}`);
  seatToken = String(adopted.body.token);
  expect(seatToken).toMatch(/^st_/);

  for (const root of [dir, other]) {
    const r = await post("/settings/door", { id: "agents.changeWithoutAsking", value: true, root });
    if (r.status !== 200) throw new Error(`the switch did not go on for ${root}: ${JSON.stringify(r.body)}`);
  }
  const b = await view(other);
  const written = await save(other, { ...b.policy, rules: [rule("b-kept")] });
  if (written.status !== 200) throw new Error(`the other project's policy was not stored: ${JSON.stringify(written.body)}`);
  aliases = [other, `${dir}/../${basename(dir)}-orbit-b`, `${other}/`];
}, SERVER_BOOT_MS);

afterAll(async () => {
  if (!have) return;
  await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], {
    env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore",
  }).exited;
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe.skipIf(!have)("a seat on the policy route, with the switch on for two projects", () => {
  test("both projects say yes, and a project with no row of its own still says no", async () => {
    expect(await trustedAt(dir)).toBe(true);
    expect(await trustedAt(other)).toBe(true);
    expect(await trustedAt(`${dir}-orbit-c`)).toBe(false);
  });

  test("posting another project's root is refused, however the path is spelled, and no policy moves", async () => {
    const mine = (await view(dir)).policy;
    expect(await rulesAt(dir)).toEqual([]);
    for (const asked of aliases) {
      const res = await asSeat(asked, { ...mine, rules: [rule("seat-of-a")] });
      expect(res.status).toBe(403);
      expect(await rulesAt(other)).toEqual(["b-kept"]);
      // The `..` spelling used to be taken as the seat's own root and written there.
      expect(await rulesAt(dir)).toEqual([]);
    }
  });

  test("the same seat writes its own project's policy and it applies", async () => {
    const mine = (await view(dir)).policy;
    const res = await asSeat(dir, { ...mine, rules: [rule("seat-of-a")] });
    expect(res.status).toBe(200);
    expect(await rulesAt(dir)).toEqual(["seat-of-a"]);
    expect(await rulesAt(other)).toEqual(["b-kept"]);
  });
});
