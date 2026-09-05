/*
 * The party being held cannot let itself go.
 *
 * The gate is a PreToolUse hook: an agent asks to be stopped, and stays stopped
 * until somebody answers. Everything it is worth rests on the second half, and
 * the second half was not true. The hook that raises the hold runs as this user,
 * so it reads `~/.config/agentglass/token` or finds `AGENTGLASS_TOKEN` in its own
 * environment; `/gate/decide` was behind `trustedCaller`, which admits a caller
 * with no Origin on loopback because that is exactly what a hook is. One `curl`
 * from the agent's own shell released the agent's own call, `actorOf` wrote
 * `local` into the audit row — the same string the desk's button writes — and
 * gate.ts told the model a human had reviewed it.
 *
 * So these run against a real spawned server and are shaped like the attack
 * rather than like a description of it: the request that must fail is a POST
 * carrying the machine token and no Origin header, which is what
 * `curl -H "Authorization: Bearer $AGENTGLASS_TOKEN"` produces and nothing else
 * does. The three that must keep working are the three ways a person actually
 * answers — the packaged shell, a browser on this machine, a paired phone — and
 * they are here because breaking any of them makes the feature worse than the
 * bug did.
 *
 * What this does NOT prove, and no test in this file can: that a determined
 * local process is stopped. `Origin` is a string, and a client that sets it on
 * purpose passes — the last two tests below are, mechanically, that forgery
 * wearing a browser's clothes. The bar this raises is from "the curl you would
 * write anyway" to "a curl written to defeat the gate". See the comment on
 * `mayReleaseAHold` in index.ts, and the scope paragraph in SECURITY.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "machine-token-for-this-test";

/** A server with its own scratch HOME, so nothing here can read or write the
 *  developer's real devices, settings or database. */
function spawnServer(dir: string, port: number, extra: Record<string, string> = {}) {
  return Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // Named, never `...process.env` — see gate-actor-route.test.ts. A leaked
    // variable here is a test server reading a real paired-devices file.
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "gate.db"),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      ...extra,
    },
    stdout: "ignore", stderr: "pipe",
  });
}

async function waitFor(base: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

let dir: string, base: string, port = 0, proc: ReturnType<typeof Bun.spawn> | null = null;
let phone = "", tablet = "";
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-gaterelease-"));
  // Minted into the store the server will read. devices.ts re-reads the file on
  // every lookup, so writing it before the first authenticated request is the
  // whole of the ordering requirement.
  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  phone = issueDevice("Pixel 9", "answer").token;
  tablet = issueDevice("an old tablet", "read").token;

  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawnServer(dir, port);
  await waitFor(base, proc);
});

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const as = (cred: string) => ({ authorization: `Bearer ${cred}`, "content-type": "application/json" });

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/**
 * Hold a tool call the way `hooks/gate_event.py` does: a POST that does not
 * come back until somebody answers it, with the hook's own id on it, and no
 * Origin header — because Python's urllib sends none and never will.
 *
 * The promise is returned rather than dropped: what /gate answers when the
 * hold is finally released is the payload the stopped model reads, and one
 * test below is about exactly that.
 */
function hold(id: string, timeoutMs = 30_000): Promise<Json> {
  const held = fetch(base + "/gate", {
    method: "POST", headers: as(TOKEN),
    body: JSON.stringify({
      id, source_app: "claude", session_id: "s-1", tool_name: "Bash",
      tool_input: { command: "rm -rf build" }, timeout_ms: timeoutMs,
    }),
  }).then((r) => r.json() as Promise<Json>);
  held.catch(() => { /* a test that never releases it is not a failure here */ });
  return held;
}

/** Wait until the server is really holding it, so a refusal below cannot be
 *  "there was nothing to decide". */
async function queued(id: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(base + "/gate/pending", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    if (r.gates.some((g: Json) => g.id === id)) return;
    await Bun.sleep(50);
  }
  throw new Error("the gate never appeared in the pending queue");
}

const isPending = async (id: string): Promise<boolean> =>
  (await fetch(base + "/gate/pending", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>))
    .gates.some((g: Json) => g.id === id);

/** One decision, with whatever a caller would present: a credential, and an
 *  Origin only if it is the kind of client that sends one. */
const decide = (id: string, cred: string, origin?: string) =>
  fetch(base + "/gate/decide", {
    method: "POST",
    headers: origin ? { ...as(cred), origin } : as(cred),
    body: JSON.stringify({ id, decision: "allow", reason: "go ahead" }),
  });

