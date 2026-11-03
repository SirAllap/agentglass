/*
 * Who reads a settings request that names no project.
 *
 * A card with no root is a machine-wide change — the chair's wake hours, the
 * permission mode every launch runs in — so there is no project to narrow the
 * read by. What it carries is still somebody's: the setting, who asked, and
 * the diff of the value. It belongs to the asker, and another project's chair
 * reading it is disclosure across a boundary the rest of this file's rules
 * keep.
 *
 * `?as=` is a label a caller writes about itself, never proof of who it is. A
 * card with no project reads back only to a credential the server can identify
 * — a seat, a plugin, a worker's own `wk_` credential — so a machine token
 * naming itself alpha cannot read alpha's card, nor its own.
 *
 * The agent-name header is the same kind of label: every machine token can send
 * any name, so naming a registered policy worker proves nobody that worker. A
 * worker's identity on this route comes from the token `/agents/start` mints
 * for it (`auth.ts` `mintWorkerToken`), so the card it raises with that
 * credential is its own and reads back to it; the card a header-only worker
 * raises belongs to nobody and waits for the person: that is the intended limit.
 *
 * Two chairs on two projects (adopted panes, so no engine is started) plus the
 * machine token every agent shell carries: each asks a rootless question, and
 * each reads back only what its credential proves. Two plugins and two policy
 * workers stand in for the other token-proven identities; the understudy is
 * not tested here because no route mints its credential (`mintUnderstudyToken`
 * has no caller in the server), so there is no token a test could hold. Its
 * branch reads no rootless card either: a principal with no seat or plugin
 * name is not a proven asker.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const have = !!Bun.which("tmux") && !!Bun.which("git");
const TOKEN = "tok-settings-requests-scope";
const SOCKET = `agx-settings-scope-${process.pid}`;
const json = { "Content-Type": "application/json" };
const CLI = new URL("../../bin/agentglass-ui", import.meta.url).pathname;

let dir: string, other: string, base: string, seatA = "", seatB = "";
let pluginA = "", pluginB = "";
let workerA = "", workerB = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;

/** A plugin's own credential is minted by the server and written where its
 *  entrypoint puts it; the name is the plugin's, so two are two identities. */
const pluginManifest = (name: string) => ({
  name, publisher: "acme",
  description: "Writes its own token to disk so the test can read it, then idles.",
  entrypoint: `echo "$AGENTGLASS_READ_TOKEN" > "$AGENTGLASS_PLUGIN_DATA/token"; sleep 60`,
  scope: "full",
  sandbox: { network: "agentglass", read: [], write: [], programs: [] },
});

const enablePlugin = async (name: string): Promise<string> => {
  const src = join(dir, `src-${name}`);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "plugin.json"), JSON.stringify(pluginManifest(name)));
  const h = { Authorization: `Bearer ${TOKEN}`, ...json, Origin: base };
  const inst = (await (await fetch(base + "/plugins/install", { method: "POST", headers: h, body: JSON.stringify({ source: src }) })).json()) as Record<string, any>;
  if (!inst.ok) throw new Error(`the plugin was not installed: ${JSON.stringify(inst)}`);
  const en = (await (await fetch(base + "/plugins/enable", { method: "POST", headers: h, body: JSON.stringify({ name }) })).json()) as Record<string, any>;
  if (!en.ok) throw new Error(`the plugin was not enabled: ${JSON.stringify(en)}`);
  const tokenFile = join(dir, "agentglass", "plugin-data", name, "token");
  for (let i = 0; i < 100 && !existsSync(tokenFile); i++) await Bun.sleep(50);
  return readFileSync(tokenFile, "utf8").trim();
};

/** A policy-started worker in the registry, the way the policy leaves it: a
 *  row this app started headless. Written straight into the server's database
 *  because a real start needs an engine and a pane, and what the read filter
 *  asks of the row is only that the decision is there. */
const WORKER = "orbit-scope-worker";
const seedWorker = (name: string) => {
  const d = new Database(join(dir, "s.db"));
  d.run(
    `INSERT OR REPLACE INTO named_agent (name, kind, cwd, pane_id, window_id, started_at, ended_at, seat_root, model, started_by)
     VALUES (?, 'opencode', ?, '%90', '@90', ?, NULL, ?, NULL, ?)`,
    [name, dir, Date.now(), dir, JSON.stringify({ headless: true, role: "builder", engine: "opencode", model: "opencode/big-pickle" })],
  );
  d.close();
};

