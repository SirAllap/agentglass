/*
 * "I approved that from my phone", end to end — #299.
 *
 * Everything below goes through a real server with a real paired device rather
 * than through the functions directly, because the part that was missing is
 * plumbing: the route has to know which caller presented which credential, and
 * hand the same answer to the gate row and to the action log. A unit test of
 * `actorOf` passes just as happily when the route never calls it.
 *
 * The gate that nobody decides is here for the same reason. It is the outcome
 * with no request behind it, so it is the one an audit trail loses first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-this-test";
let dir: string, base: string, phone = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let phoneName = "";
const savedXdg = process.env.XDG_CONFIG_HOME;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-gateactor-"));
  // Mint the credential into the same store the server will read. `devices.ts`
  // re-reads the file on every lookup, so there is no ordering trap here beyond
  // writing it before the first authenticated request.
  process.env.XDG_CONFIG_HOME = dir;
  const { issueDevice } = await import("../src/devices.ts");
  const issued = issueDevice("Pixel 9", "answer");
  phone = issued.token;
  phoneName = issued.device.id.slice(0, 6);

  // 4600–4619 is a band no other suite spawns into. Files run sequentially, so
  // an overlap only bites when a previous server outlives its own file — which
  // is exactly the failure that looks like a flake and gets re-run rather than
  // fixed.
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    // Named, never `...process.env`: a leaked variable here would be a server
    // reading a developer's real devices file.
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
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
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedXdg;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const as = (cred: string) => ({ authorization: `Bearer ${cred}`, "content-type": "application/json" });

let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** Hold a tool call, the way the hook does. Returns as soon as it is queued;
 *  the held promise is nobody's business here. */