describe("the held party cannot release itself", () => {
  test("the machine token from a shell with no Origin is refused, and the call stays held", async () => {
    const id = nextId();
    hold(id);
    await queued(id);

    // The attack, in the shape it actually arrives in. Nothing about this
    // request is malformed — it is the credential the hook itself is given,
    // from the machine the server is running on.
    const r = await decide(id, TOKEN);
    expect(r.status).toBe(403);

    // A bare 403 sends the reader looking for a bug in their client, so the
    // sentence has to name the rule.
    const why = (await r.json()) as Json;
    expect(why.ok).toBe(false);
    expect(why.error).toContain("released by a person");
    expect(why.error).toContain("paired-device");

    // The half that matters more than the status code: nothing moved. A
    // refusal that still resolved the row would be the same bug with a
    // different response.
    expect(await isPending(id)).toBe(true);
  });

  test("a paired phone with the answer grant decides it, carrying no Origin at all", async () => {
    // The companion is a React Native client: it sends a credential and no
    // Origin header, so a rule written only around Origin would have locked the
    // phone out of the one thing a phone is for. The device credential is the
    // proof here — it is minted at the desk, kept as a hash, and is not in any
    // environment an agent inherits.
    const id = nextId();
    const held = hold(id);
    await queued(id);

    const r = await decide(id, phone);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);

    // And the stopped call is genuinely let go, not just marked.
    expect((await held).decision).toBe("allow");
  });

  test("a look-only phone is still refused by the scope rule, not by this one", async () => {
    // The two layers answer different questions and must not be confused: this
    // device may not answer gates at all, and the reply says so in the words
    // the pairing screen uses rather than in the words above.
    const id = nextId();
    hold(id);
    await queued(id);

    const r = await decide(id, tablet);
    expect(r.status).toBe(403);
    const why = (await r.json()) as Json;
    expect(why.scope).toBe("read");
    expect(why.needs).toBe("answer");
    expect(await isPending(id)).toBe(true);
  });

  test("the desktop shell decides it: its renderer's own scheme is an Origin no browser can be served from", async () => {
    const id = nextId();
    const held = hold(id);
    await queued(id);

    const r = await decide(id, TOKEN, "agentglass://app");
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);
    expect((await held).decision).toBe("allow");
  });

  test("a browser page on this machine decides it, which is the web UI's whole path", async () => {
    // The claim the change rests on: a browser attaches Origin to every POST,
    // same-origin ones included. So the web UI keeps working through this
    // branch while curl and urllib do not — and if that claim were false, this
    // test would be the one to say so.
    const id = nextId();
    const held = hold(id);
    await queued(id);

    const r = await decide(id, TOKEN, base);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);
    expect((await held).decision).toBe("allow");
  });

  test("a page on a real website is refused, as it always was", async () => {
    const id = nextId();
    hold(id);
    await queued(id);
    const r = await decide(id, TOKEN, "https://example.invalid");
    expect(r.status).toBe(403);
    expect(await isPending(id)).toBe(true);
  });
});

describe("the hook's own two paths are untouched", () => {
  test("submitting a hold needs no Origin — that is the agent asking to be held", async () => {
    // The route that is working correctly. An Origin-less POST /gate is the
    // hook, and tightening it would mean nothing is ever held in the first
    // place.
    const id = nextId();
    const held = hold(id);
    await queued(id);
    expect(await isPending(id)).toBe(true);
    await decide(id, phone);
    expect((await held).decision).toBe("allow");
  });

  test("re-attaching after a dropped connection needs no Origin either", async () => {
    /*
     * The failure this pins is silent and total. `gate_event.py` long-polls
     * `/gate/status` when its connection drops, with urllib and therefore with
     * no Origin. A 403 there is not read as a refusal: the retry loop treats
     * any non-404 error as "the connection went away", keeps retrying until its
     * own deadline, and then falls into fail-open. Every held call on the
     * machine would auto-allow while the queue still looked healthy on screen.
     */
    const id = nextId();
    hold(id);
    await queued(id);

    // Long-poll the way the hook does, before anybody has answered.
    const reattached = fetch(base + `/gate/status?id=${encodeURIComponent(id)}`, { headers: as(TOKEN) });
    await decide(id, TOKEN, "agentglass://app");

    const r = await reattached;
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).decision).toBe("allow");
  });

  test("and reading the queue needs no Origin, which is the decision recorded next to those reads", async () => {
    for (const path of ["/gate/pending", "/gate/history?limit=5"]) {
      expect((await fetch(base + path, { headers: as(TOKEN) })).status, path).toBe(200);
    }
  });
});

describe("the budget brake has an off switch", () => {
  /*
   * `/budgets/set` is where the budget-to-gate brake is armed: over the limit,
   * `budgetHoldFor` puts a reason on the hold and, fail-closed, is what turns
   * an unanswered call into a denial. Every other write family could already be
   * turned off with one variable; this one could not, which made raising your
   * own ceiling the least guarded write in the server.
   */
  let bDir: string, bBase: string, bProc: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    bDir = mkdtempSync(join(tmpdir(), "agx-budgetoff-"));
    const p = await freePort();
    bBase = `http://127.0.0.1:${p}`;
    bProc = spawnServer(bDir, p, { AGENTGLASS_BUDGET_WRITE_DISABLED: "1" });
    await waitFor(bBase, bProc);
  });

  afterAll(() => {
    try { bProc?.kill(); } catch { /* already gone */ }
    try { rmSync(bDir, { recursive: true, force: true }); } catch { /* fine */ }
  });

  test("with the switch on, a budget write is refused and says which variable did it", async () => {
    const r = await fetch(bBase + "/budgets/set", {
      method: "POST", headers: as(TOKEN),
      body: JSON.stringify({ budgets: [{ root: "", model: "", limit: 9999, period: "month" }] }),
    });
    expect(r.status).toBe(403);
    const why = (await r.json()) as Json;
    expect(why.ok).toBe(false);
    expect(why.error).toContain("AGENTGLASS_BUDGET_WRITE_DISABLED");

    // Refused before the body is even parsed, and nothing was stored.
    const after = await fetch(bBase + "/budgets", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    expect(after.budgets).toEqual([]);
  });
});