/** The header an agent writes about itself (`AGENTGLASS_AGENT_NAME`). */
const named = (worker: string) => ({ "x-agentglass-agent": worker });

const askAs = async (token: string, id: string, value: unknown, agent: string) => {
  const r = await fetch(base + "/settings/door", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...json, ...named(agent) },
    body: JSON.stringify({ id, value }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

/** A card's id read with a credential: the person adds the app's Origin, an
 *  agent or a chair does not (the Origin is what makes a request the person's). */
const cards = async (token: string, person = false, label?: string) => {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(person ? { Origin: base } : {}) };
  const q = label ? `?as=${encodeURIComponent(label)}` : "";
  const r = await fetch(base + "/settings/requests" + q, { headers });
  expect(r.status).toBe(200);
  return ((await r.json()) as { requests: { id: string; root?: string; who: string }[] }).requests;
};
const ask = async (token: string, id: string, value: unknown, opts: { origin?: boolean; as?: string } = {}) => {
  const r = await fetch(base + "/settings/door", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...json, ...(opts.origin ? { Origin: base } : {}) },
    body: JSON.stringify({ id, value, ...(opts.as ? { as: opts.as } : {}) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
/** A policy write is the ask that always waits for an agent; it names no root. */
const askPolicy = async (token: string, id: string) => {
  const cur = (await (await fetch(base + "/orchestration", { headers: { Authorization: `Bearer ${token}` } })).json() as { policy: { rules: unknown[] } }).policy;
  const r = await fetch(base + "/orchestration", { method: "POST", headers: { Authorization: `Bearer ${token}`, ...json }, body: JSON.stringify({ policy: { ...cur, rules: [...cur.rules, { id, name: `Rule ${id}`, enabled: true, when: [{ kind: "always" }], workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] } }] } }) });
  expect(r.status).toBe(202);
  return (await r.json() as { pending: { id: string; root?: string; who: string } }).pending;
};
const adopt = async (root: string, session: string): Promise<string> => {
  const r = await fetch(base + "/seat/adopt", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...json, Origin: base }, body: JSON.stringify({ root, session, pane: await handTab(root), powers: "assign" }) });
  const b = (await r.json()) as Record<string, any>;
  if (!b.ok) throw new Error(`the seat was not adopted: ${JSON.stringify(b)}`);
  return String(b.token);
};

async function handTab(cwd: string): Promise<string> {
  const p = Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "new-session", "-d", "-P", "-F", "#{pane_id}", "-c", cwd, "sleep", "300"],
    { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR, TMUX: "" }, stdout: "pipe", stderr: "ignore" });
  const pane = (await new Response(p.stdout).text()).trim();
  if (await p.exited !== 0 || !pane) throw new Error("the tab did not open");
  return pane;
}

/** The UI CLI as an agent runs it: the machine token from the environment, and
 *  whatever Origin it sends on its own. */
const cli = async (args: string[]) => {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, AGENTGLASS_SERVER: base, AGENTGLASS_TOKEN: TOKEN },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  return JSON.parse(out) as Record<string, any>;
};

beforeAll(async () => {
  if (!have) return;
  dir = mkdtempSync(join(tmpdir(), "agx-settings-scope-"));
  other = `${dir}-b`;
  for (const d of [dir, other]) {
    mkdirSync(d, { recursive: true });
    const init = Bun.spawn(["git", "init", "-q", d], { stdout: "ignore", stderr: "ignore" });
    if (await init.exited !== 0) throw new Error("the project did not become a repository");
  }
  // Both projects open, from the config file: AGENTGLASS_ROOT names one, and
  // the second chair has to be a project this server knows to be adopted at all.
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "config.json"), JSON.stringify({ root: [dir, other] }));

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  /* Worker credentials live in the serving process's memory, so the two are
     minted there: `workerBoot.ts` mints them, writes them out, then imports
     the server (the same shape `browser-worker-credential.test.ts` uses). */
  const workerFile = join(dir, "worker-tokens.json");
  proc = Bun.spawn(["bun", "run", new URL("./workerBoot.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_DB: join(dir, "s.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: SOCKET,
      AGENTGLASS_TOKEN: TOKEN,
      WORKER_BOOT_TOKENS: workerFile,
      WORKER_BOOT_NAMES: "orbit-scope-wa,orbit-scope-wb",
      // The box this runs on may have no usable userns (CI's docker replica):
      // the plugin only writes a file and sleeps, so run it unboxed.
      AGENTGLASS_PLUGINS_UNBOXED: "1",
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  seatA = await adopt(dir, "s-scope-a");
  seatB = await adopt(other, "s-scope-b");
  const minted = JSON.parse(readFileSync(workerFile, "utf8")) as { a: string; b: string };
  workerA = minted.a;
  workerB = minted.b;
  seedWorker(WORKER);
  seedWorker("orbit-scope-wa");
  seedWorker("orbit-scope-wb");
  pluginA = await enablePlugin("orbit-scope-a");
  pluginB = await enablePlugin("orbit-scope-b");
}, SERVER_BOOT_MS);

afterAll(async () => {
  if (!have) return;
  for (const name of ["orbit-scope-a", "orbit-scope-b"]) {
    try {
      await fetch(base + "/plugins/disable", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, ...json, Origin: base }, body: JSON.stringify({ name }) });
    } catch { /* server gone */ }
  }
  await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], {
    env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore",
  }).exited;
  proc?.kill();
  // `dir` is also the HOME the config file lives in; the sibling is outside it.
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