async function hold(id: string, timeoutMs = 30_000): Promise<void> {
  void fetch(base + "/gate", {
    method: "POST", headers: as(TOKEN),
    body: JSON.stringify({
      id, source_app: "claude", session_id: "s-1", tool_name: "Bash",
      tool_input: { command: "rm -rf build" }, timeout_ms: timeoutMs,
    }),
  }).catch(() => {});
  for (let i = 0; i < 60; i++) {
    const r = await fetch(base + "/gate/pending", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    if (r.gates.some((g: Json) => g.id === id)) return;
    await Bun.sleep(50);
  }
  throw new Error("the gate never appeared in the pending queue");
}

/** `origin` because the desk is a browser and the phone is not: a page always
 *  attaches one to a POST, and `/gate/decide` now requires either that or a
 *  paired-device credential — the party being held has neither. See
 *  `mayReleaseAHold` in index.ts and gate-release.test.ts. */
const decide = (id: string, cred: string, decision: "allow" | "deny", reason = "", origin?: string) =>
  fetch(base + "/gate/decide", {
    method: "POST",
    headers: origin ? { ...as(cred), origin } : as(cred),
    body: JSON.stringify({ id, decision, reason }),
  }).then((r) => r.json() as Promise<Json>);

const history = () =>
  fetch(base + "/gate/history?limit=50", { headers: as(TOKEN) }).then((r) => r.json() as Promise<Json>);
const seen = async (id: string): Promise<Json> => (await history()).gates.find((g: Json) => g.id === id);

describe("who answered", () => {
  test("a paired phone is named, not reduced to the address it is on", async () => {
    // The question #299 opens with. A phone on DHCP is a different address next
    // week and the same phone; the address was never what anybody wanted.
    const id = nextId();
    await hold(id);
    expect((await decide(id, phone, "deny", "not on prod")).ok).toBe(true);
    const g = await seen(id);
    expect(g.resolution).toBe("human");
    expect(g.decided_by).toContain("Pixel 9");
    // …and its id, because "A device" is the default label and two of them
    // would otherwise be one line.
    expect(g.decided_by).toContain(phoneName);
  });

  test("and the same press lands in the action log under the same name", async () => {
    // Two writers, one actor, resolved once. If they could disagree the log
    // would answer "who" twice and differently, which is worse than not at all.
    const r = await fetch(base + "/actions?limit=20", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    const line = r.actions.find((a: Json) => a.action === "/gate/deny");
    expect(line, "the phone's decision is not in the action log").toBeTruthy();
    expect(line.actor).toContain("Pixel 9");
  });

  test("the dashboard on this machine is still a place, because its token is shared", async () => {
    const id = nextId();
    await hold(id);
    // The shell's own scheme, which is what the desktop app's renderer sends.
    expect((await decide(id, TOKEN, "allow", "", "agentglass://app")).ok).toBe(true);
    expect((await seen(id)).decided_by).toBe("local");
  });
});

describe("what the reader is given", () => {
  test("the words a person typed", async () => {
    const g = (await history()).gates.find((x: Json) => x.reason === "not on prod");
    expect(g, "a typed reason did not survive to the history").toBeTruthy();
  });

  test("and not the paragraph written for the stopped model", async () => {
    // Every gate waved through without a comment carries the same three lines,
    // which as a quotation in a list is boilerplate on every row hiding the one
    // row where somebody explained themselves.
    const { defaultReason } = await import("../src/gate.ts");
    for (const g of (await history()).gates as Json[]) {
      expect(g.reason ?? "", g.id).not.toBe(defaultReason(g.decision));
    }
  });
});

describe("what nobody answered", () => {
  test("expires with an outcome and without an actor", async () => {
    /*
     * The row this whole column has to get right. A request that ran out while
     * everybody was at lunch still allowed a tool call — it is a real outcome
     * with a real consequence — and it has no actor, because nobody looked at
     * it. `local` here would be the exact lie an audit trail exists to prevent.
     *
     * 1s is the floor `submitGate` clamps to.
     */
    const id = nextId();
    await hold(id, 1000);
    for (let i = 0; i < 40; i++) {
      const g = await seen(id);
      if (g) {
        expect(g.resolution).toBe("timeout");
        expect(g.decided_by, "a timeout was given an actor").toBeNull();
        expect(g.decision).toBe("allow");
        return;
      }
      await Bun.sleep(100);
    }
    throw new Error("the gate never expired into the history");
  });

  test("and deciding it afterwards changes nothing and says so", async () => {
    // Somebody presses deny on their phone on a request the clock already
    // allowed. The row must keep what the agent was actually told — and the
    // press that lost must still be recorded, because it is the single most
    // confusing thing that can happen here and the gates table has no row for
    // it.
    const id = nextId();
    await hold(id, 1000);
    for (let i = 0; i < 40 && !(await seen(id)); i++) await Bun.sleep(100);
    const lostPress = await decide(id, phone, "deny", "too late");
    expect(lostPress.ok).toBe(false);
    // …and it says why. A bare failure next to a gate row saying the opposite
    // is the most confusing thing this feature can produce, and the press that
    // lost is the only place the two can be reconciled.
    expect(String(lostPress.error)).toContain("the timeout");
    expect(String(lostPress.error)).toContain("too late");

    const g = await seen(id);
    expect(g.decision).toBe("allow");
    expect(g.resolution).toBe("timeout");
    expect(g.decided_by).toBeNull();

    const r = await fetch(base + "/actions?limit=50", { headers: as(TOKEN) }).then((x) => x.json() as Promise<Json>);
    const lost = (r.actions as Json[]).find((a) => a.action === "/gate/deny" && !a.ok);
    expect(lost, "the decision that lost the race left no trace").toBeTruthy();
    expect(lost!.actor).toContain("Pixel 9");
    expect(String(lost!.detail), "the failed line does not say why").toContain("too late");
  });

  test("and an id this server never held says that, rather than blaming the clock", async () => {
    const r = await decide("00000000-0000-4000-8000-999999999999", phone, "allow");
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain("not one this server is holding");
  });
});
