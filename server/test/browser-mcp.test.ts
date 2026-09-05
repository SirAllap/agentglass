/*
 * The MCP server an agent talks to, end to end.
 *
 * Same shape as browser-cli.test.ts and for the same reason: what breaks in a
 * thing like this is never the parts, it is the seams — a handshake the client
 * refuses, a notification answered when it must not be, a tool whose schema
 * says one thing and whose call sends another. All of that is invisible from
 * either end alone, and all of it is one process and one socket away here.
 *
 * The window on the other side is a stand-in, because the real one needs
 * Electron. Everything between this file and it is real: the server, the relay,
 * the JSON-RPC over stdio.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const MCP = new URL("../../bin/agentglass-browser-mcp", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
let answers: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
let asked: string[] = [];
const CLIENT = "test-window-mcp";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-mcp-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
      // State (audit log, ledgers, engine conf) jailed too: without this a booted
      // server writes into the developer's real ~/.local/state/agentglass.
      AGENTGLASS_STATE_DIR: `${dir}/state`,
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
    let frame: { type?: string; data?: { op?: string; id?: string } };
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type !== "browser" || !frame.data) return;
    asked.push(frame.data.op ?? "");
    const reply = answers[frame.data.op ?? ""] ?? { ok: false, error: "the stand-in was not told what to say" };
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

/**
 * A whole conversation, the way a client has one: initialize, the notification
 * that follows it, then the calls — down one pipe, in order.
 */
async function talk(messages: unknown[]): Promise<Record<string, unknown>[]> {
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

const hello = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } };
const ready = { jsonrpc: "2.0", method: "notifications/initialized" };