describe.skipIf(!have)("a settings request with no project", () => {
  test("a chair reads back its own rootless ask, and another project's chair does not", async () => {
    const asked = await ask(seatA, "seat.wakeHours", 6, { origin: true });
    expect(asked.status).toBe(202);
    const card = asked.body.pending as { id: string; root?: string; who: string };
    expect(card.root).toBeUndefined();
    expect(card.who).toBe(`the chair of ${dir.split("/").pop()}`);

    expect((await cards(seatA)).map((c) => c.id)).toContain(card.id);
    expect((await cards(seatB)).map((c) => c.id)).not.toContain(card.id);
    // The machine token is every agent shell on this box; it asked nothing here.
    expect((await cards(TOKEN)).map((c) => c.id)).not.toContain(card.id);
    // The person still reads every project's asks.
    expect((await cards(TOKEN, true)).map((c) => c.id)).toContain(card.id);
  });

  test("a machine token's rootless ask waits for the person: no label reads it back", async () => {
    const asked = await ask(TOKEN, "seat.wakeHours", 2, { as: "solo" });
    expect(asked.status).toBe(202);
    const card = asked.body.pending as { id: string; root?: string };
    expect(card.root).toBeUndefined();

    // The token names no one, so the label is not proof and the card is not its.
    expect((await cards(TOKEN)).map((c) => c.id)).not.toContain(card.id);
    expect((await cards(TOKEN, false, "solo")).map((c) => c.id)).not.toContain(card.id);
    // A chair and another project's chair do not read it either.
    expect((await cards(seatA)).map((c) => c.id)).not.toContain(card.id);
    expect((await cards(seatB)).map((c) => c.id)).not.toContain(card.id);
    // The person does.
    expect((await cards(TOKEN, true)).map((c) => c.id)).toContain(card.id);
  });

  test("a worker's name on the header proves nothing: it stamps no card and reads none", async () => {
    const asked = await askAs(TOKEN, "seat.wakeHours", 2, WORKER);
    expect(asked.status).toBe(202);
    const card = asked.body.pending as { id: string; root?: string; who: string };
    expect(card.root).toBeUndefined();
    // The row is a real policy worker, and the card is still nobody's: the
    // name arrived from the caller's own header, not from a credential.
    expect(card.who).not.toBe(`worker ${WORKER}`);
    // The attack the header used to open: name the worker, read its card.
    expect((await cards(TOKEN, false)).map((c) => c.id)).not.toContain(card.id);
    const h = { Authorization: `Bearer ${TOKEN}`, ...named(WORKER) };
    const read = (await (await fetch(base + "/settings/requests", { headers: h })).json()) as { requests: { id: string }[] };
    expect(read.requests.map((c) => c.id)).not.toContain(card.id);
    // The person reads it.
    expect((await cards(TOKEN, true)).map((c) => c.id)).toContain(card.id);
  });

  test("a chair cannot stamp its ask with a worker's name", async () => {
    const asked = await askAs(seatA, "seat.wakeHours", 6, WORKER);
    expect(asked.status).toBe(202);
    const card = asked.body.pending as { id: string; who: string };
    expect(card.who).toBe(`the chair of ${dir.split("/").pop()}`);
    // It is the chair's card, so the chair reads it and another project's does not.
    expect((await cards(seatA)).map((c) => c.id)).toContain(card.id);
    expect((await cards(seatB)).map((c) => c.id)).not.toContain(card.id);
  });

  test("one machine token cannot read another label's rootless ask by naming it", async () => {
    const alpha = (await ask(TOKEN, "seat.wakeHours", 3, { as: "alpha" })).body.pending as { id: string };
    const beta = (await ask(TOKEN, "seat.wakeHours", 1, { as: "beta" })).body.pending as { id: string };
    // The attack: the same credential names itself alpha, then beta, and reads
    // the card the other one raised.
    for (const label of ["alpha", "beta"]) {
      const ids = (await cards(TOKEN, false, label)).map((c) => c.id);
      expect(ids).not.toContain(alpha.id);
      expect(ids).not.toContain(beta.id);
    }
    // The person still reads both.
    const mine = (await cards(TOKEN, true)).map((c) => c.id);
    expect(mine).toContain(alpha.id);
    expect(mine).toContain(beta.id);
  });

  test("two plugins are two identities: each reads its own rootless ask and not the other's", async () => {
    const a = await askPolicy(pluginA, "plugin-a-rule");
    const b = await askPolicy(pluginB, "plugin-b-rule");
    expect(a.root).toBeUndefined();
    expect(b.root).toBeUndefined();
    expect(a.who).toBe("plugin orbit-scope-a");
    expect(b.who).toBe("plugin orbit-scope-b");
    // A plugin's name comes from the token the server minted, not from a label.
    expect((await cards(pluginA)).map((c) => c.id)).toContain(a.id);
    expect((await cards(pluginA)).map((c) => c.id)).not.toContain(b.id);
    expect((await cards(pluginB)).map((c) => c.id)).toContain(b.id);
    // The machine token proves no name, so it reads neither.
    expect((await cards(TOKEN)).map((c) => c.id)).not.toContain(a.id);
    expect((await cards(TOKEN)).map((c) => c.id)).not.toContain(b.id);
    // The person reads both.
    const all = (await cards(TOKEN, true)).map((c) => c.id);
    expect(all).toContain(a.id);
    expect(all).toContain(b.id);
  });

  test("a worker's own wk_ credential reads its own rootless ask, and another worker's does not", async () => {
    const card = await askPolicy(workerA, "worker-a-rule");
    expect(card.root).toBeUndefined();
    expect(card.who).toBe("worker orbit-scope-wa");

    expect((await cards(workerA)).map((c) => c.id)).toContain(card.id);
    expect((await cards(workerB)).map((c) => c.id)).not.toContain(card.id);
    // The machine token proves no name, so neither a label nor the header reads it back.
    expect((await cards(TOKEN)).map((c) => c.id)).not.toContain(card.id);
    expect((await cards(TOKEN, false, "orbit-scope-wa")).map((c) => c.id)).not.toContain(card.id);
    const headered = (await (await fetch(base + "/settings/requests", { headers: { Authorization: `Bearer ${TOKEN}`, ...named("orbit-scope-wa") } })).json()) as { requests: { id: string }[] };
    expect(headered.requests.map((c) => c.id)).not.toContain(card.id);
    // A label on a proven credential does not take it away from its owner.
    expect((await cards(workerA, false, "orbit-scope-wb")).map((c) => c.id)).toContain(card.id);
    // A plugin proves itself, not a worker; the person reads it.
    expect((await cards(pluginA)).map((c) => c.id)).not.toContain(card.id);
    expect((await cards(TOKEN, true)).map((c) => c.id)).toContain(card.id);
  });

  test("the UI CLI's reads do not present the app's Origin", async () => {
    const beta = (await ask(TOKEN, "seat.wakeHours", 1, { as: "cli-label" })).body.pending as { id: string };
    // Before the fix both reads sent Origin: <base>, and a hand-started server
    // with no desk key takes that for the person's window and answers every card.
    const listed = await cli(["settings", "list"]);
    expect(listed.ok).toBe(true);
    expect(((listed.pending ?? []) as { id: string }[]).map((r) => r.id)).not.toContain(beta.id);
    const asked = await cli(["settings", "requests"]);
    expect(asked.ok).toBe(true);
    expect((asked.value as { id: string }[]).map((r) => r.id)).not.toContain(beta.id);
    // The person's own window does read it.
    expect((await cards(TOKEN, true)).map((c) => c.id)).toContain(beta.id);
  });
});
