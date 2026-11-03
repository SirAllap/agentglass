/*
 * A settings request answered from the phone, and by nobody weaker.
 *
 * The settings door turns a risky change an agent asks for into a request the
 * person answers. Until now the only hand that could answer it was the desk's,
 * which is the wrong answer for the case the companion exists for: the person
 * is away, an agent is stopped on a request, and the phone in their pocket
 * already holds a credential minted at the desk.
 *
 * So these run against a booted server and are shaped like the callers: a
 * paired phone with the `answer` grant (the RN client, which sends the paired
 * machine's Origin and a device credential), a paired phone that may only
 * look, and an agent holding the machine token — with no Origin, which is the
 * curl it would write, and with the app's Origin plus its own name, which is
 * what a worker's CLI sends.
 *
 * Every refusal is checked against the setting itself, not only the status: a
 * 403 that still applied the value would be the bug with a better sentence.
 * Each test asks for its own change and names it, so the order the file runs
 * in does not matter.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import type { Policy } from "../../shared/orchestration.ts";

const TOKEN = "tok-settings-requests-phone";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
let phone = "", tablet = "";
const savedXdg = process.env.XDG_CONFIG_HOME;

const as = (cred: string) => ({ authorization: `Bearer ${cred}`, "content-type": "application/json" });
/** The phone as it really posts: its credential, and the Origin of the machine
 *  it paired with (mobile/src/lib/api.ts sets it so `trustedCaller` passes). */
const fromPhone = (cred: string) => ({ ...as(cred), origin: base });
/** An agent's curl: the machine token and nothing else. */
const fromAgent = as(TOKEN);
/** A policy worker's CLI: the machine token, the app's Origin, its own name. */
const namedAgent = () => ({ ...fromPhone(TOKEN), "x-agentglass-agent": "builder-orbit-1" });

type Req = { id: string; setting: string; label: string; who: string; diff: string[] };
const post = async (path: string, body: unknown, headers: Record<string, string>) => {
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const get = async <T,>(path: string, headers: Record<string, string>): Promise<T> =>
  (await fetch(base + path, { headers })).json() as Promise<T>;
const requests = async (cred = phone) => (await get<{ requests: Req[] }>("/settings/requests", as(cred))).requests;
const policy = async () => (await get<{ policy: Policy }>("/orchestration", as(TOKEN))).policy;
const decide = (id: string, approve: boolean, headers: Record<string, string>) =>
  post("/settings/requests/decide", { id, approve }, headers);

const rule = (id: string) => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "always" }],
  workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] },
});

/** An agent asking for a looser policy: a change that always waits. Its own
 *  rule id, so two tests cannot confuse one request with another. */