describe.skipIf(!HAVE_PY)("the MCP server", () => {
  test("shakes hands and names itself", async () => {
    const [r] = await talk([hello]);
    const result = r!.result as { serverInfo: { name: string }; capabilities: { tools: unknown } };
    expect(result.serverInfo.name).toBe("agentglass-browser");
    expect(result.capabilities.tools).toBeDefined();
  });

  /*
   * A notification has no id and takes no answer. Replying to one is a protocol
   * error, and `notifications/initialized` is the one EVERY client sends — so
   * getting this wrong breaks the handshake with all of them.
   */
  test("says nothing back to a notification", async () => {
    const said = await talk([hello, ready]);
    expect(said).toHaveLength(1);
  });

  test("lists tools that carry their own schemas", async () => {
    const said = await talk([hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const tools = (said[1]!.result as { tools: { name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }[] }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("browser_open");
    expect(names).toContain("browser_read");
    expect(names).toContain("browser_shot");
    // The one that matters for a model: a required argument said out loud.
    const open = tools.find((t) => t.name === "browser_open")!;
    expect(open.inputSchema.required).toEqual(["url"]);
    /*
     * `eval` IS here now, and the premise it violated has been retired.
     *
     * This used to assert that no verb could run arbitrary script — "the whole
     * point of going through the relay instead of CDP". That was the right
     * fence while the browser was a human's, lent out. It is not, any more:
     * "the browser is for agents, not for humans", and an agent without eval
     * cannot reach the app's own runtime at all. Somebody spent a session
     * writing unit tests to find out what a component was holding, because
     * this test existed.
     *
     * The fence that replaces it is not a missing verb, it is §16 of the
     * specification: which origins may be reached, a read-only mode, an
     * auditable log of everything touched, and automatic redaction of secrets
     * — the last one being the exact failure that got Playwright's MCP banned
     * here, when it autofilled a real password into a transcript.
     *
     * That fence is built now — see browserdrive.test.ts's "§16" block for
     * the four of them enforced and tested: AGENTGLASS_BROWSER_ORIGINS,
     * AGENTGLASS_BROWSER_READONLY, GET /browser/audit, and redaction applied
     * to both the audit log and every reply a verb returns. It lives in
     * parseAsk/askBrowser — the one seam both this MCP server and the CLI
     * relay through — so `eval` is not a missing lock any more; it is a
     * fenced verb like every other one here.
     */
    expect(names).toContain("browser_eval");
    expect(names).toContain("browser_observe");
  });

  /*
   * `shared: true` on the three below, from the day a call with no tab in it
   * stopped being sent to whichever tab was in front. These tests are about
   * the TRANSPORT — a call reaching the window, a refusal coming back as a
   * result, a PNG arriving as an image — and `shared` is the documented way to
   * say "the active tab, deliberately", so it keeps each of them testing the
   * one thing it is named after. Which tab a call is addressed to is the
   * subject of the block below, against a recorder that can show the body.
   */
  test("a call reaches the window and comes back as text", async () => {
    await openWindow();
    asked = [];
    answers = { read: { ok: true, value: { url: "https://orbit.example/", title: "Orbit", text: "a page" } } };
    const said = await talk([hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_read", arguments: { shared: true } } }]);
    expect(asked).toEqual(["read"]);
    const content = (said[1]!.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("Orbit");
    expect(content[0]!.text).toContain("a page");
  });

  test("a refusal from the page is an error result, not a crash", async () => {
    await openWindow();
    answers = { click: { ok: false, error: "nothing on the page matches #gone" } };
    const said = await talk([hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_click", arguments: { selector: "#gone", shared: true } } }]);
    const result = said[1]!.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("#gone");
  });

  /* A screenshot is an image, not a wall of base64 in a text block: a model
     that has to be told "this is a PNG" cannot look at it. */
  test("a screenshot comes back as an image", async () => {
    await openWindow();
    answers = { shot: { ok: true, value: { url: "u", title: "t", png: "data:image/png;base64,iVBORw0KGgo=" } } };
    const said = await talk([hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_shot", arguments: { shared: true } } }]);
    const content = (said[1]!.result as { content: { type: string; data?: string; mimeType?: string }[] }).content;
    expect(content[0]!.type).toBe("image");
    expect(content[0]!.mimeType).toBe("image/png");
    expect(content[0]!.data).toBe("iVBORw0KGgo=");
  });

  test("an unknown method is answered as one rather than ignored", async () => {
    const said = await talk([hello, { jsonrpc: "2.0", id: 9, method: "resources/list" }]);
    expect((said[1]!.error as { code: number }).code).toBe(-32601);
  });
});

/*
 * ── Every tool goes to the client's OWN tab ────────────────────────────────
 *
 * THE INCIDENT: "another agent was getting into that container and putting
 * its data on that screen… the other agent was going in to take screenshots
 * and couldn't, because the first one was overwriting on top of it." One
 * agent's run was being overwritten by another that believed it was isolated.
 *
 * The mechanism is that a request naming no tab is not "unspecified" to the
 * relay — it is "the tab in front", whoever owns it. The MCP surface named no
 * tab on any of its 65 tools: `grep -c 'my_name\|my_tab\|remember_tab'` over
 * bin/agentglass-browser-mcp returned 0.
 *
 * These tests watch the BODY THAT LEAVES THE PROCESS, against a recorder that
 * stands in for the server, because that is where the bug lived: every one of
 * these calls answered `ok` before the fix too. The seam to the real server
 * and the real relay is covered by the block above; what is new here is which
 * tab the request is addressed to, and only the wire can say.
 */
describe.skipIf(!HAVE_PY)("the MCP surface addresses its own tab", () => {
  let rec: ReturnType<typeof Bun.serve> | null = null;
  let recBase = "";
  let sent: { op: string; body: Record<string, unknown> }[] = [];
  /* `steps` is here because `do` answers per step rather than with a value —
     the stand-in has to be able to say what that verb actually says. */
  let says: Record<string, { ok: boolean; value?: unknown; error?: string; steps?: unknown[] }> = {};
  const states: string[] = [];

  beforeAll(() => {
    rec = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        /* GET is only /browser-use/status, which the server asks before it
           waits for a window that is still starting. */
        if (req.method !== "POST") return Response.json({ windows: 1 });
        const op = new URL(req.url).pathname.split("/").pop() ?? "";
        sent.push({ op, body: (await req.json()) as Record<string, unknown> });
        return Response.json(says[op] ?? { ok: true, value: { id: "t-made", url: "u", title: "t" } });
      },
    });
    recBase = `http://127.0.0.1:${rec.port}`;
  });

  afterAll(() => {
    try { rec?.stop(true); } catch { /* already gone */ }
    for (const s of states) { try { rmSync(s, { recursive: true, force: true }); } catch { /* fine */ } }
  });

  /** A fresh tab map. Two of these are two agents who have never met. */
  function freshState() {
    const s = mkdtempSync(join(tmpdir(), "agx-mcp-tabs-"));
    states.push(s);
    return s;
  }

  /** One MCP client, start to finish: its own identity, its own tab map. */
  async function client(profile: string, state: string, calls: { name: string; arguments: Record<string, unknown> }[]) {
    const p = Bun.spawn(["python3", MCP], {
      env: {
        PATH: process.env.PATH ?? "",
        AGENTGLASS_SERVER: recBase,
        AGENTGLASS_BROWSER_STATE_DIR: state,
        AGENTGLASS_PROFILE: profile,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const w = p.stdin as { write: (s: string) => void; end: () => void };
    w.write(`${JSON.stringify(hello)}\n`);
    w.write(`${JSON.stringify(ready)}\n`);
    calls.forEach((c, i) => w.write(`${JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: c })}\n`));
    w.end();
    const out = await new Response(p.stdout).text();
    await p.exited;
    const lines = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: number; result: { content: { text?: string }[]; isError?: boolean } });
    return lines.filter((l) => l.id >= 100).map((l) => l.result);
  }

  async function toolList(): Promise<{ name: string; inputSchema: { properties?: Record<string, { enum?: unknown[] }> } }[]> {
    const p = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: recBase },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const w = p.stdin as { write: (s: string) => void; end: () => void };
    w.write(`${JSON.stringify(hello)}\n`);
    w.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    w.end();
    const out = await new Response(p.stdout).text();
    await p.exited;
    const said = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return (said[1]!.result as { tools: { name: string; inputSchema: { properties?: Record<string, { enum?: unknown[] }> } }[] }).tools;
  }

  /*
   * THE ACCEPTANCE CRITERION, as an effect rather than a promise: every tool
   * whose schema advertises `page` must actually put it on the wire.
   *
   * It is written as "advertise it, then prove you send it" because the
   * opposite is exactly what shipped on the other binary — six CLI verbs
   * declared `--page` and one sent it, so `shot --page t2-abc` photographed
   * the ACTIVE tab and answered as though it had not. On this side the same
   * thing was worse: `browser_shot` had no branch in the dispatch chain at
   * all, so its body left as `{}` and the advertised `page` was dropped
   * before the request went out.
   */
  test("every tool that advertises `page` puts it on the wire", async () => {
    const tools = await toolList();
    /* `browser_settings`'s `page` is NOT a tab — it is the internal page a
       webview may render, and "blank" is its only allowed value. An enum is
       how it says so, and putting a tab id there made every settings call
       answer `page must be "blank"`, a sentence about an argument the caller
       never passed. */
    const targetable = tools.filter((t) => t.inputSchema.properties?.page && !t.inputSchema.properties.page.enum);
    expect(targetable.length).toBeGreaterThan(50);

    sent = [];
    says = {};
    await client("orbit-wire", freshState(), targetable.map((t) => ({
      name: t.name,
      /* `do` is the one that cannot take a bare page: the server's `do` route
         hands `b.steps` to runSteps and never reads `b.page`, so the id has to
         ride each step. Give it a step to ride. */
      arguments: t.name === "browser_do"
        ? { page: "t-lock", steps: [{ op: "click", args: { selector: "#x" } }] }
        : { page: "t-lock" },
    })));

    const missed: string[] = [];
    for (const t of targetable) {
      const verb = t.name.slice("browser_".length);
      const req = sent.find((s) => s.op === verb);
      if (!req) { missed.push(`${t.name}: no request left the process`); continue; }
      if (verb === "do") {
        const steps = req.body.steps as { args?: { page?: string } }[];
        if (steps?.[0]?.args?.page !== "t-lock") missed.push(`${t.name}: the page did not reach the steps`);
      } else if (req.body.page !== "t-lock") {
        missed.push(`${t.name}: sent ${JSON.stringify(req.body)}`);
      }
    }
    expect(missed).toEqual([]);
  });

  /*
   * The criterion in the owner's words: two clients driving one browser, and
   * neither one's read comes back with the other's page.
   */
  test("two clients open in two containers and read their own tab", async () => {
    sent = [];
    says = { open: { ok: true, value: { id: "t-a", url: "u", title: "t" } } };
    await client("orbit-a", freshState(), [{ name: "browser_open", arguments: { url: "https://orbit.example/a" } }]);
    says = { open: { ok: true, value: { id: "t-b", url: "u", title: "t" } } };
    const stateB = freshState();
    await client("orbit-b", stateB, [{ name: "browser_open", arguments: { url: "https://orbit.example/b" } }]);

    const opens = sent.filter((s) => s.op === "open");
    expect(opens.map((o) => o.body.profile)).toEqual(["orbit-a", "orbit-b"]);
    /* Two DISTINCT containers, which is what makes them two people rather than
       one person in two windows. */
    expect(new Set(opens.map((o) => o.body.profile)).size).toBe(2);

    /* And the tab each one minted is the tab each one reads. B goes second on
       purpose: before this change its read carried no page at all, so the
       relay sent it to whatever was in front — A's page. */
    sent = [];
    says = { read: { ok: true, value: { url: "u", title: "t", text: "x" } } };
    await client("orbit-b", stateB, [{ name: "browser_read", arguments: {} }]);
    expect(sent.find((s) => s.op === "read")?.body.page).toBe("t-b");
    expect(sent.find((s) => s.op === "read")?.body.page).not.toBe("t-a");
  });

  /*
   * A REFUSAL RATHER THAN A FALL-THROUGH, and the proof is that NOTHING
   * REACHES THE WIRE. A client loses its tab whenever the app restarts, which
   * invalidates every agent's remembered id at once — so this is not a mistake
   * anybody has to make.
   */
  test("a client with no tab is refused, and no request goes out", async () => {
    sent = [];
    says = {};
    const [res] = await client("orbit-c", freshState(), [{ name: "browser_read", arguments: {} }]);
    expect(res!.isError).toBe(true);
    expect(res!.content[0]!.text).toContain("orbit-c");
    expect(res!.content[0]!.text).toContain("no tab open");
    expect(sent).toEqual([]);
  });

  /* And the refusal is answerable: `shared` is how you say "the tab in front,
     deliberately", and it clears the identity rather than naming a tab. */
  test("`shared` is the way to say the active tab on purpose", async () => {
    sent = [];
    says = { read: { ok: true, value: { url: "u", title: "t", text: "x" } } };
    await client("orbit-c", freshState(), [{ name: "browser_read", arguments: { shared: true } }]);
    const req = sent.find((s) => s.op === "read");
    expect(req).toBeDefined();
    expect(req!.body.page).toBeUndefined();
    /* `shared` says WHO, not WHAT: it must not travel to the relay as part of
       the verb's body. */
    expect(req!.body.shared).toBeUndefined();
  });

  /* `profile` reaches the identity on every acting tool, not just on the two
     that put a container on the wire — the refusal naming it is the proof,
     because the name in that sentence can only have come from the argument. */
  test("`profile` chooses whose tab, on every acting tool", async () => {
    sent = [];
    says = {};
    const [res] = await client("orbit-c", freshState(), [{ name: "browser_click", arguments: { selector: "#x", profile: "orbit-zz" } }]);
    expect(res!.isError).toBe(true);
    expect(res!.content[0]!.text).toContain("orbit-zz");
    expect(sent).toEqual([]);
  });

  /* browser_open used to be `{"url": ...}` and nothing else, and its sibling's
     description said the consequence out loud: "browser_open still replaces
     the current view". */
  test("browser_open can express a container and a tab", async () => {
    const open = (await toolList()).find((t) => t.name === "browser_open")!;
    expect(open.inputSchema.properties?.profile).toBeDefined();
    expect(open.inputSchema.properties?.page).toBeDefined();
  });

  /*
   * ONE MAP, NOT TWO. The identity rules are a literal copy of
   * bin/agentglass-browser's until they live in a module both import, and a
   * copy that drifts is worse than no copy: a session's shell and its MCP
   * client would become the two agents this whole change is about. So both
   * files are asked, by running them, what they call this client and where
   * they keep the map — and the answers have to match.
   */
  test("the CLI and the MCP server agree on the identity and the tab map", async () => {
    const probe = `
import json
out = []
for f in ${JSON.stringify([new URL("../../bin/agentglass-browser", import.meta.url).pathname, MCP])}:
    ns = {"__name__": "probe"}
    exec(compile(open(f).read(), f, "exec"), ns)
    out.append([ns["my_name"](), ns["_tabs_path"]()])
print(json.dumps(out))
`;
    const p = Bun.spawn(["python3", "-c", probe], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_PROFILE: "orbit-same", AGENTGLASS_BROWSER_STATE_DIR: "/tmp/agx-lock" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const [cli, mcp] = JSON.parse(out.trim()) as [string, string][];
    expect(cli).toEqual(mcp!);
    expect(cli![1]).toBe("/tmp/agx-lock/my-tabs.json");
  });

  /*
   * THE ARGUMENTS OF 21 TOOLS WENT NOWHERE. Every verb without a branch in the
   * dispatch chain left the body at `{}`, so what its schema promised never
   * reached the relay — measured over TOOLS and that chain: 21 of the 57 tools
   * that take arguments dropped all 55 of their declared properties. The tool
   * answered as though it had worked, because a verb with an empty body is a
   * valid request that does something else.
   */
  test("a tool's own arguments reach the relay", async () => {
    sent = [];
    says = { eval: { ok: true, value: { result: 2 } }, upload: { ok: true, value: {} } };
    const state = freshState();
    says.open = { ok: true, value: { id: "t-args", url: "u", title: "t" } };
    await client("orbit-args", state, [
      { name: "browser_open", arguments: { url: "https://orbit.example/" } },
      { name: "browser_eval", arguments: { js: "1+1" } },
      { name: "browser_upload", arguments: { selector: "#f", paths: ["/tmp/a.txt"] } },
    ]);
    expect(sent.find((s) => s.op === "eval")?.body.js).toBe("1+1");
    expect(sent.find((s) => s.op === "upload")?.body.paths).toEqual(["/tmp/a.txt"]);
  });

  /* `lanes` is the one thing this surface can express and the CLI cannot —
     several pages at once, each with its own steps. Addressing must not cost
     it: a lane that names a page keeps it, a lane that does not gets ours. */
  test("lanes keep their own pages and inherit ours", async () => {
    sent = [];
    says = { open: { ok: true, value: { id: "t-lane", url: "u", title: "t" } }, do: { ok: true, steps: [] } };
    const state = freshState();
    await client("orbit-lanes", state, [
      { name: "browser_open", arguments: { url: "https://orbit.example/" } },
      { name: "browser_do", arguments: { lanes: [
        { page: "t-other", steps: [{ op: "click", args: {} }] },
        { steps: [{ op: "click", args: {} }] },
      ] } },
    ]);
    const lanes = sent.find((s) => s.op === "do")?.body.lanes as { page?: string }[];
    expect(lanes?.map((l) => l.page)).toEqual(["t-other", "t-lane"]);
  });

  test("a mint and a drop carry `identity`, so a container this surface makes has a creator", async () => {
    sent = [];
    says = {
      newtab: { ok: true, value: { id: "t-made", url: "u", title: "t" } },
      profiles: { ok: true, value: { profiles: [] } },
    };
    const state = freshState();
    await client("orbit-maker", state, [
      { name: "browser_newtab", arguments: { url: "https://orbit.example/", profile: "mcp-made" } },
      { name: "browser_profiles", arguments: { drop: "mcp-made", force: true } },
      { name: "browser_profiles", arguments: { drop: "mcp-made", identity: "somebody-else" } },
    ]);
    /* On this surface a named `profile` IS the identity — the same rule as
       the CLI's `--as`, where the name and the container are one thing. */
    expect(sent.map((s) => s.body.identity)).toEqual(["mcp-made", "orbit-maker", "somebody-else"]);
    expect(sent[1]!.body.force).toBe(true);
    expect(sent[2]!.body.force).toBeUndefined();
  });

  test("the schema declares what the refusal asks for", async () => {
    const tools = await toolList();
    /* And the escape hatch the release note offers: a client reading the
       schema could not discover `shared` on `browser_newtab`. */
    const newtab = tools.find((t) => t.name === "browser_newtab")!;
    expect(Object.keys(newtab.inputSchema.properties ?? {})).toContain("shared");
    const profiles = tools.find((t) => t.name === "browser_profiles")!;
    expect(Object.keys(profiles.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["force", "identity"]));
  });

  test("the CLI and the MCP derive the SAME identity from the same session, with no profile named", () => {
    /* The identity block is a literal copy, and the only lock ran both with
       AGENTGLASS_PROFILE set — which returns on the first line, so the stem,
       the seed chain and both caps were never compared. */
    const derive = (file: string) => Bun.spawnSync(["python3", "-c", [
      "import importlib.machinery, importlib.util, sys",
      `loader = importlib.machinery.SourceFileLoader("under_test", ${JSON.stringify(file)})`,
      'spec = importlib.util.spec_from_loader("under_test", loader)',
      "m = importlib.util.module_from_spec(spec); loader.exec_module(m)",
      "print(m.my_name(None))",
    ].join("\n")], {
      env: { PATH: process.env.PATH ?? "", CLAUDE_PROJECT_ROOT: "/tmp/orbit workspace-long-name", CLAUDE_CODE_SESSION_ID: "sess-9f9f9f-ABCDEF123" },
    }).stdout.toString().trim();
    const cli = derive(new URL("../../bin/agentglass-browser", import.meta.url).pathname);
    const mcp = derive(new URL("../../bin/agentglass-browser-mcp", import.meta.url).pathname);
    expect(cli.length).toBeGreaterThan(0);
    expect(mcp).toBe(cli);
    expect(cli.length).toBeLessThanOrEqual(24);
  });

  test("two identities on ONE state dir keep two entries — the map is shared, not clobbered", async () => {
    sent = [];
    says = { open: { ok: true, value: { id: "t-A", url: "u", title: "t" } }, read: { ok: true, value: { url: "u", title: "t", text: "" } } };
    const state = freshState();
    await client("orbit-a", state, [{ name: "browser_open", arguments: { url: "https://orbit.example/a" } }]);
    says.open = { ok: true, value: { id: "t-B", url: "u", title: "t" } };
    await client("orbit-b", state, [{ name: "browser_open", arguments: { url: "https://orbit.example/b" } }]);
    const held = JSON.parse(readFileSync(join(state, "my-tabs.json"), "utf8"));
    expect(held).toEqual({ "orbit-a": "t-A", "orbit-b": "t-B" });
    sent = [];
    await client("orbit-a", state, [{ name: "browser_read", arguments: {} }]);
    await client("orbit-b", state, [{ name: "browser_read", arguments: {} }]);
    expect(sent.map((s) => s.body.page)).toEqual(["t-A", "t-B"]);
  });

  test("a second `open` reuses your tab, `closetab` forgets it, and `settings` never carries a page", async () => {
    sent = [];
    says = {
      open: { ok: true, value: { id: "t-one", url: "u", title: "t" } },
      closetab: { ok: true, value: [] },
      settings: { ok: true, value: {} },
      read: { ok: true, value: { url: "u", title: "t", text: "" } },
    };
    const state = freshState();
    const out = await client("orbit-reuse", state, [
      { name: "browser_open", arguments: { url: "https://orbit.example/one" } },
      { name: "browser_open", arguments: { url: "https://orbit.example/two" } },
      { name: "browser_settings", arguments: {} },
      { name: "browser_closetab", arguments: { id: "t-one" } },
      { name: "browser_read", arguments: {} },
    ]);
    expect(sent.map((s) => s.op)).toEqual(["open", "open", "settings", "closetab"]);
    /* Second open: the same tab, not a new mint. */
    expect(sent[1]!.body.page).toBe("t-one");
    expect(sent[1]!.body.profile).toBeUndefined();
    /* `settings` is a TAB_OP: a tab id in its `page` is answered "page must be blank". */
    expect(sent[2]!.body.page).toBeUndefined();
    /* After the close, the identity has no tab and the read is refused, not sent bare. */
    expect(out[4]!.isError).toBe(true);
  });

  /* The panel's cross-container check reads `as` and treats its absence as
     "cannot tell" — and allows. A surface that never sends it is a surface the
     check never sees, however carefully it addresses its tabs. */
  test("every request says who is asking, and whether the agent named the tab itself", async () => {
    sent = [];
    says = {
      open: { ok: true, value: { id: "t-me", url: "u", title: "t" } },
      click: { ok: true, value: {} },
      do: { ok: true, steps: [] },
    };
    const state = freshState();
    await client("orbit-named", state, [
      { name: "browser_open", arguments: { url: "https://orbit.example/" } },
      { name: "browser_click", arguments: { selector: "#go" } },
      { name: "browser_click", arguments: { selector: "#go", page: "t-other" } },
      { name: "browser_do", arguments: { steps: [{ op: "read", args: {} }] } },
    ]);
    expect(sent.map((s) => s.op)).toEqual(["open", "click", "click", "do"]);
    expect(sent.map((s) => s.body.as)).toEqual(["orbit-named", "orbit-named", "orbit-named", "orbit-named"]);
    expect(sent.map((s) => s.body.how)).toEqual(["own-container", "own-tab", "explicit-page", "own-tab"]);
    expect(sent.map((s) => s.body.pageExplicit)).toEqual([undefined, undefined, true, undefined]);
  });
});
