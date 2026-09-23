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
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
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
/** The args of every ask, for the tests that are about what the tool sent. */
let askedArgs: Record<string, unknown>[] = [];
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
    let frame: { type?: string; data?: { op?: string; id?: string; args?: Record<string, unknown> } };
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type !== "browser" || !frame.data) return;
    asked.push(frame.data.op ?? "");
    askedArgs.push(frame.data.args ?? {});
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

  test("browser_observe takes delta, and it reaches the window", async () => {
    await openWindow();
    asked = []; askedArgs = [];
    answers = { observe: { ok: true, value: { delta: true, url: "u", title: "t", added: [], removed: [], changed: [], same: 3 } } };
    const said = await talk([
      hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_observe", arguments: { delta: true, shared: true } } },
    ]);
    const tools = (said[1]!.result as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }).tools;
    expect(Object.keys(tools.find((t) => t.name === "browser_observe")!.inputSchema.properties ?? {})).toContain("delta");
    expect(asked).toEqual(["observe"]);
    expect(askedArgs[0]!.delta).toBe(true);
  });

  test("a locator reaches the window exactly as written, and the instructions say what one is", async () => {
    await openWindow();
    asked = []; askedArgs = [];
    answers = { click: { ok: true, value: { clicked: "x", url: "u", title: "t" } } };
    const loc = 'role=button[name="Save changes"]';
    const said = await talk([
      hello, ready,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_click", arguments: { selector: loc, shared: true } } },
    ]);
    expect(asked).toEqual(["click"]);
    expect(askedArgs[0]!.selector).toBe(loc);
    const init = said[0]!.result as { instructions?: string };
    expect(init.instructions).toContain("role=button[name=");
    expect(init.instructions).toContain("label=");
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
  /*
   * THE ONE SCHEMA BUG THAT SHIPPED, AND THE CLASS AROUND IT.
   *
   * `browser_profiles` once carried TWO `description` keys — Python keeps the
   * last, so the tool an agent saw described the CDP protocol, and its schema
   * merged CDP's `method`/`params`/`events` into the profiles surface. That is
   * the MCP playing a different game from the relay it forwards to. This check
   * parses the TOOLS literal itself, so the class — a repeated literal key
   * (last wins), a schema field that names another tool's verb — is held
   * mechanically rather than by remembering to look at one dict.
   */
  test("every tool dict is exactly one tool's schema", async () => {
    const dump = `
import ast, json
tree = ast.parse(open(${JSON.stringify(MCP)}).read())
tools = None
for node in ast.walk(tree):
    if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "TOOLS" for t in node.targets):
        tools = node.value
out = []
for el in tools.elts:
    keys = [k.value for k in el.keys]
    props = {}
    for k, v in zip(el.keys, el.values):
        if k.value == "name": name = v.value
        if k.value == "inputSchema":
            for a, b in zip(v.keys or [], v.values or []):
                if a.value == "properties":
                    props = sorted(p.value for p in b.keys)
    dup = sorted(k for k in set(keys) if keys.count(k) > 1)
    out.append({"name": name, "props": props, "dup": dup})
print(json.dumps(out))
`;
    const p = Bun.spawn(["python3", "-c", dump], {
      env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    const tools = JSON.parse(out.trim()) as { name: string; props: string[]; dup: string[] }[];
    expect(tools.length).toBeGreaterThan(60);
    for (const t of tools) expect(t.dup, `${t.name}: repeated literal key — last wins`).toEqual([]);
    const profiles = tools.find((t) => t.name === "browser_profiles")!;
    /* CDP's `method`/`params`/`events` beside profile CRUD is the exact leak
       this test exists for. */
    expect(profiles.props).toEqual(["drop", "force", "identity", "make"]);
  });

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

describe.skipIf(!HAVE_PY)("browser_checkup", () => {
  /* Two stdlib-only scripts with no module between them, so the picture's
     writer is carried twice — and held equal here, so the MCP copy cannot
     drift back to a file the umask decides the mode of. */
  test("the CLI and the MCP write the picture with the same code", () => {
    const cli = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
    const mcp = readFileSync(new URL("../../bin/agentglass-browser-mcp", import.meta.url), "utf8");
    const fn = (src: string, name: string) => {
      const a = src.indexOf(`def ${name}(`);
      expect(a, `${name} is missing`).toBeGreaterThan(-1);
      return src.slice(a, src.indexOf("\n\n\n", a));
    };
    for (const name of ["_checkup_shot", "_write_private"]) expect(fn(mcp, name)).toBe(fn(cli, name));
    expect(mcp).toContain("CHECKUP_SHOTS_KEPT = 20");
    expect(cli).toContain("CHECKUP_SHOTS_KEPT = 20");
  });

  test("exists, and its url, reload, noShot and settleMs reach the window", async () => {
    await openWindow();
    asked = []; askedArgs = [];
    answers = { checkup: { ok: true, value: { verdict: "ok", url: "http://localhost:5173/", title: "Orbit" } } };
    const said = await talk([
      hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_checkup", arguments: { url: "http://localhost:5173/", noShot: true, shared: true } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser_checkup", arguments: { reload: true, settleMs: 2000, shared: true } } },
    ]);
    const tools = (said[1]!.result as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] }).tools;
    const tool = tools.find((t) => t.name === "browser_checkup");
    expect(tool).not.toBeUndefined();
    expect(Object.keys(tool!.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["url", "reload", "noShot", "settleMs"]));
    expect(asked).toEqual(["checkup", "checkup"]);
    expect(askedArgs[0]).toMatchObject({ url: "http://localhost:5173/", noShot: true });
    expect(askedArgs[1]).toMatchObject({ reload: true, settleMs: 2000 });
    const text = (said[2]!.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(text).verdict).toBe("ok");
  });

  test("a failure's picture comes back as a path to a private file, not an image", async () => {
    await openWindow();
    answers = { checkup: { ok: true, value: { verdict: "1 problem", url: "u", title: "t", errors: ["TypeError: x"], png: "data:image/png;base64,iVBORw0KGgo=" } } };
    const cache = mkdtempSync(join(dir, "mcp-cache-"));
    const p = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, XDG_CACHE_HOME: cache },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const w = p.stdin as { write: (s: string) => void; end: () => void };
    for (const m of [hello, ready, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_checkup", arguments: { shared: true } } }]) {
      w.write(`${JSON.stringify(m)}\n`);
    }
    w.end();
    const out = await new Response(p.stdout).text();
    await p.exited;
    const said = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const content = (said[1]!.result as { content: { type: string; text: string }[] }).content;
    expect(content[0]!.type).toBe("text");
    const v = JSON.parse(content[0]!.text);
    expect(v.png).toBeUndefined();
    expect(v.shot.startsWith(join(cache, "agentglass", "checkup-"))).toBe(true);
    expect(statSync(v.shot).mode & 0o777).toBe(0o600);
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
    /* The composed tools never put their own name on the wire: they are made
       of other verbs, and the page has to reach THOSE. Each is checked on the
       first verb it sends. */
    const COMPOSED: Record<string, string> = { browser_storage_state: "cdp", browser_set_storage_state: "cdp" };
    await client("orbit-wire", freshState(), targetable.map((t) => ({
      name: t.name,
      /* `do` is the one that cannot take a bare page: the server's `do` route
         hands `b.steps` to runSteps and never reads `b.page`, so the id has to
         ride each step. Give it a step to ride. */
      arguments: t.name === "browser_do"
        ? { page: "t-lock", steps: [{ op: "click", args: { selector: "#x" } }] }
        : t.name === "browser_set_storage_state"
          ? { page: "t-lock", state: { cookies: [{ name: "sid", value: "1", domain: "orbit.example", path: "/" }], origins: [] } }
          : { page: "t-lock" },
    })));

    const missed: string[] = [];
    for (const t of targetable) {
      const verb = COMPOSED[t.name] ?? t.name.slice("browser_".length);
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

  /*
   * The session as one object: `browser_storage_state` is `session save`
   * without the file — cookies through CDP so httpOnly ones are in it, the
   * page's storage under its origin, in Playwright's shape — and
   * `browser_set_storage_state` puts one back. Both are made of `cdp` and
   * `eval`, and both parts carry the caller's page, so a state can never be
   * read from, or written onto, a tab the caller did not name.
   */
  test("storage_state reads cookies and storage into Playwright's shape, and set_storage_state writes them back", async () => {
    sent = [];
    says = {
      cdp: { ok: true, value: { result: { cookies: [{ name: "sid", value: "s3cret", domain: ".orbit.example", path: "/", httpOnly: true, secure: true }] } } },
      eval: { ok: true, value: { value: { origin: "https://orbit.example", localStorage: { token: "t1" }, sessionStorage: { step: "2" } } } },
    };
    const [got] = await client("orbit-s", freshState(), [{ name: "browser_storage_state", arguments: { page: "t-s" } }]);
    expect(got!.isError, JSON.stringify(got)).toBeFalsy();
    const state = JSON.parse(got!.content[0]!.text!) as { cookies: unknown[]; origins: unknown[] };
    expect(state.cookies).toEqual([{ name: "sid", value: "s3cret", domain: ".orbit.example", path: "/", httpOnly: true, secure: true }]);
    expect(state.origins).toEqual([{ origin: "https://orbit.example", localStorage: [{ name: "token", value: "t1" }], sessionStorage: [{ name: "step", value: "2" }] }]);
    expect(sent.map((s) => s.op)).toEqual(["cdp", "eval"]);
    expect(sent.every((s) => s.body.page === "t-s"), "both parts went to the named tab").toBe(true);
    expect((sent[0]!.body as { method: string }).method).toBe("Network.getCookies");

    sent = [];
    says = { cdp: { ok: true, value: { result: {} } }, eval: { ok: true, value: { value: { written: true, at: "https://orbit.example" } } } };
    const [put] = await client("orbit-s", freshState(), [{ name: "browser_set_storage_state", arguments: { page: "t-s", state } }]);
    expect(put!.isError, JSON.stringify(put)).toBeFalsy();
    expect(put!.content[0]!.text).toContain("1 of 1 cookies");
    expect(put!.content[0]!.text).toContain("1 localStorage");
    const setCookie = sent.find((s) => s.op === "cdp")!.body as { method: string; params: { url?: string; httpOnly?: boolean } };
    expect(setCookie.method).toBe("Network.setCookie");
    // getCookies answers with a domain and never a url; setCookie wants one.
    expect(setCookie.params.url).toBe("https://orbit.example/");
    expect(setCookie.params.httpOnly).toBe(true);
    const write = sent.find((s) => s.op === "eval")!.body as { js: string; page: string };
    expect(write.js).toContain('"token": "t1"');
    expect(write.js).toContain("sessionStorage.setItem");
    expect(write.page).toBe("t-s");

    // Storage is written only into the origin it came from: the page checks
    // its own location.origin against the state's, and says no otherwise.
    // The first version ran every origin's writes in whatever page was open,
    // so one site's tokens landed in another site's storage, where that
    // site's scripts read them.
    expect(write.js).toContain('"https://orbit.example"');
    expect(write.js).toMatch(/location\.origin/);
    sent = [];
    says = {
      cdp: { ok: true, value: { result: {} } },
      eval: { ok: true, value: { value: { written: false, at: "https://other.example" } } },
    };
    const two = {
      cookies: [],
      origins: [
        { origin: "https://orbit.example", localStorage: [{ name: "token", value: "t1" }], sessionStorage: [] },
        { origin: "https://acme.example", localStorage: [{ name: "token", value: "t2" }], sessionStorage: [] },
      ],
    };
    const [elsewhere] = await client("orbit-s", freshState(), [{ name: "browser_set_storage_state", arguments: { page: "t-s", state: two } }]);
    expect(elsewhere!.isError, JSON.stringify(elsewhere)).toBeFalsy();
    expect(elsewhere!.content[0]!.text).toContain("0 localStorage");
    expect(elsewhere!.content[0]!.text).toContain("https://orbit.example");
    expect(elsewhere!.content[0]!.text).toContain("https://acme.example");
    expect(elsewhere!.content[0]!.text).toContain("https://other.example");
    expect(sent.filter((s) => s.op === "eval").length, "each origin was asked, none was written").toBe(2);

    // A state that is not one is refused before anything goes out.
    sent = [];
    const [bad] = await client("orbit-s", freshState(), [{ name: "browser_set_storage_state", arguments: { page: "t-s", state: "nope" } }]);
    expect(bad!.isError).toBe(true);
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

describe.skipIf(!HAVE_PY)("the MCP server over Streamable HTTP", () => {
  /* The same binary, one `--http` flag later, driven over the wire with fetch.
     The stand-in window is the same one the stdio tests use, so a tool call
     here proves the transport didn't fork the dispatch, not that the relay
     changed. The fences are the point: a transport that lets the browser be
     driven from another device gets the token/host/origin triad, or it gets
     nobody's browser to drive. */
  const TOKEN = "agx-http-test-token-0123456789abcdef-0123456789abcdef"; // ≥ 32 chars
  /* The app's own token, which the MCP server carries OUT to the app and
     which must not open the MCP endpoint: whoever sniffs the endpoint's
     bearer off a LAN gets the browser, not the whole app. */
  const APP_TOKEN = "agx-app-token-that-is-not-the-mcp-one-0123456789";
  const mcpUrl = () => `http://127.0.0.1:${httpPort}`;
  let httpPort = 0;
  let mcp: ReturnType<typeof Bun.spawn> | null = null;

  beforeAll(async () => {
    httpPort = await freePort();
    mcp = Bun.spawn(["python3", MCP], {
      env: {
        PATH: process.env.PATH ?? "",
        AGENTGLASS_SERVER: base,
        AGENTGLASS_TOKEN: APP_TOKEN,
        AGENTGLASS_MCP_TOKEN: TOKEN,
        AGENTGLASS_MCP_HTTP: `127.0.0.1:${httpPort}`,
      },
      stdout: "ignore", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      try {
        const probe = await fetch(mcpUrl() + "/", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
        });
        if (probe.ok) break;
      } catch { /* not up yet */ }
      await Bun.sleep(100);
    }
    await openWindow();
  }, SERVER_BOOT_MS);

  afterAll(() => {
    try { mcp?.kill(); } catch { /* already gone */ }
  });

  test("initialize over JSON: names itself and issues a session id", async () => {
    const r = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toMatch(/^agx-/);
    const j = await r.json() as { result: { serverInfo: { name: string }; capabilities: { tools: unknown } } };
    expect(j.result.serverInfo.name).toBe("agentglass-browser");
    expect(j.result.capabilities.tools).toBeDefined();
  });

  test("a missing or wrong bearer token is refused, and the app's own token is a wrong one", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });
    const none = await fetch(mcpUrl() + "/", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(none.status).toBe(401);
    const wrong = await fetch(mcpUrl() + "/", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer nope" }, body,
    });
    expect(wrong.status).toBe(401);
    const app = await fetch(mcpUrl() + "/", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${APP_TOKEN}` }, body,
    });
    expect(app.status, "the app token opens the app, not this endpoint").toBe(401);
  });

  test("a bearer with bytes outside ASCII is a 401, not a dropped connection", async () => {
    // hmac.compare_digest raises on a str that is not ASCII, and the header
    // arrives decoded as latin-1, so one such byte used to kill the handler.
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port: httpPort, path: "/", method: "POST",
        headers: { authorization: Buffer.from("Bearer caf\xe9", "latin1").toString("latin1"), "content-type": "application/json" },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); }).on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    });
    expect(status).toBe(401);
  });

  test("with no AGENTGLASS_MCP_TOKEN the endpoint mints one, says it on stderr, and answers to nothing else", async () => {
    /* Loopback used to be auth-free "the way the server is". It is not any
       more: a page on any site can reach 127.0.0.1 with a request the browser
       will send, and the token is the one thing it cannot forge. So there is
       always a token — the operator's, or one minted for this process. */
    const port = await freePort();
    const minted = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_MCP_HTTP: `127.0.0.1:${port}` },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    try {
      const reader = minted.stderr.getReader();
      let err = "";
      for (let i = 0; i < 50 && !/AGENTGLASS_MCP_TOKEN=\S+/.test(err); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        err += new TextDecoder().decode(value);
      }
      const token = /AGENTGLASS_MCP_TOKEN=(\S+)/.exec(err)?.[1];
      expect(token, `stderr must carry the minted token: ${err}`).toBeDefined();
      expect(token!.length).toBeGreaterThanOrEqual(32);
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
      let ok = 0, bare = 0;
      for (let i = 0; i < 50; i++) {
        try {
          ok = (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body })).status;
          bare = (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body })).status;
          break;
        } catch { await Bun.sleep(100); }
      }
      expect(ok).toBe(200);
      expect(bare).toBe(401);
    } finally {
      minted.kill();
    }
  });

  test("a notification is answered with the empty 202 the spec wants", async () => {
    const r = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  test("honours text/event-stream and lists the same TOOLS the stdio server does", async () => {
    const r = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: {
        "content-type": "application/json", authorization: `Bearer ${TOKEN}`,
        accept: "text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    });
    // 200, not 202: a request that carries a JSON-RPC request is answered
    // with its response, whatever the framing. The reference SDK client reads
    // a 202 as "nothing to read", drops the body and never resolves — the
    // first version answered every SSE request with 202, and `initialize`
    // hung in every SDK-based runtime.
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const raw = await r.text();
    expect(raw.startsWith("event: message\ndata: ")).toBe(true);
    const payload = JSON.parse(raw.slice(raw.indexOf("\ndata: ") + 7)) as { result: { tools: { name: string }[] } };
    const names = payload.result.tools.map((t) => t.name);
    for (const expectName of ["browser_open", "browser_read", "browser_markdown", "browser_links", "browser_count", "browser_search", "browser_extract"]) {
      expect(names, `tools/list over HTTP must still carry ${expectName}`).toContain(expectName);
    }
  });

  test("the reference client's flow: initialize, initialized, tools/list — with its own Accept header", async () => {
    /* The Streamable-HTTP client in the reference SDK sends
       `Accept: application/json, text/event-stream` on every POST, reads the
       session id off `initialize`, sends `notifications/initialized` and
       expects an empty 202 for it, and then treats any 202 as "no body". So
       the flow is driven with exactly those headers and exactly that reading
       of the status: a server that answers a request with 202 fails here the
       way it fails in the SDK. */
    const ACCEPT = "application/json, text/event-stream";
    const post = (body: unknown, session?: string) => fetch(mcpUrl() + "/", {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${TOKEN}`,
        "mcp-protocol-version": "2025-06-18",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify(body),
    });
    /** What the SDK does with a response: 202 is no body; otherwise the body
     *  is JSON or an SSE stream of JSON-RPC messages, by content-type. */
    const readLikeSdk = async (r: Response): Promise<unknown[]> => {
      if (r.status === 202) return [];
      expect(r.status).toBe(200);
      const ct = r.headers.get("content-type") ?? "";
      const text = await r.text();
      if (ct.includes("text/event-stream")) {
        return text.split("\n\n").filter((f) => f.includes("data: ")).map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
      }
      expect(ct).toContain("application/json");
      const j = JSON.parse(text);
      return Array.isArray(j) ? j : [j];
    };
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sdk-shaped", version: "0" } } });
    const session = init.headers.get("mcp-session-id");
    expect(session).toMatch(/^agx-/);
    const [initMsg] = await readLikeSdk(init) as { id: number; result: { protocolVersion: string } }[];
    expect(initMsg, "initialize must be answered, not acknowledged").toBeDefined();
    expect(initMsg!.id).toBe(1);
    expect(initMsg!.result.protocolVersion).toBe("2025-06-18");
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session!);
    expect(ack.status).toBe(202);
    expect(await readLikeSdk(ack)).toEqual([]);
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session!);
    const [listMsg] = await readLikeSdk(list) as { id: number; result: { tools: { name: string }[] } }[];
    expect(listMsg!.id).toBe(2);
    expect(listMsg!.result.tools.map((t) => t.name)).toContain("browser_open");
  });

  test("a tool call reaches the same relay the stdio server uses", async () => {
    // open first: read without a tab is refused by the ownership layer before
    // the relay — the refusal itself is the dispatch working, and the happy
    // path needs a tab to exist.
    answers["open"] = { ok: true, value: { id: "t-http", url: base + "/", title: "Dashboard" } };
    const opened = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 10, method: "tools/call",
        params: { name: "browser_open", arguments: { url: base + "/" } },
      }),
    });
    expect(opened.status).toBe(200);

    answers["read"] = { ok: true, value: { url: base + "/", title: "Dashboard", text: "hello from the stand-in" } };
    const r = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "browser_read", arguments: {} },
      }),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { result: { content: { type: string; text: string }[] } };
    expect(j.result.content[0]!.text).toContain("hello from the stand-in");
  });

  test("a request with a web page's Origin is refused — https, loopback, the app's own server, null — token or no token", async () => {
    /* The first version admitted any https Origin and the app's own, and
       echoed it back in Access-Control-Allow-Origin; with a text/plain body
       (no preflight) a page on any https site could call browser_storage_state
       and read every cookie back. No MCP client is a web page, so the rule is
       the strict one: an Origin header, whatever it says, is a browser, and a
       browser is not a caller here. Nothing is echoed, and OPTIONS gets no
       allowance to hand out. */
    const body = JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" });
    for (const origin of ["https://evil.example", "http://evil.example", "http://localhost:5173", "http://127.0.0.1:4000", base, "null"]) {
      for (const contentType of ["application/json", "text/plain"]) {
        const r = await fetch(mcpUrl() + "/", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, origin, "content-type": contentType },
          body,
        });
        expect(r.status, `${origin} with ${contentType}`).toBe(403);
        expect(r.headers.get("access-control-allow-origin"), `${origin} must not be echoed`).toBeNull();
      }
    }
    const preflight = await fetch(mcpUrl() + "/", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toBeNull();
  });

  test("bound to loopback, the endpoint answers to every loopback name — localhost, ::1 — and 421 only to a foreign one", async () => {
    /* The bind is 127.0.0.1, which is what getsockname says even when the
       operator typed `localhost`; the first version compared the Host header
       to that literally, so `http://localhost:PORT` — the first URL anybody
       types — got 421 Misdirected Request. A rebinding page cannot make a
       browser send a loopback name for a hostname of its own, so any loopback
       name is the bound address. A request with no Host at all is not HTTP/1.1
       and is a 400. */
    const { request } = await import("node:http");
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" });
    const withHost = (host: string) => new Promise<number>((resolve, reject) => {
      const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", host };
      const req = request({ hostname: "127.0.0.1", port: httpPort, path: "/", method: "POST", headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }).on("error", reject);
      req.end(body);
    });
    expect(await withHost(`localhost:${httpPort}`)).toBe(200);
    expect(await withHost(`127.0.0.1:${httpPort}`)).toBe(200);
    expect(await withHost(`[::1]:${httpPort}`)).toBe(200);
    expect(await withHost(`127.1.2.3:${httpPort}`)).toBe(200);
    expect(await withHost(`attacker.example:${httpPort}`)).toBe(421);
    expect(await withHost("localhost.attacker.example")).toBe(421);
    // No Host at all: node's http client adds one whatever it is told, so
    // this one goes over a bare socket.
    const { connect } = await import("node:net");
    const bare = await new Promise<string>((resolve, reject) => {
      const sock = connect({ host: "127.0.0.1", port: httpPort });
      let got = "";
      sock.on("connect", () => sock.write(`POST / HTTP/1.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
      sock.on("data", (d) => { got += d.toString(); });
      sock.on("close", () => resolve(got));
      sock.on("error", reject);
    });
    expect(bare.split("\r\n")[0], "no Host at all").toContain("400");
  });

  test("an IPv6 bind serves, and --allow-host admits the name a tunnel in front forwards", async () => {
    /* Parsing `[::1]:PORT` was half of it: the server class is IPv4-only,
       and the bind itself died with gaierror. And a tunnel that terminates
       TLS in front of a loopback bind (the thing the off-loopback warning
       recommends) forwards the tailnet name as Host, which is not a loopback
       name — so it gets 421 unless the operator names it. */
    const port = await freePort();
    const p = Bun.spawn(["python3", MCP, "--http", `[::1]:${port}`, "--allow-host", "box.tailnet-orbit.ts.net"], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_MCP_TOKEN: TOKEN },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    try {
      const { request } = await import("node:http");
      const ask = (host: string) => new Promise<number>((resolve, reject) => {
        const req = request({ hostname: "::1", family: 6, port, path: "/", method: "POST", headers: { host, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } }, (res) => {
          res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
        }).on("error", reject);
        req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
      });
      let first = 0;
      for (let i = 0; i < 50 && !first; i++) { try { first = await ask(`[::1]:${port}`); } catch { await Bun.sleep(100); } }
      expect(first, "the v6 bind came up and answered").toBe(200);
      expect(await ask(`localhost:${port}`)).toBe(200);
      expect(await ask("box.tailnet-orbit.ts.net")).toBe(200);
      expect(await ask("BOX.tailnet-orbit.ts.net:443"), "case and port do not make another name").toBe(200);
      expect(await ask("other.tailnet-orbit.ts.net")).toBe(421);
    } finally {
      p.kill();
    }
  });

  test("the bind is parsed as [HOST:]PORT, bracketed IPv6 included", async () => {
    const probe = Bun.spawn(["python3", "-c", `
import importlib.machinery, importlib.util, json, sys
spec = importlib.util.spec_from_loader("agx_mcp", importlib.machinery.SourceFileLoader("agx_mcp", ${JSON.stringify(MCP)}))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({b: m._parse_bind(b) for b in ["8765", "127.0.0.1:8765", "[::1]:8765", "::1:8765", "localhost:8765", "0.0.0.0:0", "8765:", ":8765", "nope", "127.0.0.1:99999", ""]}))
`], { env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base }, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text()]);
    expect(await probe.exited, err).toBe(0);
    expect(JSON.parse(out)).toEqual({
      "8765": ["127.0.0.1", 8765],
      "127.0.0.1:8765": ["127.0.0.1", 8765],
      "[::1]:8765": ["::1", 8765],
      "::1:8765": ["::1", 8765],
      "localhost:8765": ["localhost", 8765],
      "0.0.0.0:0": null,
      "8765:": null,
      ":8765": null,
      "nope": null,
      "127.0.0.1:99999": null,
      "": null,
    });
  });

  test("a batch item that is not an object is a JSON-RPC error, not a dropped connection", async () => {
    // `[1]` used to raise inside the handler and close the socket with no
    // reply; a parse-level mistake is answered as one.
    const r = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify([1, { jsonrpc: "2.0", id: 11, method: "ping" }]),
    });
    expect(r.status).toBe(200);
    const j = await r.json() as { id: number | null; error?: { code: number }; result?: unknown }[];
    expect(j.find((m) => m.error)?.error?.code).toBe(-32600);
    expect(j.find((m) => m.id === 11)?.result).toEqual({});
  });

  test("the session table is a ring, not a quota: the 65th initialize still gets an id", async () => {
    const init = () => fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }),
    });
    for (let i = 0; i < 70; i++) await init();
    const last = await init();
    expect(last.status).toBe(200);
    expect(last.headers.get("mcp-session-id")).toMatch(/^agx-/);
  });

  test("a body that is not application/json is refused before it is parsed", async () => {
    // A text/plain POST is one a browser sends without a preflight; JSON is
    // the only content type a JSON-RPC client has a reason to send.
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      const r = await fetch(mcpUrl() + "/", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, ...(contentType ? { "content-type": contentType } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
      });
      expect(r.status, contentType || "(none)").toBe(415);
    }
    const charset = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }),
    });
    expect(charset.status, "a charset parameter is still JSON").toBe(200);
  });

  test("the caps hold: oversized body, oversized batch, wrong host, foreign origin", async () => {
    const big = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(big.status).toBe(431);
    const many = Array.from({ length: 9 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    const batched = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(many),
    });
    expect(batched.status).toBe(400);
    // Host naming a different authority → 421: the DNS-rebinding shape. The
    // catch is the Host header, so it is sent raw — bun's fetch pins the URL's
    // own host and gives no way to lie.
    const body = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" });
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const req = request({
          hostname: "127.0.0.1",
          port: httpPort,
          path: "/",
          method: "POST",
          headers: { host: "attacker.example", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        }).on("error", reject);
        req.end(body);
      });
    });
    expect(rebindStatus).toBe(421);
    // A foreign browser origin → 403 even with the right token in hand (CSWSH).
    const foreign = await fetch(mcpUrl() + "/", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }),
    });
    expect(foreign.status).toBe(403);
    // GET is not a transport here.
    const get = await fetch(mcpUrl() + "/");
    expect(get.status).toBe(405);
  });

  /** Start the binary with these extra env vars and return its exit code and stderr. */
  const startsWith = async (env: Record<string, string>) => {
    const p = Bun.spawn(["python3", MCP], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, ...env },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    return { code: await p.exited, err: await new Response(p.stderr).text() };
  };

  test("a non-loopback bind is an opt-in: it needs --expose (or AGENTGLASS_MCP_EXPOSE=1) as well as a token", async () => {
    const off = `0.0.0.0:${await freePort()}`;
    const noToken = await startsWith({ AGENTGLASS_MCP_HTTP: off, AGENTGLASS_MCP_EXPOSE: "1" });
    expect(noToken.code).toBe(2);
    expect(noToken.err).toContain("refusing to bind");
    expect(noToken.err).toContain("AGENTGLASS_MCP_TOKEN");
    const noOptIn = await startsWith({ AGENTGLASS_MCP_HTTP: off, AGENTGLASS_MCP_TOKEN: TOKEN });
    expect(noOptIn.code).toBe(2);
    expect(noOptIn.err).toContain("refusing to bind");
    expect(noOptIn.err).toContain("--expose");
  });

  test("an exposed bind starts at once and warns that the token crosses the network in the clear", async () => {
    /* HTTPServer.server_bind asks for the fully-qualified name of the bound
       address, a reverse lookup that took five seconds for 0.0.0.0 on a
       machine with no answer for it — the warning arrived after the port
       was already serving. */
    const p = Bun.spawn(["python3", MCP, "--http", `0.0.0.0:${await freePort()}`, "--expose"], {
      env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_MCP_TOKEN: TOKEN },
      stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    try {
      const reader = p.stderr.getReader();
      let err = "";
      const started = Date.now();
      while (!/WARNING[^\n]*\n/.test(err) && Date.now() - started < 4000) {
        const next = await Promise.race([reader.read(), Bun.sleep(4000).then(() => ({ value: undefined, done: true }))]);
        if (next.done) break;
        err += new TextDecoder().decode(next.value);
      }
      expect(Date.now() - started, "start-up did not wait on a reverse lookup").toBeLessThan(2000);
      expect(err).toContain("WARNING");
      expect(err).toContain("in the clear");
      expect(err).not.toContain(TOKEN);
    } finally {
      p.kill();
    }
  });

  test("a token shorter than 32 chars, or equal to the app's, refuses to start", async () => {
    const short = await startsWith({ AGENTGLASS_MCP_HTTP: `127.0.0.1:${await freePort()}`, AGENTGLASS_MCP_TOKEN: "short" });
    expect(short.code).toBe(2);
    expect(short.err).toContain("32");
    const same = await startsWith({ AGENTGLASS_MCP_HTTP: `127.0.0.1:${await freePort()}`, AGENTGLASS_MCP_TOKEN: APP_TOKEN, AGENTGLASS_TOKEN: APP_TOKEN });
    expect(same.code).toBe(2);
    expect(same.err).toContain("AGENTGLASS_TOKEN");
  });
});
