/*
 * THE CLI'S HALF OF "AM I ALONE IN HERE": CLI → server → window → answer.
 *
 * The relay-level contract is pinned in browser-ownership.test.ts. What that
 * file cannot see is the part an agent actually experiences: whether the notice
 * is printed, whether it goes to stderr or corrupts the JSON on stdout, and
 * whether the exit code an agent branches on is the one the docstring promises.
 *
 * Every one of those has been wrong here before. The `--make`/`--drop` flags
 * were parsed and never sent, so `profiles --drop mine` printed a success and
 * left the container where it was — measured by a peer session: 31 dropped one
 * by one, 41 still listed. A notice on stdout is the same class of failure with
 * the parties swapped: an agent pipes the answer into `jq` and gets a parse
 * error instead of a browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const MCP = new URL("../../bin/agentglass-browser-mcp", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
let answers: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
let asked: string[] = [];
const CLIENT = "test-window-ownership";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-own-cli-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      /* The ownership ledger lands under this, never the operator's own
         ~/.config — the path is resolved per call precisely so this works. */
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_STATE_DIR: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  await openWindow();
}, SERVER_BOOT_MS);

afterAll(() => {
  try { ws?.close(); } catch { /* already gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

async function openWindow() {
  try { ws?.close(); } catch { /* fine */ }
  ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws!.addEventListener("open", r));
  ws.addEventListener("message", async (ev) => {
    let frame: any;
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type !== "browser") return;
    asked.push(frame.data.op);
    const reply = answers[frame.data.op] ?? { ok: false, error: "the stand-in was not told what to say" };
    await fetch(base + "/browser/result", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ id: frame.data.id, ...reply }),
    });
  });
  await fetch(base + "/browser/ready", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ client: CLIENT, on: true }),
  });
  await Bun.sleep(150);
}

/** The CLI, with a scratch cache so `my-tabs.json` is this test's and not the
 *  machine's. `AGENTGLASS_PROFILE` is how a test picks the identity without
 *  having to fake a whole Claude session id. */
async function cli(env: Record<string, string>, ...args: string[]) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      AGENTGLASS_SERVER: base,
      AGENTGLASS_BROWSER_STATE_DIR: join(dir, "cache"),
      ...env,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

/**
 * A whole MCP conversation down one pipe: initialize, the notification that
 * follows it, then the calls.
 *
 * Here because "the CLI can say it" is not the same claim as "an agent can
 * reach it" — this repository shipped seven verbs that were built, tested,
 * green and reachable from neither front door, and nothing noticed because
 * nothing looked at the surfaces together.
 */
async function mcp(messages: unknown[]): Promise<Record<string, unknown>[]> {
  const p = Bun.spawn(["python3", MCP], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const w = p.stdin as { write: (s: string) => void; end: () => void };
  for (const m of messages) w.write(`${JSON.stringify(m)}\n`);
  w.end();
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const HELLO = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } };
const READY = { jsonrpc: "2.0", method: "notifications/initialized" };

/** Two containers, and the tab on screen belongs to the OTHER one. */
const TABS = [
  { id: "t1", title: "Orbit board", url: "https://orbit.example/b", active: false, profile: "orbit-a1b2c3" },
  { id: "t2", title: "Orbit ticket", url: "https://orbit.example/t", active: true, profile: "peer-9f9f9f" },
];