const ask = async (ruleId: string): Promise<Req> => {
  const before = new Set((await requests()).map((r) => r.id));
  const current = await policy();
  const r = await post("/orchestration", { policy: { ...current, rules: [...current.rules, rule(ruleId)] }, as: "builder" }, fromAgent);
  expect(r.status).toBe(202);
  const q = (await requests()).find((x) => !before.has(x.id));
  expect(q).toBeDefined();
  return q!;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-settings-phone-"));
  // Minted into the store the server reads at start, so this runs before the
  // spawn. The credential itself never leaves this test.
  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  phone = issueDevice("Pixel 9", "answer").token;
  tablet = issueDevice("an old tablet", "read").token;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "d.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("a settings request on the phone", () => {
  test("the list carries the server's label and diff, and the phone may read it", async () => {
    const q = await ask("shown-on-phone");
    expect(q.label).toBe("Orchestration policy");
    expect(q.diff[0]).toBe("Orchestration policy");
    expect(q.diff.some((l) => l.startsWith('rules[') && l.includes('"shown-on-phone"'))).toBe(true);
    expect(q.who).toBe('an agent calling itself "builder"');
  });

  test("the phone's answer grant decides it, and exactly that value is stored", async () => {
    const q = await ask("approved-from-phone");
    const r = await decide(q.id, true, fromPhone(phone));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect((await policy()).rules.map((x) => x.id)).toContain("approved-from-phone");
    expect((await requests()).map((x) => x.id)).not.toContain(q.id);
  });

  test("declining is the other answer, and nothing is written", async () => {
    const q = await ask("declined-from-phone");
    const r = await decide(q.id, false, fromPhone(phone));
    expect(r.status).toBe(200);
    expect((await policy()).rules.map((x) => x.id)).not.toContain("declined-from-phone");
    expect((await requests()).map((x) => x.id)).not.toContain(q.id);
  });

  test("an agent's token is still refused, with no Origin and with its own name", async () => {
    const q = await ask("refused-to-an-agent");
    // The curl an agent would write, from a shell that holds the machine token.
    expect((await decide(q.id, true, fromAgent)).status).toBe(403);
    // A worker's CLI: the app's Origin, but its own name on the request.
    expect((await decide(q.id, true, namedAgent())).status).toBe(403);
    // Nothing moved: still waiting, and the policy still does not carry it.
    expect((await requests()).map((x) => x.id)).toContain(q.id);
    expect((await policy()).rules.map((x) => x.id)).not.toContain("refused-to-an-agent");
  });

  test("a look-only phone is refused by the scope rule, and the request waits", async () => {
    const q = await ask("refused-to-a-reader");
    const r = await decide(q.id, true, fromPhone(tablet));
    expect(r.status).toBe(403);
    expect(r.body.needs).toBe("answer");
    expect((await requests()).map((x) => x.id)).toContain(q.id);
    expect((await policy()).rules.map((x) => x.id)).not.toContain("refused-to-a-reader");
  });

  test("a look-only tablet reads a request for a project the server is not open on, like the phone", async () => {
    // The widening is the paired device's, not the answer grant's: a read-scope
    // tablet is still a device, and it reads every card.
    const elsewhere = mkdtempSync(join(tmpdir(), "agx-settings-phone-tablet-"));
    try {
      const before = new Set((await requests()).map((r) => r.id));
      const there = await get<{ policy: Policy }>(`/orchestration?root=${encodeURIComponent(elsewhere)}`, as(TOKEN));
      const r = await post("/orchestration", { root: elsewhere, policy: { ...there.policy, rules: [...there.policy.rules, rule("asked-elsewhere-tablet")] }, as: "builder" }, fromAgent);
      expect(r.status).toBe(202);
      const card = (await requests()).find((x) => !before.has(x.id));
      expect(card).toBeDefined();
      expect((await requests(tablet)).map((x) => x.id)).toContain(card!.id);
      // The control: an agent's own list is the open project, and this is not it.
      expect((await requests(TOKEN)).map((x) => x.id)).not.toContain(card!.id);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("the phone reads a request for a project the server is not open on", async () => {
    // A sibling of the open project: not a repository the app has, so an agent's
    // own list cannot reach it and the phone's cannot either without the widening.
    const elsewhere = mkdtempSync(join(tmpdir(), "agx-settings-phone-elsewhere-"));
    try {
      const before = new Set((await requests()).map((r) => r.id));
      const there = await get<{ policy: Policy }>(`/orchestration?root=${encodeURIComponent(elsewhere)}`, as(TOKEN));
      const r = await post("/orchestration", { root: elsewhere, policy: { ...there.policy, rules: [...there.policy.rules, rule("asked-elsewhere")] }, as: "builder" }, fromAgent);
      expect(r.status).toBe(202);
      const card = (await requests()).find((x) => !before.has(x.id));
      expect(card).toBeDefined();
      expect(card!.setting).toBe("orchestration.policy");
      // The control: an agent's own list is the open project, and this is not it.
      expect((await requests(TOKEN)).map((x) => x.id)).not.toContain(card!.id);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
