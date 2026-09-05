/*
 * The audit, and the tab a read verb reads — proved from OUTSIDE the module.
 *
 * The unit locks in browserdrive.test.ts hold `recordAudit`, `waitForEvents`
 * and `parseAsk` to their contracts. They cannot see the two lines of route
 * glue in index.ts, and glue is exactly where this failed before: `events`
 * validated a `page`, the CLI sent one, and the route built its call from
 * `since`/`wait`/`kinds` and dropped it — so all three event kinds read
 * whichever tab was in front, and the `cdp` kind DRAINED it, eating a
 * `Debugger.paused` another agent was waiting on.
 *
 * So this runs a real server, with a stand-in window on the socket answering
 * asks, and asserts what the window was actually sent — plus what the audit
 * says afterwards, and that it is still there after a restart.
 *
 * AGENTGLASS_STATE_DIR points at a temp directory on purpose: the audit log
 * now lives beside the rest of this app's state, and a test must never write
 * into the real one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

let dir = "", state = "", base = "";
let port = 0;
let proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
const CLIENT = "test-window";

/** What the stand-in window was sent, in order. */
const asked: Array<{ op: string; args: Record<string, unknown> }> = [];

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify(body),
  });

async function startServer() {
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      XDG_CONFIG_HOME: dir,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "f.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      /* Where the durable audit log goes. Without this the server would append
         to the developer's own `~/.local/state/agentglass/browser-audit.log`. */
      AGENTGLASS_STATE_DIR: state,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}

/** A window on the socket that answers every ask, and remembers what it got. */
async function openWindow(reply: (op: string) => { ok: boolean; value?: unknown; error?: string }) {
  ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws!.addEventListener("open", r));
  ws.addEventListener("message", async (ev) => {
    let frame: { type?: string; data?: { id: string; op: string; args?: Record<string, unknown> } };
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type !== "browser" || !frame.data) return;
    asked.push({ op: frame.data.op, args: frame.data.args ?? {} });
    await post("/browser/result", { id: frame.data.id, ...reply(frame.data.op) });
  });
  await post("/browser/ready", { client: CLIENT, on: true });
  await Bun.sleep(150);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-audit-route-"));
  state = mkdtempSync(join(tmpdir(), "agx-audit-state-"));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();
  await openWindow((op) => (op === "click"
    /* §8's reply fields: the panel says which tab answered and whose it is. */
    ? { ok: true, value: { clicked: "#pay", tab: "t-b", profile: "orbit-b" } }
    : { ok: true, value: { rows: [], events: [], now: Date.now() } }));
});

afterAll(() => {
  try { ws?.close(); } catch { /* already gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

interface Entry { op: string; ok: boolean; as?: string; tab?: string; owner?: string; how?: string; args: Record<string, unknown> }
const readAudit = async (body: Record<string, unknown> = {}) =>
  (await (await post("/browser/audit", body)).json() as { value: { entries: Entry[]; note?: string } }).value;

test("a deliberate borrow is recorded with the caller, the tab and the owner", async () => {
  const r = await post("/browser/click", { selector: "#pay", page: "t-b", as: "orbit-a", how: "explicit-page" });
  expect((await r.json() as { ok: boolean }).ok).toBe(true);

  const { entries } = await readAudit();
  const click = entries.find((e) => e.op === "click");
  expect(click).toBeDefined();
  expect(click!.as).toBe("orbit-a");
  expect(click!.tab).toBe("t-b");
  /* From the PANEL's reply, not from the request — the request said which tab
     to use, the reply says whose it turned out to be. */
  expect(click!.owner).toBe("orbit-b");
  expect(click!.how).toBe("explicit-page");
  /* The two attribution fields are not left among the verb's own arguments:
     `audit --script` replays those, and neither of these is an argument. */
  expect(click!.args.as).toBeUndefined();
  expect(click!.args.how).toBeUndefined();
});

test("the filters narrow to one tab and to one caller, over the wire", async () => {
  expect((await readAudit({ tab: "t-b" })).entries.some((e) => e.op === "click")).toBe(true);
  expect((await readAudit({ tab: "t-nobody" })).entries).toHaveLength(0);
  /* `by` narrows to a caller. `as` says who is ASKING and narrows nothing: the
     CLI stamps it on every request, `audit` included, so the day it doubled
     as the filter every `audit` silently came back scoped to its own caller. */
  expect((await readAudit({ by: "orbit-a" })).entries.some((e) => e.op === "click")).toBe(true);
  expect((await readAudit({ by: "orbit-b" })).entries).toHaveLength(0);
  expect((await readAudit({ as: "orbit-b" })).entries.some((e) => e.op === "click")).toBe(true);
});

test("the answer says out loud that `as` is asserted, not authenticated", async () => {
  /* Stated where a caller reading the JSON sees it. `as` is written by a local
     CLI over a loopback endpoint whose only credential is one machine-wide
     token every agent shell already holds: forensics between cooperating
     agents, which is the real threat model — never authentication. */
  const note = (await readAudit()).note ?? "";
  expect(note).toContain("self-asserted");
  expect(note).toContain("not authentication");
});

test("`events` sends the caller's tab to the window — all three kinds", async () => {
  asked.length = 0;
  await post("/browser/events", { kinds: ["console", "network", "cdp"], wait: 1, page: "t-b" });
  const kinds = asked.filter((a) => ["console", "network", "cdp"].includes(a.op));
  expect(kinds.length).toBeGreaterThanOrEqual(3);
  expect([...new Set(kinds.map((a) => a.op))].sort()).toEqual(["cdp", "console", "network"]);
  /* Every one of them, because the destructive one is `cdp`: its buffer is
     per-guest and reading it empties it, so one unaddressed drain takes an
     event another agent's debugger was holding. */
  expect(kinds.every((a) => a.args.page === "t-b")).toBe(true);
});

test("and the log is still there after the app restarts", async () => {
  /*
   * The in-memory 2000-entry export dies with the process, and before this the
   * whole log did — reopening the app was enough to lose the evidence of what
   * an agent had touched. Same state directory, new process: the entry from
   * the first test must still be readable, filters included.
   */
  try { ws?.close(); } catch { /* already gone */ }
  proc?.kill();
  await Bun.sleep(300);
  await startServer();

  const { entries } = await readAudit();
  const click = entries.find((e) => e.op === "click" && e.as === "orbit-a");
  expect(click).toBeDefined();
  expect(click!.tab).toBe("t-b");
  expect(click!.owner).toBe("orbit-b");
  expect(click!.how).toBe("explicit-page");
  expect((await readAudit({ tab: "t-b" })).entries.some((e) => e.op === "click")).toBe(true);
});