describe.skipIf(!HAVE_PY)("what an agent sees before it acts", () => {
  test("`whoami` prints the pre-flight, on stdout, as JSON, exit 0", async () => {
    answers = { tabs: { ok: true, value: TABS } };
    const r = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "whoami");
    expect(r.code).toBe(0);
    /* Parsed, not matched: an agent pipes this into `jq`, and a notice that
       leaked onto stdout would make that throw rather than answer. */
    const v = JSON.parse(r.out);
    expect(v.you.identity).toBe("orbit-a1b2c3");
    /* No tab was ever opened in this scratch cache, so this is the state
       REQ-2's refusal points at, and it is reported rather than guessed. */
    expect(v.you.tabLive).toBe(false);
    expect(v.activeTab.profile).toBe("peer-9f9f9f");
  });

  test("the no-tab refusal points at `whoami`, so the next move is one call away", async () => {
    answers = { read: { ok: true, value: { url: "u", title: "t", text: "x" } } };
    asked = [];
    const r = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "read");
    expect(r.code).toBe(1);
    expect(r.err).toContain("whoami");
    /* And nothing reached the window: a refusal that still drives somebody
       else's page is not a refusal. */
    expect(asked).toEqual([]);
  });

  test("`profiles` keeps `names` and adds who owns the screen", async () => {
    answers = {
      tabs: { ok: true, value: TABS },
      profiles: { ok: true, value: { profiles: ["orbit-a1b2c3", "peer-9f9f9f"] } },
    };
    const r = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "profiles");
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out);
    expect(v.names).toEqual(["orbit-a1b2c3", "peer-9f9f9f"]);
    const owning = v.profiles.filter((p: any) => p.ownsActive);
    expect(owning).toHaveLength(1);
    expect(owning[0].name).toBe("peer-9f9f9f");
  });

  test("a --as name longer than 24 characters says it was cut, and to what", async () => {
    answers = { tabs: { ok: true, value: TABS } };
    const long = "orbit-billing-regression-checkout";   // 33 characters
    const r = await cli({}, "--as", long, "whoami");
    expect(r.code).toBe(0);
    /*
     * §13(b). The cap was silent, so two long, deliberately distinct names
     * that differ only past character 24 became ONE identity — one container,
     * one cookie jar, one remembered tab — and nothing anywhere said so. The
     * notice names the cut so a caller can see the collision it is walking
     * into, and it goes to stderr so the JSON on stdout still parses.
     */
    expect(r.err).toContain(long.slice(0, 24));
    expect(r.err).toContain("24");
    expect(JSON.parse(r.out).you.identity).toBe(long.slice(0, 24));
  });

  test("joining a container that already holds somebody's tabs says so, and still works", async () => {
    answers = {
      tabs: { ok: true, value: TABS },
      profiles: { ok: true, value: { profiles: ["orbit-a1b2c3", "peer-9f9f9f"] } },
    };
    /*
     * §13(a). THE INCIDENT, in one command. This shell has never opened a tab
     * in `peer-9f9f9f` — its cache is empty — and yet the container exists and
     * holds a live tab. Minting a container and joining one somebody else made
     * are the same gesture, so the only way to tell them apart is this: the
     * tabs are already there and none of them is mine.
     */
    const r = await cli({ AGENTGLASS_PROFILE: "peer-9f9f9f" }, "tabs");
    expect(r.code).toBe(0);                    // a notice, not a refusal
    expect(r.err).toContain("peer-9f9f9f");
    expect(r.err).toContain("JOINING");
    /* The answer is still clean JSON on stdout. */
    expect(JSON.parse(r.out)).toHaveLength(2);
  });

  test("`open --as` into a container somebody is already in says so, from the answer it got", async () => {
    /*
     * The gesture the incident was made of. This shell has never opened a tab
     * in `peer-9f9f9f`, so the CLI sends `profile: peer-9f9f9f` and the panel
     * makes a tab in the container that ALREADY EXISTS — same cookies, same
     * login, same storage as whoever made it. `ok: true`, and until now not one
     * word about which of the two things just happened.
     *
     * Read from the reply's own tab list rather than from a `tabs` call in
     * front of the open: a pre-flight cost a second round trip on the most-used
     * verb and a second line in every audit, and two existing locks read
     * `askedArgs[0]` expecting the open to be the first thing sent.
     */
    answers = {
      open: {
        ok: true,
        value: {
          id: "t-new", url: "https://orbit.example/", title: "Orbit",
          tabs: [...TABS, { id: "t-new", title: "Orbit", url: "https://orbit.example/", active: true, profile: "peer-9f9f9f" }],
        },
      },
    };
    const r = await cli({ AGENTGLASS_PROFILE: "peer-9f9f9f" }, "open", "https://orbit.example/");
    expect(r.code).toBe(0);
    expect(r.err).toContain("JOINING");
    /* One tab in that container is not this one — that is the whole signal. */
    expect(r.err).toContain("1 tab");
  });

  test("and an `open` that really did mint a fresh container says nothing", async () => {
    answers = {
      open: {
        ok: true,
        value: {
          id: "t-solo", url: "https://orbit.example/", title: "Orbit",
          tabs: [...TABS, { id: "t-solo", title: "Orbit", url: "https://orbit.example/", active: true, profile: "solo-1234" }],
        },
      },
    };
    const r = await cli({ AGENTGLASS_PROFILE: "solo-1234" }, "open", "https://orbit.example/");
    expect(r.code).toBe(0);
    /* The tab it just made is excluded from the count, or every first `open`
       would warn about itself — which is the fastest way to teach a reader to
       ignore this line. */
    expect(r.err).toBe("");
  });

  test("and it stays quiet for a container that is genuinely yours and empty", async () => {
    answers = { tabs: { ok: true, value: TABS } };
    /* Nobody has a tab in `alone-here`, so there is nothing to warn about.
       A notice that fires when there is no collision is worse than none: it
       trains a reader to skip the line that matters. */
    const r = await cli({ AGENTGLASS_PROFILE: "alone-here" }, "tabs");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });

  test("the MCP reaches both of them, and the answers round-trip", async () => {
    answers = {
      tabs: { ok: true, value: TABS },
      profiles: { ok: true, value: { profiles: ["orbit-a1b2c3", "peer-9f9f9f"] } },
    };
    const said = await mcp([HELLO, READY,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_whoami", arguments: { identity: "orbit-a1b2c3", tab: "t1" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_profiles", arguments: { identity: "orbit-a1b2c3" } } },
    ]);
    const text = (m: Record<string, unknown>) =>
      JSON.parse(((m.result as any).content[0].text as string));

    /* An identity that says which tab it holds is told whether that tab is
       still there — the half of the question the window can answer. */
    const me = text(said[1]!);
    expect(me.you.tabLive).toBe(true);
    expect(me.activeTab.profile).toBe("peer-9f9f9f");

    /* And the old flat list is still reachable through the MCP, under
       `names`, which is the whole migration REQ-11 asks a caller to make. */
    const all = text(said[2]!);
    expect(all.names).toEqual(["orbit-a1b2c3", "peer-9f9f9f"]);
    expect(all.profiles.find((p: any) => p.name === "peer-9f9f9f").ownsActive).toBe(true);
  });

  test("`profiles --drop` on somebody else's container is refused, exit 1, nothing sent", async () => {
    answers = {
      tabs: { ok: true, value: TABS },
      profiles: { ok: true, value: { dropped: "peer-work" } },
    };
    /* The peer mints it. */
    const made = await cli({ AGENTGLASS_PROFILE: "peer-9f9f9f" }, "profiles", "--make", "peer-work");
    expect(made.code).toBe(0);

    asked = [];
    const refused = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "profiles", "--drop", "peer-work");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("peer-9f9f9f");
    /* Refused above the wire: the window was never asked to close anything.
       This is the assertion that matters — the exit code alone would also be
       1 if the drop had happened and then something else failed. */
    expect(asked).toEqual([]);

    /* And with --force it goes through. */
    const forced = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "profiles", "--drop", "peer-work", "--force");
    expect(forced.code).toBe(0);
    expect(asked).toEqual(["profiles"]);
  });

  test("dropping your own needs no flag", async () => {
    answers = { profiles: { ok: true, value: { dropped: "mine-work" } } };
    await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "profiles", "--make", "mine-work");
    const r = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "profiles", "--drop", "mine-work");
    expect(r.code).toBe(0);
  });

  test("dropping a container nobody claimed is allowed, and says that is what happened", async () => {
    answers = { profiles: { ok: true, value: { dropped: "from-before" } } };
    const r = await cli({ AGENTGLASS_PROFILE: "orbit-a1b2c3" }, "profiles", "--drop", "from-before");
    expect(r.code).toBe(0);
    /* Every container that predates the ledger is unclaimed, so refusing them
       would strand what is already on disk. Silence, though, reads as "it was
       mine" — which is the assumption this whole change exists to break. */
    expect(r.err).toContain("from-before");
    expect(r.err).toContain("ownership ledger");
  });
});
