/*
 * The whole chain an agent uses: CLI → server → window → answer.
 *
 * Every bug this feature had in its first day was in the seams, not in the
 * parts. The relay was tested, the page verbs were tested, and what broke was
 * a navigation reported as failed because Chromium named the *previous* one, a
 * click that answered before the page moved, and a screenshot that came back
 * empty and was passed off as a success. None of those are visible from either
 * end alone.
 *
 * So this drives the real CLI against a real server, with a stand-in for the
 * window on the other side of the socket — the one piece that cannot be real
 * without Electron. What it pins is the contract between them: that a refusal
 * exits non-zero, that an answer is printed in the shape the CLI promises, and
 * that the CLI opens the pane and retries exactly when a retry can help.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
/** What the stand-in window should do with the next ask, by op. */
let answers: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
/** Every ask the window was sent, so a test can assert on a retry. */
let asked: string[] = [];
/** Control commands the server broadcast — the CLI's "open the pane" goes here. */
let controls: unknown[] = [];
const CLIENT = "test-window";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-cli-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      // The server sweeps tmux window sizes at boot; without this it sweeps the
      // developer's own socket directory. See tmuxTmp.ts.
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: process.env.HOME ?? "",
      XDG_CONFIG_HOME: dir,
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
});

afterAll(() => {
  try { ws?.close(); } catch { /* already gone */ }
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

/** A window on the socket, answering from `answers`. Connected per test, so the
 *  "no window at all" case is a test that simply does not call this. */
async function openWindow() {
  // One window at a time. Leaving the previous socket open made every
  // stand-in answer the same ask — which is exactly the bug the registration
  // below exists to prevent, and it should not be re-created here by accident.
  closeWindow();
  ws = new WebSocket(base.replace("http", "ws") + "/stream");
  await new Promise((r) => ws!.addEventListener("open", r));
  ws.addEventListener("message", async (ev) => {
    let frame: any;
    try { frame = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
    if (frame.type === "control") { controls.push(frame.data); return; }
    if (frame.type !== "browser") return;
    asked.push(frame.data.op);
    const reply = answers[frame.data.op] ?? { ok: false, error: "the stand-in was not told what to say" };
    await fetch(base + "/browser/result", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ id: frame.data.id, ...reply }),
    });
  });
  // A window that can drive a browser says so; the server sends asks to nobody
  // otherwise. Same call the panel makes when it mounts.
  await fetch(base + "/browser/ready", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify({ client: CLIENT, on: true }),
  });
  await Bun.sleep(150);
}

async function closeWindow(unregister = false) {
  if (unregister) {
    await fetch(base + "/browser/ready", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ client: CLIENT, on: false }),
    }).catch(() => {});
  }
  try { ws?.close(); } catch { /* fine */ }
  ws = null;
}

/** Run the CLI exactly as an agent would. */
async function cli(...args: string[]) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { out: out.trim(), err: err.trim(), code };
}

describe.skipIf(!HAVE_PY)("the CLI an agent runs", () => {
  test("with no window it fails, quickly, and says which thing is missing", async () => {
    await closeWindow(true);
    asked = []; controls = [];
    const r = await cli("read");
    expect(r.code).toBe(1);
    expect(r.err).toContain("window is not open");
    // And it did not try to open a pane in a window that is not there.
    expect(asked).toEqual([]);
  });

  test("an answer is printed as the caller was promised, and exits 0", async () => {
    await openWindow();
    answers = { read: { ok: true, value: { url: "https://app.example/x", title: "Billing", text: "Total 41" } } };
    const r = await cli("read");
    expect(r.code).toBe(0);
    // Plain text for a model to read: title, url, blank line, page.
    expect(r.out.split("\n")[0]).toBe("Billing");
    expect(r.out).toContain("https://app.example/x");
    expect(r.out).toContain("Total 41");
  });

  test("a refusal from the page exits non-zero with the page's own words", async () => {
    await openWindow();
    answers = { click: { ok: false, error: "nothing on the page matches #pay" } };
    const r = await cli("click", "#pay");
    expect(r.code).toBe(1);
    expect(r.err).toBe("nothing on the page matches #pay");
    expect(r.out).toBe("");
  });

  test("an argument the server refuses never reaches the window", async () => {
    await openWindow();
    asked = [];
    const bad = await cli("open", "javascript:alert(1)");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("http(s)");
    const key = await cli("press", "F13");
    expect(key.code).toBe(1);
    expect(key.err).toContain("must be one of");
    expect(asked).toEqual([]);
  });

  test("scroll insists on exactly one of its three ways", async () => {
    await openWindow();
    const r = await cli("scroll", "--by", "100", "--to", "top");
    // argparse refuses this one before the server ever sees it.
    expect(r.code).not.toBe(0);
  });

  test("a window with no browser pane is a different failure from no window", async () => {
    // The regression this pins cost a whole build: with the pane simply not
    // opened yet, the answer said the WINDOW was shut, so the CLI — which knows
    // how to open a pane and not how to open a window — stopped instead of
    // retrying, and every verb failed against a perfectly healthy app.
    await openWindow();
    await fetch(base + "/browser/ready", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ client: CLIENT, on: false }),
    });
    controls = [];
    const r = await cli("read");
    expect(r.code).toBe(1);
    expect(r.err).toContain("view is not open");
    // And it tried to fix exactly that before giving up.
    expect(controls).toContainEqual({ cmd: "view", to: "browser" });
  });

  test("a pane that is not showing is opened, and the ask retried once", async () => {
    await openWindow();
    asked = []; controls = [];
    // First the failure a retry can fix, then success — the window answers
    // differently the second time, exactly as it would once the pane is up.
    let n = 0;
    answers = {
      get shot() {
        n += 1;
        return n === 1
          ? { ok: false, error: "the browser pane is not on screen, so there was no frame to capture" }
          : { ok: true, value: { url: "u", title: "t", png: "data:image/png;base64,iVBORw0KGgo=" } };
      },
    } as typeof answers;
    const r = await cli("shot", join(dir, "shot.png"));
    expect(r.code).toBe(0);
    expect(asked).toEqual(["shot", "shot"]);
    // And it asked the window to show the pane in between, rather than just
    // trying the same thing twice and hoping.
    expect(controls).toContainEqual({ cmd: "view", to: "browser" });
  });

  test("but a refusal a retry cannot fix is not retried", async () => {
    await openWindow();
    asked = []; controls = [];
    answers = { click: { ok: false, error: "nothing on the page matches #gone" } };
    const r = await cli("click", "#gone");
    expect(r.code).toBe(1);
    // Once. Asking twice makes an agent wait twice for the same answer.
    expect(asked).toEqual(["click"]);
    expect(controls).toEqual([]);
  });
});
