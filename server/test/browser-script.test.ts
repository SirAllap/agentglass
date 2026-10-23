/*
 * `agentglass-browser script`: several verbs with an if or a loop in ONE call.
 * Driven the way browser-cli.test.ts drives the CLI: the real CLI, the real
 * server, a stand-in for the window. What is pinned is what an agent relies
 * on: one JSON answer, a failure that names its line and its sentence, the
 * caller named on every verb the script sends, and a ceiling.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");
const CLIENT = "script-window";

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
type Answer = { ok: boolean; value?: unknown; error?: string };
let answers: Record<string, Answer | (() => Answer)> = {};
let asked: string[] = [];
let askedArgs: Record<string, unknown>[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-script-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir, XDG_DATA_HOME: `${dir}/data`, XDG_CACHE_HOME: `${dir}/cache`,
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws!.addEventListener("open", r));
  ws.send(JSON.stringify({ type: "hello", clientId: CLIENT, browser: true }));
  ws.addEventListener("message", async (ev) => {
    let frame: any;
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type !== "browser") return;
    asked.push(frame.data.op);
    askedArgs.push(frame.data.args ?? {});
    const scripted = answers[frame.data.op];
    const reply = (typeof scripted === "function" ? scripted() : scripted)
      ?? { ok: false, error: "the stand-in was not told what to say" };
    await fetch(base + "/browser/result", {
      method: "POST", headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ client: CLIENT, id: frame.data.id, ...reply }),
    });
  });
  await fetch(base + "/browser/ready", {
    method: "POST", headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ client: CLIENT, on: true }),
  });
  await Bun.sleep(150);
}, SERVER_BOOT_MS);

afterAll(() => {
  try { ws?.close(); } catch { /* gone */ }
  try { proc?.kill(); } catch { /* gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

async function cli(args: string[], stdin?: string) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_BROWSER_STATE_DIR: join(dir, "st") },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: out.trim(), err: err.trim(), code };
}

function reset() { asked = []; askedArgs = []; answers = { observe: { ok: true, value: { url: "u", title: "end" } } }; }

describe.skipIf(!HAVE_PY)("agentglass-browser script", () => {
  test("a loop of clicks is one answer, with the printed output, the result and the final observe", async () => {
    reset();
    let n = 0;
    answers.click = () => ({ ok: true, value: { clicked: ++n } });
    const r = await cli(["script", "--active", "for i in range(3):\n    r = click('#next')\n    print('page', r['clicked'])\nresult = r['clicked']"]);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(true);
    expect(j.printed).toBe("page 1\npage 2\npage 3\n");
    expect(j.result).toBe(3);
    expect(j.observe.title).toBe("end");
    expect(asked).toEqual(["click", "click", "click", "observe"]);
  });

  test("a failing verb stops the script with its line and the server's sentence", async () => {
    reset();
    answers.click = { ok: false, error: "nothing on the page matches #pay" };
    answers.text = { ok: true, value: {} };
    const r = await cli(["script", "--active", "print('before')\nclick('#pay')\ntext('body')"]);
    const j = JSON.parse(r.out);
    expect(r.code).toBe(1);
    expect(j.ok).toBe(false);
    expect(j.error).toBe("line 2: nothing on the page matches #pay");
    expect(j.printed).toBe("before\n");
    expect(j.observe).toBeDefined();
    expect(asked).toEqual(["click", "observe"]);
  });

  test("the script can catch BrowserError and go on", async () => {
    reset();
    answers.click = { ok: false, error: "gone" };
    const r = await cli(["script", "--active", "try:\n    click('#x')\nexcept BrowserError as e:\n    result = str(e)"]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, result: "gone" });
  });

  test("the caller is named on every verb the script sends, and on the final observe", async () => {
    reset();
    answers.open = { ok: true, value: { id: "tS-ffffff", tabs: [] } };
    answers.click = { ok: true, value: {} };
    const opened = await cli(["open", "--as", "scripter", "https://example.com/"]);
    expect(opened.code, opened.err).toBe(0);
    asked = []; askedArgs = [];
    const r = await cli(["script", "--as", "scripter", "click('#a')\nclick('#b')"]);
    expect(r.code, r.err).toBe(0);
    expect(asked).toEqual(["click", "click", "observe"]);
    expect(askedArgs.map((x) => x.as)).toEqual(["scripter", "scripter", "scripter"]);
    expect(askedArgs.map((x) => x.page)).toEqual(["tS-ffffff", "tS-ffffff", "tS-ffffff"]);
  });

  test("an identity with no tab is refused before any verb runs", async () => {
    reset();
    const r = await cli(["script", "--as", "nobody-here", "click('#a')"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("has no tab open");
    expect(asked).toEqual([]);
  });

  test("past 200 verb calls it stops with a sentence", async () => {
    reset();
    answers.click = { ok: true, value: {} };
    const r = await cli(["script", "--active", "--no-observe", "for i in range(500):\n    click('#a')"]);
    const j = JSON.parse(r.out);
    expect(j.ok).toBe(false);
    expect(j.error).toContain("200 verb calls");
    expect(asked.length).toBe(200);
    expect(j.observe).toBeUndefined();
  });

  test("CODE comes from stdin with `-`, and --no-observe leaves the observe out", async () => {
    reset();
    answers.click = { ok: true, value: { n: 1 } };
    const r = await cli(["script", "--active", "--no-observe", "-"], "result = click('#a')\n");
    const j = JSON.parse(r.out);
    expect(j.result).toEqual({ n: 1 });
    expect(j.observe).toBeUndefined();
    expect(asked).toEqual(["click"]);
  });
});
