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
import { readFileSync } from "node:fs";
import { BROWSER_OPS } from "../src/browserdrive.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const CLI = new URL("../../bin/agentglass-browser", import.meta.url).pathname;
const HAVE_PY = !!Bun.which("python3");

let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
/** What the stand-in window should do with the next ask, by op. */
let answers: Record<string, { ok: boolean; value?: unknown; error?: string }> = {};
/** Every ask the window was sent, so a test can assert on a retry. */
let asked: string[] = [];
/** The args of every ask, so a test can assert on what the CLI actually sent
 *  (e.g. the `since` a `--since-last` resolved to). */
let askedArgs: Record<string, unknown>[] = [];
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
    askedArgs.push(frame.data.args ?? {});
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

/**
 * Run the CLI exactly as an agent would, on the active tab DELIBERATELY.
 *
 * `--active` is not decoration here. An identity that holds no tab is now
 * refused rather than sent to whichever tab is in front — that fall-through is
 * how one agent drove another's page — and this harness runs every verb in a
 * scratch state dir where no tab has ever been opened. These tests are about
 * the TRANSPORT: does the answer print, does a refusal exit non-zero, does an
 * argument reach the window. Saying `--active` is how a caller declares it
 * means the tab in front, which is exactly what they mean.
 *
 * IT USED TO SAY `--shared`, AND THAT WAS THE BUG WEARING A TEST'S CLOTHES.
 * `--shared` promised "the DEFAULT profile, which is the person's own session"
 * and delivered "whichever tab is in front" — it cleared the identity, and a
 * request with no identity and no page is what the relay resolves to the
 * active tab. This harness leaned on the false half of that. The two meanings
 * are two flags now, and the harness names the one it actually wants.
 *
 * Tests that are about identity use `cliAsMe` below and must not get this.
 */
async function cli(...args: string[]) {
  return cliAsMe(...withActive(args));
}

/**
 * `--active`, appended, unless the caller already said which tab they mean.
 *
 * At the END rather than after the first argument: a call can lead with a
 * global (`cli("--out", path, "read")`), and inserting between a flag and its
 * value produces `--out --active path read`, which argparse reads as an
 * `--out` whose value is `--active`. Three tests said so.
 */
function withActive(args: string[]): string[] {
  if (args.some((a) => a === "--active" || a === "--shared" || a === "--as"
    || a === "--profile" || a === "--page")) return args;
  return args.length ? [...args, "--active"] : args;
}

/** The CLI with no help: whatever identity it derives for itself is the one
 *  under test. */
async function cliAsMe(...args: string[]) {
  return cliIn(join(dir, "state"), ...args);
}

/** The same, in a named state dir — for the tests that are ABOUT the state
 *  dir: a fresh one where no tab has ever been opened, or an unwritable one. */
function cliIn(stateDir: string, ...args: string[]) {
  const p = Bun.spawn(["python3", CLI, ...args], {
    // Its own state dir, so `--since-last` writes its cursor into THIS
    // test's scratch space, never the actual machine's ~/.cache.
    env: { PATH: process.env.PATH ?? "", AGENTGLASS_SERVER: base, AGENTGLASS_BROWSER_STATE_DIR: stateDir },
    stdout: "pipe", stderr: "pipe",
  });
  return Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]).then(([out, err, code]) => ({ out: out.trim(), err: err.trim(), code }));
}

/** A state dir nothing has ever written to. */
function freshState() {
  return mkdtempSync(join(dir, "st-"));
}

/**
 * One ask's arguments, with the wire metadata stripped.
 *
 * Every request now carries `as`, `how` and sometimes `pageExplicit` — who is
 * calling and how they addressed it, which is what the panel's ownership check
 * reads and what the audit records. None of that is what these tests are
 * about, and asserting whole objects against it turns every one of them into a
 * lock on the envelope rather than on the verb.
 */
function verbArgs(i = 0): Record<string, unknown> {
  const { as: _as, how: _how, pageExplicit: _pe, ...rest } = (askedArgs[i] ?? {}) as Record<string, unknown>;
  return rest;
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

  test("shot --selector/--full-page/--clip are one way at a time, and argparse says so before the server does", async () => {
    await openWindow();
    const r = await cli("shot", "--selector", "#e17", "--full-page");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not allowed|argument/i);
  });

  test("shot --selector reaches the window as the selector the server validates", async () => {
    await openWindow();
    asked = []; askedArgs = [];
    answers = { shot: { ok: true, value: { url: "u", title: "t", png: "data:image/png;base64,iVBORw0KGgo=" } } };
    const r = await cli("shot", "--selector", "#e17", join(dir, "e17.png"));
    expect(r.code).toBe(0);
    expect(verbArgs()).toEqual({ selector: "#e17" });
  });

  test("shot --clip parses x,y,w,h into the rectangle the server expects", async () => {
    await openWindow();
    asked = []; askedArgs = [];
    answers = { shot: { ok: true, value: { url: "u", title: "t", png: "data:image/png;base64,iVBORw0KGgo=" } } };
    const r = await cli("shot", "--clip", "10,20,300,150", join(dir, "clip.png"));
    expect(r.code).toBe(0);
    expect(verbArgs()).toEqual({ clip: { x: 10, y: 20, width: 300, height: 150 } });
  });

  test("shot --clip refuses a malformed rectangle before it ever reaches the window", async () => {
    await openWindow();
    asked = [];
    const r = await cli("shot", "--clip", "10,20,300");
    expect(r.code).toBe(1);
    expect(r.err).toContain("x,y,w,h");
    expect(asked).toEqual([]);
  });

  /* `shot --full-page` is gone — it repeated any sticky header once per screen.
   To capture more, make the viewport bigger with `resize` and take an ordinary
   shot: correct at any size, and the caller chooses the framing. */

  test("shot --highlight e17 --label draws a box and a caption, in one call", async () => {
    await openWindow();
    asked = []; askedArgs = [];
    answers = { shot: { ok: true, value: { url: "u", title: "t", png: "data:image/png;base64,iVBORw0KGgo=" } } };
    const r = await cli("shot", "--highlight", "#e17", "--label", "still Online", join(dir, "hi.png"));
    expect(r.code).toBe(0);
    expect(verbArgs()).toEqual({ highlight: "#e17", label: "still Online" });
  });

  test("--label without --highlight is refused by the CLI, before the server sees it", async () => {
    await openWindow();
    asked = [];
    const r = await cli("shot", "--label", "still Online");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--highlight");
    expect(asked).toEqual([]);
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
    /*
     * AND IT LEFT THE SCREEN ALONE.
     *
     * It used to open the browser view here, and that is the single most
     * complained-about behaviour this tool has: "I'm working away quietly
     * in my terminal… and it switches focus to the browser. I go back to the
     * terminal and it focuses the browser again… up to four, five and six
     * times." It was not a fix for anything either — the browser panel is
     * mounted from launch whether or not anybody goes to it, so this error
     * nearly always means the window is still starting, and the answer to that
     * is to wait.
     */
    expect(controls).toEqual([]);
  });

  test("it waits for a window that is merely starting, but not for long", async () => {
    /*
     * The wait exists because a restart is a second or two of "no window has
     * registered yet", and every call landing in it used to pull the whole app
     * over to the browser — reported as "every time you reinstall it moves me
     * to the browser view… and that 3-4 times", and it was an agent's status check
     * doing it.
     *
     * The bound matters as much as the wait. Nothing opens a pane any more —
     * that was the theft — so all an agent can do is wait and then say so, and
     * it must not spend forever finding out. Half a second of retry, a short
     * look, then a longer one for the tail of a restart: fifteen seconds is
     * the ceiling, and anything past it means somebody has turned a wait into
     * a hang.
     */
    await openWindow();
    await fetch(base + "/browser/ready", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: base },
      body: JSON.stringify({ client: CLIENT, on: false }),
    });
    const began = Date.now();
    const r = await cli("read");
    expect(r.code).toBe(1);
    expect(Date.now() - began).toBeLessThan(15_000);
  });

  /*
   * A pane that is behind another view is NOT a reason to take the screen.
   *
   * This used to open the browser view and retry, and it fired on every
   * screenshot: the capture came back empty whenever the person was looking at
   * anything else, so the window was pulled over to the browser in the middle
   * of their work, over and over. The capture itself is the thing that was
   * wrong (see ag:captureBrowser in electron/main.js); what is pinned here is
   * that the CLI no longer papers over it by moving somebody's app.
   */
  test("a pane that is not showing is reported, not fixed by grabbing the screen", async () => {
    await openWindow();
    asked = []; controls = [];
    answers = { shot: { ok: false, error: "the browser pane is not on screen, so there was no frame to capture" } };
    const r = await cli("shot", join(dir, "shot.png"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("not on screen");
    // Once, and the window was left exactly where the person had it.
    expect(asked).toEqual(["shot"]);
    expect(controls).toEqual([]);
  });

  test("unless the caller asks for it with --show, which is then opened and retried", async () => {
    await openWindow();
    asked = []; controls = [];
    /* Twice failing, then success. The plain retry comes FIRST — the panel
       re-registers itself for a moment whenever its tab changes, and a call
       landing in that gap is told the pane is not there when it is — so the
       screen is only touched once asking again has not fixed it. */
    let n = 0;
    answers = {
      get shot() {
        n += 1;
        return n <= 2
          ? { ok: false, error: "the browser pane is not on screen, so there was no frame to capture" }
          : { ok: true, value: { url: "u", title: "t", png: "data:image/png;base64,iVBORw0KGgo=" } };
      },
    } as typeof answers;
    const r = await cli("--show", "shot", join(dir, "shot.png"));
    expect(r.code).toBe(0);
    expect(asked).toEqual(["shot", "shot", "shot"]);
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

  /*
   * §14: the context budget. What a page returns is not the cost — what
   * stays in the caller's context for the rest of the session is, and 82.7%
   * of that (measured over 17 real sessions) is tool output. These three pin
   * the shapes that keep it small.
   */
  describe("the context budget (§14)", () => {
    test("--since-last remembers a cursor across two separate CLI processes", async () => {
      await openWindow();
      asked = []; askedArgs = [];
      answers = { observe: { ok: true, value: { url: "u", title: "t", now: 1000, tree: [], console: [], network: [] } } };
      const first = await cli("observe", "--since-last");
      expect(first.code).toBe(0);
      // Nothing remembered yet: the first call asks for everything.
      expect(askedArgs[0]?.since ?? 0).toBe(0);

      answers = { observe: { ok: true, value: { url: "u", title: "t", now: 2000, tree: [], console: [], network: [] } } };
      const second = await cli("observe", "--since-last");
      expect(second.code).toBe(0);
      // A fresh process — no in-memory state — and it still picked up what
      // the FIRST process was told, because that is the whole point.
      expect(askedArgs[1]?.since).toBe(1000);
    });

    test("--max-tokens shrinks a large observe by real, measured bytes — viewport first, oldest console dropped first", async () => {
      await openWindow();
      const tree = Array.from({ length: 200 }, (_, i) => ({
        role: "div", name: `item ${i}`,
        // Half on screen (an 800x600 viewport), half scrolled far below it.
        at: [0, i < 20 ? i * 20 : 5000 + i * 20, 100, 18],
      }));
      const consoleLog = Array.from({ length: 80 }, (_, i) => ({ at: i, level: "log", text: "x".repeat(50) }));
      const value = {
        url: "https://example.com/app", title: "The app", visible: true, focused: true, now: 42,
        viewport: { width: 800, height: 600 }, tree, console: consoleLog, network: [], form: [],
      };
      answers = { observe: { ok: true, value } };
      const before = await cli("observe");
      expect(before.code).toBe(0);
      const beforeBytes = Buffer.byteLength(before.out);

      answers = { observe: { ok: true, value: structuredClone(value) } };
      const after = await cli("--max-tokens", "300", "observe");
      expect(after.code).toBe(0);
      const afterBytes = Buffer.byteLength(after.out);
      // The measurement §14 asks for, in the assertion itself.
      expect(afterBytes).toBeLessThan(beforeBytes);
      expect(beforeBytes).toBeGreaterThan(15_000);
      expect(afterBytes).toBeLessThan(1_500);

      const shrunk = JSON.parse(after.out);
      expect(shrunk.truncated).toBe(true);
      // Kept the on-screen items over the ones 5000px down the page.
      expect(shrunk.tree.every((e: { name: string }) => Number(e.name.replace("item ", "")) < 20)).toBe(true);
      // Console: newest first when something must go — the caller just
      // triggered the newest entry, not the oldest one.
      expect(shrunk.console.at(-1)?.at).toBe(79);
    });

    test("--out writes the full answer to a file and prints the path plus a one-line summary", async () => {
      await openWindow();
      const value = { url: "https://example.com", title: "Billing", text: "Total 41", now: 7 };
      answers = { read: { ok: true, value } };
      const outPath = join(dir, "read-out.json");
      const r = await cli("--out", outPath, "read");
      expect(r.code).toBe(0);
      const lines = r.out.split("\n");
      expect(lines[0]).toBe(outPath);
      expect(lines[1]).toContain("Billing");
      const written = JSON.parse(await Bun.file(outPath).text());
      expect(written).toEqual(value);
    });

    test("cdp --out writes the answer to a file instead of dumping it to stdout", async () => {
      // Measured: `cdp Page.captureScreenshot --params ... --out x.json` printed
      // 70KB of base64 to stdout and left nothing at the path. The `cdp` branch
      // returned before the shared `--out` handling below it ever ran.
      await openWindow();
      const bigBase64 = "A".repeat(70_000);
      answers = { cdp: { ok: true, value: { data: bigBase64 } } };
      const outPath = join(dir, "cdp-out.json");
      const r = await cli("--out", outPath, "cdp", "Page.captureScreenshot");
      expect(r.code).toBe(0);
      expect(r.out.split("\n")[0]).toBe(outPath);
      // The base64 payload landed in the file, not in the context of whoever ran it.
      expect(r.out.length).toBeLessThan(1_000);
      const written = JSON.parse(await Bun.file(outPath).text());
      expect(written).toEqual({ data: bigBase64 });
    });
  });
});

describe("every verb is reachable from outside", () => {
  /*
   * THE LOCK THIS FILE WAS MISSING, and the reason it is here.
   *
   * §3 shipped seven verbs — hover, dblclick, rightclick, focus, blur, check,
   * fill. The server knew all seven. The CLI had a word for none of them and
   * the MCP had a tool for none of them, so no agent could ever have called
   * one: built, tested, green, and unreachable. Nothing noticed, because
   * nothing was looking at the three surfaces together.
   *
   * A verb that exists only in the server is not a feature, it is a plan.
   */
  const CLI = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
  const MCP = readFileSync(new URL("../../bin/agentglass-browser-mcp", import.meta.url), "utf8");

  /* Verbs the two front doors are allowed not to have, each for a stated
     reason. Empty is the goal; anything added here needs the reason with it. */
  const NOT_IN_CLI = new Set<string>([]);
  const NOT_IN_MCP = new Set<string>([]);

  test("the CLI has a word for every verb the server knows", () => {
    const missing = BROWSER_OPS.filter((op) =>
      !NOT_IN_CLI.has(op) && !CLI.includes(`"${op}"`));
    expect(missing, `the CLI cannot say: ${missing.join(", ")}`).toEqual([]);
  });

  test("and so does the MCP, which is how agents actually reach it", () => {
    const missing = BROWSER_OPS.filter((op) =>
      !NOT_IN_MCP.has(op) && !MCP.includes(`"browser_${op}"`));
    expect(missing, `no MCP tool for: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the skill an agent reads knows what the browser can do", () => {
  /*
   * The skill is the FIRST thing an agent reads, and it had drifted to
   * describing a browser that no longer exists: fifteen verbs out of
   * sixty-six, and a line saying "nothing here runs arbitrary JavaScript, by
   * design" — long after `eval` had landed.
   *
   * That is worse than a missing verb. An agent that reads it does not try,
   * so the capability might as well not be there. The surface lock above
   * catches a verb the CLI and the MCP cannot say; this catches the one thing
   * they can say and the documentation denies.
   */
  const SKILL = readFileSync(new URL("../../skills/browser-use/SKILL.md", import.meta.url), "utf8");

  test("every verb is named in it", () => {
    const missing = BROWSER_OPS.filter((op) => !new RegExp(`\\b${op}\\b`).test(SKILL));
    expect(missing, `the skill does not mention: ${missing.join(", ")}`).toEqual([]);
  });

  test("and it does not still say JavaScript is forbidden", () => {
    // The exact sentence that was there, and the shape of any replacement.
    expect(SKILL).not.toContain("Nothing here runs arbitrary JavaScript");
    expect(SKILL.toLowerCase()).not.toContain("no \"run this javascript\" tool");
  });
});

/*
 * WHO IS DRIVING, AND WHICH TAB IS THEIRS.
 *
 * Several agents use this browser at once and the rule — make your own
 * container, work in it, drop it — was written in the skill and kept by
 * nobody. It was not indiscipline. The easy path was a bare `open`, it worked
 * perfectly, and it landed in the shared profile, which is the person's own
 * cookies. A rule whose violation costs nothing and shows nothing is not a
 * rule, so identity stopped being something an agent remembers to ask for and
 * became what it gets.
 *
 * These drive the real CLI and assert on what reaches the WINDOW, because that
 * is where the collision happens: an ask with no `page` on it is an ask that
 * lands wherever the last person left the browser.
 */
describe("an agent has an identity without asking for one", () => {
  test("`open` carries a profile derived from the session", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t9-mine", tabs: [] } };
    askedArgs.length = 0;
    const r = await cliAsMe("open", "https://example.com/");
    expect(r.code).toBe(0);
    const profile = String(askedArgs[0]?.profile ?? "");
    expect(profile, "an agent must never be anonymous by accident").not.toBe("");
  });

  test("and every verb after it names that tab instead of the active one", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t9-mine", tabs: [] } };
    answers.read = { ok: true, value: { url: "https://example.com/", title: "x", text: "" } };
    answers.eval = { ok: true, value: { value: 1 } };
    await cliAsMe("open", "https://example.com/");
    askedArgs.length = 0;
    await cliAsMe("read");
    await cliAsMe("eval", "1+1");
    /* `read` and `eval` are two of the thirty-seven verbs that could not name a
       tab at all: the server has accepted `page` on every one of them from the
       start, and only six declared the flag. */
    expect(askedArgs.map((x) => x.page)).toEqual(["t9-mine", "t9-mine"]);
  });

  test("`--shared` is the only way into the person's own profile", async () => {
    await openWindow();
    answers.open = { ok: true, value: { url: "https://example.com/", title: "x" } };
    askedArgs.length = 0;
    await cliAsMe("open", "--shared", "https://example.com/");
    /* The EMPTY STRING, not nothing. It is what routes an `open` to the
       minting path (the panel keys on `typeof profile === "string"`), and
       sending nothing instead lands on the mounted webview — whichever tab is
       in front, whoever owns it, which is the hijack. */
    expect(askedArgs[0]?.profile).toBe("");
    expect(askedArgs[0]?.page).toBeUndefined();
  });

  test("`--as` and `--profile` are the same flag on every verb", async () => {
    await openWindow();
    answers.newtab = { ok: true, value: { id: "t9-a", tabs: [] } };
    askedArgs.length = 0;
    await cliAsMe("newtab", "--as", "one", "https://example.com/");
    await cliAsMe("newtab", "--profile", "one", "https://example.com/");
    expect(askedArgs.map((x) => x.profile)).toEqual(["one", "one"]);
  });

  test("two agents in one shell's worth of state do not take each other's tab", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t-first", tabs: [] } };
    await cliAsMe("open", "--as", "agent-one", "https://example.com/");
    answers.open = { ok: true, value: { id: "t-second", tabs: [] } };
    await cliAsMe("open", "--as", "agent-two", "https://example.com/");
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    askedArgs.length = 0;
    await cliAsMe("read", "--as", "agent-one");
    await cliAsMe("read", "--as", "agent-two");
    expect(askedArgs.map((x) => x.page)).toEqual(["t-first", "t-second"]);
  });

  test("a second `open` goes to the tab it already has rather than making another", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t-once", tabs: [] } };
    await cliAsMe("open", "--as", "agent-three", "https://example.com/");
    askedArgs.length = 0;
    await cliAsMe("open", "--as", "agent-three", "https://example.com/two");
    /* Fifty `open`s in a session means fifty pages, not fifty tabs — and fifty
       tabs is how a browser runs out of room holding the same page over. */
    expect(askedArgs[0]?.page).toBe("t-once");
    expect(askedArgs[0]?.profile).toBeUndefined();
  });

  test("`open --page <id>` navigates THAT tab instead of minting one", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t-new", tabs: [] } };
    askedArgs.length = 0;
    await cliAsMe("--page", "t-named", "open", "--as", "agent-five", "https://example.com/");
    /*
     * Naming a tab is the whole answer. This set the identity's `profile`
     * anyway, and the panel routes an `open` that carries a profile to "make a
     * tab in that container" — so it minted a new one, left the named tab
     * where it was, and answered with the URL and title of the tab it had just
     * made. Measured on the running app: the named tab stayed on
     * chrome-error://chromewebdata while the answer said "log probe".
     */
    expect(askedArgs[0]?.page).toBe("t-named");
    expect(askedArgs[0]?.profile, "a profile here makes the panel mint a tab").toBeUndefined();
  });

  test("a tab that has been closed is reopened, not addressed forever", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t-gone", tabs: [] } };
    await cliAsMe("open", "--as", "agent-four", "https://example.com/");
    answers.open = { ok: false, error: "no tab called t-gone — it was closed" };
    askedArgs.length = 0;
    await cliAsMe("open", "--as", "agent-four", "https://example.com/");
    // The first try names the dead tab; the second mints a new one by identity.
    expect(askedArgs.map((x) => [x.page, x.profile])).toEqual([
      ["t-gone", undefined], [undefined, "agent-four"],
    ]);
  });
});

test("`tab <id>` makes that tab the one every later verb goes to", async () => {
  /*
   * Selecting a tab and then capturing without `--page` gave the tab this CLI
   * last OPENED, not the one just selected — a valid picture of the wrong page,
   * which is the same silent failure as the one that started this, with the
   * parties swapped. Measured against the running app: `tabs` confirmed A was
   * active, `shot --page A` gave A's 53,233 bytes and a bare `shot` gave B's
   * 701,679.
   *
   * Asking for a tab by name is the clearest statement there is of which one
   * you mean.
   */
  await openWindow();
  answers.open = { ok: true, value: { id: "t-first", tabs: [] } };
  await cliAsMe("open", "--as", "picker", "https://example.com/");
  answers.newtab = { ok: true, value: { id: "t-second", tabs: [] } };
  await cliAsMe("newtab", "--as", "picker", "https://example.com/two");

  /* The tab verb answers with the list, and the selected one is `active`. */
  answers.tab = { ok: true, value: [
    { id: "t-first", title: "one", url: "https://example.com/", active: true, profile: "picker" },
    { id: "t-second", title: "two", url: "https://example.com/two", active: false, profile: "picker" },
  ] };
  await cliAsMe("tab", "--as", "picker", "t-first");

  answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
  askedArgs.length = 0;
  await cliAsMe("read", "--as", "picker");
  expect(askedArgs[0]?.page, "the one just selected, not the one last opened").toBe("t-first");
});

/*
 * ── THE FOUR VERBS THAT ANSWERED BEFORE ANYBODY ASKED WHO WAS CALLING ──────
 *
 * `session`, `permissions`, `cdp` and `do` return from the dispatcher three
 * hundred lines before identity used to be resolved, so `--as NAME` was parsed
 * and thrown away for them. Measured in the incident audit, seconds apart
 * inside ONE script that passed `--as` on every single invocation: the
 * six-separate-invocation arm routed a page id on every verb while the `do`
 * arm went bare on all six, and that alternation repeats seven times. Sixty
 * three bare calls, fourteen of which navigated or clicked in another agent's
 * tab, `ok: true` every time.
 *
 * These assert on what reaches the WINDOW, because the wire is where the
 * collision happens. An ask with no `page` is not "unspecified" to the relay —
 * it is "the tab in front", whoever owns it.
 */
describe.skipIf(!HAVE_PY)("every verb carries the caller's tab, the four early returns included", () => {
  /** Give `name` a tab of its own and hand back its id. */
  async function withTab(name: string, id: string) {
    answers.open = { ok: true, value: { id, tabs: [] } };
    const r = await cliAsMe("open", "--as", name, "https://example.com/");
    expect(r.code, r.err).toBe(0);
    askedArgs.length = 0;
    asked.length = 0;
    return id;
  }

  test("`do` addresses EVERY step, not the batch body", async () => {
    await openWindow();
    answers.open = { ok: true, value: { url: "u", title: "t" } };
    answers.click = { ok: true, value: { url: "u", title: "t" } };
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    const tab = await withTab("batch-one", "tX-aaaaaa");
    /*
     * THE PAGE ON THE BATCH BODY REACHES NOTHING. `/browser/do` hands
     * `b.steps` to `runSteps`, which re-parses each step through `parseAsk` —
     * and `parseAsk` builds a fresh `args` per op, so a key on the outer body
     * is never read. Only a per-step `page` arrives here, which is why this
     * asserts on all three and not on the request.
     */
    const r = await cliAsMe("do", "--as", "batch-one",
      "open https://example.com/two", "click #b", "read");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs.map((x) => x.page)).toEqual([tab, tab, tab]);
  });

  test("`do` names the caller on EVERY step — an anonymous step is one the panel lets through", async () => {
    await openWindow();
    answers.open = { ok: true, value: { url: "u", title: "t" } };
    answers.click = { ok: true, value: { url: "u", title: "t" } };
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    await withTab("batch-three", "tX-ffffff");
    /*
     * `do` was the incident's own vector. The CLI stamps `as` and `how` on the
     * OUTER body of the batch, and the route used to hand only `b.steps` on,
     * so every step reached the panel with a page and no name. The panel reads
     * a missing `as` as "cannot tell" and allows — it has to, the MCP surface
     * sends none — which turned the whole ownership check into a no-op for the
     * one verb that can read another container's page without an `open` first.
     */
    const r = await cliAsMe("do", "--as", "batch-three",
      "open https://example.com/three", "click #c", "read");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs.map((x) => x.as)).toEqual(["batch-three", "batch-three", "batch-three"]);
    expect(askedArgs.map((x) => x.how)).toEqual(["own-tab", "own-tab", "own-tab"]);
    /* Its own tab, filled in by the CLI: not a typed address. */
    expect(askedArgs.map((x) => x.pageExplicit)).toEqual([undefined, undefined, undefined]);
  });

  test("`--show` reaches the wire on a mint, `--no-show` takes it back, and the default is background", async () => {
    await openWindow();
    answers.open = { ok: true, value: { id: "t-shown", url: "u", title: "t" } };
    askedArgs.length = 0;
    let r = await cliAsMe("--show", "open", "--as", "shower", "https://example.com/");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.show).toBe(true);
    expect(r.err).toContain("--show: the browser pane is brought forward");
    askedArgs.length = 0;
    r = await cliAsMe("--show", "--no-show", "open", "--as", "shower-two", "https://example.com/");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.show).toBeUndefined();
    askedArgs.length = 0;
    r = await cliAsMe("open", "--as", "shower-three", "https://example.com/");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.show).toBeUndefined();
  });

  test("a redaction is SAID — the server counts what it masked and the CLI used to drop the count", async () => {
    await openWindow();
    await withTab("masked", "tX-mask01");
    answers.read = { ok: true, value: { url: "u", title: "t", text: "token ghp_" + "a".repeat(30) + " in the page" } };
    const r = await cliAsMe("read", "--as", "masked");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("[redacted]");
    expect(r.err).toContain("redacted: 1 span(s) in text");
  });

  test("`audit` shows the whole log by default — stamping `as` on it must not scope it to the caller", async () => {
    await openWindow();
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    await withTab("auditor-a", "tX-aaa111");
    await withTab("auditor-b", "tX-bbb222");
    expect((await cliAsMe("read", "--as", "auditor-a")).code).toBe(0);
    expect((await cliAsMe("read", "--as", "auditor-b")).code).toBe(0);
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(base + "/browser/audit", {
        method: "POST", headers: { "content-type": "application/json", Origin: base }, body: JSON.stringify(body),
      });
      return (await res.json()) as { value: { entries: { as?: string }[] } };
    };
    /* The CLI stamps `as` on every request, `audit` included. The day that
       doubled as the filter, every `audit` silently answered "only mine". */
    const whole = new Set((await post({ as: "auditor-a" })).value.entries.map((e) => e.as));
    expect(whole.has("auditor-a") && whole.has("auditor-b"), [...whole].join(",")).toBe(true);
    const narrowed = new Set((await post({ as: "auditor-a", by: "auditor-b" })).value.entries.map((e) => e.as));
    expect([...narrowed]).toEqual(["auditor-b"]);
  });

  test("and a typed `--page` on a `do` batch reaches every step as a deliberate address", async () => {
    await openWindow();
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    await withTab("batch-four", "tX-gggggg");
    /* The exemption the cross-container check honours is `pageExplicit`, and
       it too rode on the outer body only. */
    const r = await cliAsMe("--page", "tOTHER", "do", "--as", "batch-four", "read", "read");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs.map((x) => x.page)).toEqual(["tOTHER", "tOTHER"]);
    expect(askedArgs.map((x) => x.pageExplicit)).toEqual([true, true]);
    expect(askedArgs.map((x) => x.how)).toEqual(["explicit-page", "explicit-page"]);
  });

  test("`session save` addresses BOTH of its calls — it is the one that dumps the login", async () => {
    await openWindow();
    const tab = await withTab("saver", "tX-bbbbbb");
    answers.cdp = { ok: true, value: { result: { cookies: [] } } };
    answers.eval = { ok: true, value: { value: { origin: "https://example.com", localStorage: {}, sessionStorage: {} } } };
    const r = await cliAsMe("session", "--as", "saver", "save", join(dir, "s.json"));
    expect(r.code, r.err).toBe(0);
    /* Cookies through CDP and storage through eval: two calls, one tab. An
       unaddressed one writes whichever container is in front to a file. */
    expect(asked).toEqual(["cdp", "eval"]);
    expect(askedArgs.map((x) => x.page)).toEqual([tab, tab]);
  });

  test("`cdp` issues its DevTools command through the caller's own webview", async () => {
    await openWindow();
    const tab = await withTab("devtools", "tX-cccccc");
    answers.cdp = { ok: true, value: { product: "probe" } };
    const r = await cliAsMe("cdp", "--as", "devtools", "Browser.getVersion");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.page).toBe(tab);
  });

  test("`permissions` grants through the caller's own debugger session", async () => {
    await openWindow();
    const tab = await withTab("granter", "tX-dddddd");
    answers.cdp = { ok: true, value: {} };
    const r = await cliAsMe("permissions", "--as", "granter",
      "https://example.com", "clipboardReadWrite");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.page).toBe(tab);
  });

  test("`--page` beats the remembered tab on a `do` batch too", async () => {
    await openWindow();
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    await withTab("batch-two", "tX-eeeeee");
    const r = await cliAsMe("--page", "tOTHER", "do", "--as", "batch-two", "read");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs.map((x) => x.page)).toEqual(["tOTHER"]);
  });

  test("a --steps-file step that names its OWN page keeps it", async () => {
    await openWindow();
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    answers.text = { ok: true, value: { text: "" } };
    const tab = await withTab("batch-three", "tX-ffffff");
    /* The only multi-tab batch form that works today: `do_steps` passes
       file-sourced JSON through verbatim, with no key filtering. Stamping the
       caller's tab over it would break the one deliberate use of this while
       claiming to fix the accidental one. */
    const steps = join(dir, "steps.json");
    writeFileSync(steps, JSON.stringify([
      { op: "read", args: {} },
      { op: "text", args: { selector: "body", page: "tZ-named" } },
    ]));
    const r = await cliAsMe("do", "--as", "batch-three", "--steps-file", steps);
    expect(r.code, r.err).toBe(0);
    expect(askedArgs.map((x) => x.page)).toEqual([tab, "tZ-named"]);
  });
});

/*
 * ── AND NO FIFTH VERB GETS TO REPEAT IT ────────────────────────────────────
 *
 * The four above were fixed one at a time. That is not a fix, it is four
 * fixes, and the file has already lost this race once: `--out`/`--max-tokens`
 * "lived at the bottom of main() and the verbs that return EARLY — cdp, do —
 * never reached it". That was fixed by extracting `emit`; identity was not
 * moved with it, and the incident followed.
 *
 * So this reads the dispatcher out of the source and fails if ANY branch that
 * can send a request reaches the wire without asking who is calling first.
 *
 * The spec asked for "fails if any `return` precedes the identity assignment".
 * That wording would also condemn the argument-validation returns (`--field
 * takes SELECTOR=VALUE`, exit 2) which send nothing and are correct. What
 * matters is not returning early, it is ACTING early — so this bites on the
 * branches that call out, which is the same guarantee stated in the terms the
 * defect was actually in.
 */
describe("the dispatcher cannot act before it knows who is asking", () => {
  const src = readFileSync(new URL("../../bin/agentglass-browser", import.meta.url), "utf8");
  const mark = (needle: string) => {
    const i = src.indexOf(needle);
    expect(i, `${needle} is not in the CLI`).toBeGreaterThan(0);
    return i;
  };

  /* From the parse to the block that targets every ordinary verb: everything
     in between is a branch that answers and returns on its own. */
  const region = src.slice(mark("    a = ap.parse_args()"),
    mark("    # ── EVERY VERB GOES TO YOUR OWN TAB"));

  test("identity is resolved before the first branch, not inside them", () => {
    const resolved = region.indexOf("who = acting_as(a)");
    const firstBranch = region.search(/^ {4}if a\.cmd (?:==|in) /m);
    expect(resolved, "acting_as is not called at the top of main()").toBeGreaterThan(-1);
    expect(firstBranch, "no dispatch branch found — this lock is reading the wrong region")
      .toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(firstBranch);
  });

  /** Every top-level `def` whose body reaches `call(` — the helpers a branch
   *  can act through. Derived, so a new one is covered the day it is written. */
  const actingHelpers = [...src.matchAll(/^def (\w+)\(/gm)]
    .filter((m) => {
      const from = m.index! + m[0].length;
      const next = src.indexOf("\ndef ", from);
      return /\bcall\(/.test(src.slice(from, next === -1 ? undefined : next));
    })
    .map((m) => m[1])
    /* `call` is the wire itself and `main` is the dispatcher being audited. */
    .filter((name) => name !== "call" && name !== "main");
  const actsRe = new RegExp(`\\b(?:call|${actingHelpers.join("|")})\\(`);

  test("the helper list is read off the source, and it names the session pair", () => {
    expect(actingHelpers).toContain("session_save");
    expect(actingHelpers).toContain("session_load");
  });

  test("no early branch reaches the wire without resolving the target", () => {
    /* Split on the branch heads themselves, so a branch is read from its own
       `if a.cmd ...` to the next one — a landmark, never an offset. */
    const chunks = region.split(/\n(?=[ ]{4}if a\.cmd (?:==|in) )/);
    const offenders: string[] = [];
    for (const chunk of chunks.slice(1)) {
      const head = chunk.slice(0, chunk.indexOf("\n"));
      /* Anything that puts bytes on the wire: `call(` directly, or any helper
         whose body does — read off the source, not off a hand-kept list. The
         list knew two names and a sixth-verb-shaped branch acting through a
         third walked straight past it. */
      const acts = actsRe.exec(chunk);
      if (!acts) continue;
      const asks = chunk.indexOf("addressed(a");
      if (asks === -1 || asks > acts.index) offenders.push(head.trim());
    }
    expect(offenders,
      `these send a request before resolving the caller's tab: ${offenders.join(" / ")}`)
      .toEqual([]);
  });
});

/*
 * ── TWO MEANINGS THAT WERE WEARING ONE NAME ────────────────────────────────
 *
 * `--shared`'s own help said "deliberately use the DEFAULT profile, which is
 * the person's own session" and the skill repeated it. Both were false. It set
 * the identity to the empty string, `remember_tab` refuses a falsy name, so
 * `my_tab("")` was always None and the request went out with neither `profile`
 * nor `page` — byte-equivalent, in routing terms, to a call that names nothing
 * at all, which the panel resolves to the globally active tab. That tab
 * belongs to whoever last used the browser, agents included.
 *
 * It also made `--shared` unusable as the documented exemption the refusal
 * points at: an exemption that lands on a random agent's tab is not an
 * exemption. So the two meanings are two flags, and the person's own container
 * is an identity with a slot in the tab map like every other.
 */
describe.skipIf(!HAVE_PY)("`--shared` is the person's container; `--active` is the tab in front", () => {
  test("`--shared open` mints in the person's OWN container, not one named after it", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-persons-own", tabs: [] } };
    askedArgs.length = 0;
    const r = await cliIn(state, "open", "--shared", "https://example.com/");
    expect(r.code, r.err).toBe(0);
    /*
     * NOT `profile: "default"`. The panel resolves a profile name by lookup
     * and MINTS a container when the name is unknown, and the person's session
     * is the EMPTY profile field, rendered with the label "default" and absent
     * from the `profiles` list. Sending the literal string would build a
     * brand-new container beside the session it was meant to enter.
     */
    /* A NAME here would mint a container called "(default)" beside the
       person's own. The empty string is the person's own — the one profile
       value that is not a name. */
    expect(askedArgs[0]?.profile, "a name here mints a container beside the person's").toBe("");
    expect(askedArgs[0]?.page).toBeUndefined();
  });

  test("and every `--shared` verb after it names THAT tab, instead of guessing", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-persons-own", tabs: [] } };
    await cliIn(state, "open", "--shared", "https://example.com/");
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    askedArgs.length = 0;
    const r = await cliIn(state, "read", "--shared");
    expect(r.code, r.err).toBe(0);
    /* This is the whole requirement. It used to be `undefined` here, which is
       the active tab — so `--shared read` with container B in front returned
       B's page and called it the person's own. */
    expect(askedArgs[0]?.page).toBe("t-persons-own");
  });

  test("`--shared` with no tab open refuses, and names the flag that does mean the front tab", async () => {
    await openWindow();
    asked.length = 0;
    const r = await cliIn(freshState(), "read", "--shared");
    expect(r.code).toBe(1);
    expect(r.err).toContain("--active");
    /* Refused before anything reached the window, not after. */
    expect(asked).toEqual([]);
  });

  test("`--active` is the one flag that goes to the tab in front, whoever owns it", async () => {
    await openWindow();
    answers.read = { ok: true, value: { url: "u", title: "t", text: "" } };
    askedArgs.length = 0;
    const r = await cliIn(freshState(), "read", "--active");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.page, "an --active read is deliberately un-addressed").toBeUndefined();
    expect(askedArgs[0]?.profile).toBeUndefined();
  });

  test("asking for both is refused rather than silently picking one", async () => {
    await openWindow();
    asked.length = 0;
    const r = await cliIn(freshState(), "read", "--shared", "--active");
    expect(r.code).toBe(2);
    expect(r.err).toContain("different tabs");
    expect(asked).toEqual([]);
  });
});

/*
 * ── THE FLAGS EXIST ON EVERY VERB AND NOW SAY SO ───────────────────────────
 *
 * `add_global` registered `--as`, `--page`, `--shared` and `--show` on every
 * subcommand with BOTH `default=argparse.SUPPRESS` and `help=argparse.SUPPRESS`.
 * Only the first has a job — it is what stops a verb that does not carry the
 * flag from resetting the global answer to None. The second cost an hour of
 * somebody's work: two names for one thing, "an agent that learned one checked
 * the other's help, did not find it, and reasonably concluded the second could
 * not take an identity", then used a bare `open` and landed in the wrong
 * cookie jar. `open --help` printed four lines and none of them was `--as`.
 */
describe.skipIf(!HAVE_PY)("per-verb --help shows the flags the verb accepts", () => {
  /** argparse colourises when it thinks it is on a terminal; strip that. */
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  async function help(verb: string) {
    const r = await cliIn(freshState(), verb, "--help");
    expect(r.code).toBe(0);
    return plain(r.out);
  }

  test("`open --help` lists --as/--profile, --page, --shared, --active and --show", async () => {
    const h = await help("open");
    // `--as` and `--profile` are one option with two spellings; argparse prints
    // the pair as "--as NAME, --profile NAME" up to Python 3.12 and as
    // "--as, --profile NAME" from 3.13, so each spelling is asked for alone.
    for (const flag of ["--as", "--profile", "--page", "--shared", "--active", "--show"]) {
      expect(h, `open --help does not mention ${flag}`).toContain(flag);
    }
  });

  test("`settings --help` shows the identity flags and NOT --page", async () => {
    const h = await help("settings");
    expect(h).toContain("--as");
    expect(h).toContain("--profile");
    expect(h).toContain("--shared");
    expect(h).toContain("--show");
    /*
     * `settings` has an argument of its own called `page` — the internal page a
     * webview renders, where "blank" is the only allowed value. A tab id there
     * made every `settings set --page t17-... --cache bypass` answer
     * `page must be "blank"`, a sentence about an argument the caller never
     * passed. `--internal-page` is the one it does have.
     */
    expect(h).not.toContain("--page TAB");
  });

  test("`do --help` lists the two flags the batch actually honours", async () => {
    const h = await help("do");
    expect(h).toContain("--as");
    expect(h).toContain("--profile");
    expect(h).toContain("--page");
  });

  test("a flag after the verb and the same flag before it produce one request", async () => {
    /* `default=argparse.SUPPRESS` is the load-bearing half and stays: a verb
       that does not carry a flag must leave the global answer alone rather
       than reset it to None. */
    await openWindow();
    answers.open = { ok: true, value: { id: "t-order", tabs: [] } };
    askedArgs.length = 0;
    await cliIn(freshState(), "--as", "orderly", "open", "https://example.com/");
    await cliIn(freshState(), "open", "--as", "orderly", "https://example.com/");
    expect(askedArgs.map((x) => x.profile)).toEqual(["orderly", "orderly"]);
  });
});

/*
 * ── ONE AGENT'S POLLING MUST NOT NARROW ANOTHER'S DIFF ─────────────────────
 *
 * `--since-last` kept ONE cursor per verb in one machine-global `since.json`.
 * The live file had exactly four keys — observe, console, network, exposed —
 * serving every identity on the machine, with cursors from different sessions
 * and different days in the same slot (its `exposed` cursor was 5.5 days older
 * than its `observe` one). And the cursor advanced on EVERY call, asked for or
 * not.
 *
 * So agent A's ordinary `console` moved the floor under agent B: B's next
 * `console --since-last` returned only what happened after A's call — B's own
 * uncaught errors gone, an empty list, exit code 0, which reads as "no console
 * errors". Always in the under-report direction, which is the dangerous one.
 */
describe.skipIf(!HAVE_PY)("the --since-last cursor belongs to one identity", () => {
  test("agent A's ordinary console does not move agent B's floor", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-a", tabs: [] } };
    await cliIn(state, "open", "--as", "agent-a", "https://example.com/");
    answers.open = { ok: true, value: { id: "t-b", tabs: [] } };
    await cliIn(state, "open", "--as", "agent-b", "https://example.com/");

    answers.console = { ok: true, value: { rows: [], now: 1000 } };
    await cliIn(state, "console", "--as", "agent-b", "--since-last");   // B reads: floor 0, remembers 1000
    answers.console = { ok: true, value: { rows: [], now: 9000 } };
    await cliIn(state, "console", "--as", "agent-a");                   // A polls, asking for nothing
    answers.console = { ok: true, value: { rows: [], now: 12000 } };
    askedArgs.length = 0;
    await cliIn(state, "console", "--as", "agent-b", "--since-last");   // B reads again

    /* B's OWN last read, not A's. It used to be 9000 here, so everything
       between B's two reads came back as an empty list. */
    expect(askedArgs[0]?.since).toBe(1000);
  });

  test("and neither does A's own --since-last, which is the other half", async () => {
    /*
     * The test above bites on the GATE — A asked for nothing, so A must write
     * nothing. This one bites on the KEY: both agents ask for a diff, so both
     * write, and only per-identity slots keep them apart. With one slot per
     * verb for the whole machine, B's floor here is A's 9000.
     */
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-pa", tabs: [] } };
    await cliIn(state, "open", "--as", "poller-a", "https://example.com/");
    answers.open = { ok: true, value: { id: "t-pb", tabs: [] } };
    await cliIn(state, "open", "--as", "poller-b", "https://example.com/");

    answers.console = { ok: true, value: { rows: [], now: 1000 } };
    await cliIn(state, "console", "--as", "poller-b", "--since-last");
    answers.console = { ok: true, value: { rows: [], now: 9000 } };
    await cliIn(state, "console", "--as", "poller-a", "--since-last");
    answers.console = { ok: true, value: { rows: [], now: 12000 } };
    askedArgs.length = 0;
    await cliIn(state, "console", "--as", "poller-b", "--since-last");
    expect(askedArgs[0]?.since).toBe(1000);
  });

  test("a call that did not ask for a diff writes no cursor at all", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-quiet", tabs: [] } };
    await cliIn(state, "open", "--as", "quiet", "https://example.com/");
    answers.console = { ok: true, value: { rows: [], now: 7000 } };
    await cliIn(state, "console", "--as", "quiet");
    askedArgs.length = 0;
    await cliIn(state, "console", "--as", "quiet", "--since-last");
    /* The first `--since-last` returns the whole buffer, which is what a fresh
       state dir would have done anyway — and is the whole cost of this. */
    expect(askedArgs[0]?.since ?? 0).toBe(0);
  });

  test("since.json holds a slot per identity", async () => {
    await openWindow();
    const state = freshState();
    for (const [who, id] of [["keeper-one", "t-k1"], ["keeper-two", "t-k2"]]) {
      answers.open = { ok: true, value: { id, tabs: [] } };
      await cliIn(state, "open", "--as", who, "https://example.com/");
      answers.observe = { ok: true, value: { now: 500 } };
      await cliIn(state, "observe", "--as", who, "--since-last");
    }
    const held = JSON.parse(readFileSync(join(state, "since.json"), "utf8"));
    expect(Object.keys(held).sort()).toEqual(["keeper-one", "keeper-two"]);
    expect(held["keeper-one"]).toEqual({ observe: 500 });
  });

  test("a truncated cursor file still answers, with the whole buffer", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-trunc", tabs: [] } };
    await cliIn(state, "open", "--as", "truncated", "https://example.com/");
    /* A read verb must not fail because of a cache. The tool's own contract is
       that a bad state file costs the targeting, not the call. */
    writeFileSync(join(state, "since.json"), '{"truncated": {"conso');
    answers.console = { ok: true, value: { rows: [], now: 3000 } };
    askedArgs.length = 0;
    const r = await cliIn(state, "console", "--as", "truncated", "--since-last");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.since ?? 0).toBe(0);
  });
});

/*
 * ── A TAB THAT IS GONE STOPS BEING YOURS ───────────────────────────────────
 *
 * `forget_tab` had exactly ONE call site — the "no tab called" error path,
 * reached only after a request had already gone out naming a dead tab. So
 * closing your own tab, or dropping your own container, left the map pointing
 * at something gone.
 *
 * That was survivable while a stale id fell through to the active tab. It is
 * not now: the fall-through is a refusal, so a stale entry is a wall. Pruning
 * had to land WITH that refusal and not before it — before it, dropping the
 * entry would have removed the victim's only current signal.
 */
describe.skipIf(!HAVE_PY)("tab-map hygiene", () => {
  test("`closetab` on your own tab forgets it, so the next `open` mints a fresh one", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-doomed", tabs: [] } };
    await cliIn(state, "open", "--as", "closer", "https://example.com/");
    answers.closetab = { ok: true, value: [] };
    await cliIn(state, "closetab", "--as", "closer", "t-doomed");
    const held = JSON.parse(readFileSync(join(state, "my-tabs.json"), "utf8"));
    expect(held.closer, "the map still points at a tab that was just closed").toBeUndefined();
    /* And the identity is not stuck: `open` mints again under its own name. */
    answers.open = { ok: true, value: { id: "t-fresh", tabs: [] } };
    askedArgs.length = 0;
    const r = await cliIn(state, "open", "--as", "closer", "https://example.com/");
    expect(r.code, r.err).toBe(0);
    expect(askedArgs[0]?.profile).toBe("closer");
  });

  test("and `closetab` by INDEX forgets it too, when the list comes back empty", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-only", tabs: [] } };
    await cliIn(state, "open", "--as", "solo", "https://example.com/");
    /* Closing the LAST tab returns `[]` — a list, and the by-absence proof
       that the tab is gone. It used to be read as "no list", and the map kept
       pointing at a dead tab: the next `read` went out addressed to it. */
    answers.closetab = { ok: true, value: [] };
    const c = await cliIn(state, "closetab", "--as", "solo", "0");
    expect(c.code, c.err).toBe(0);
    const held = JSON.parse(readFileSync(join(state, "my-tabs.json"), "utf8"));
    expect(held.solo, "the map still points at the tab `closetab 0` closed").toBeUndefined();
    askedArgs.length = 0;
    const r = await cliIn(state, "read", "--as", "solo");
    expect(r.code).toBe(1);
    expect(askedArgs, "a dead tab went out on the wire").toEqual([]);
  });

  test("`profiles --drop` forgets the tab of the container it dropped", async () => {
    await openWindow();
    const state = freshState();
    answers.open = { ok: true, value: { id: "t-dropped", tabs: [] } };
    await cliIn(state, "open", "--as", "dropper", "https://example.com/");
    answers.profiles = { ok: true, value: [] };
    await cliIn(state, "profiles", "--as", "dropper", "--drop", "dropper");
    const held = JSON.parse(readFileSync(join(state, "my-tabs.json"), "utf8"));
    expect(held.dropper, "the container is gone, so its tab is gone too").toBeUndefined();
  });

  test("an unwritable state dir says so, once, and does not go bare afterwards", async () => {
    await openWindow();
    const state = join(dir, "readonly-state");
    mkdirSync(state, { recursive: true });
    chmodSync(state, 0o500);
    try {
      answers.open = { ok: true, value: { id: "t-unwritable", tabs: [] } };
      /* The call still works — a state file that cannot be written costs the
         automatic targeting, not the call. */
      const opened = await cliIn(state, "open", "--as", "stuck", "https://example.com/");
      expect(opened.code, opened.err).toBe(0);
      /* But it SAYS so. This used to be `except Exception: pass`, so an
         unwritable cache turned targeting off in silence — and silent
         targeting-off is exactly the state in which the next verb goes
         somewhere the caller did not choose. */
      expect(opened.err).toContain("automatic targeting is off");
      asked.length = 0;
      const read = await cliIn(state, "read", "--as", "stuck");
      expect(read.code, "with no remembered tab this must refuse, not go bare").toBe(1);
      expect(asked).toEqual([]);
    } finally {
      chmodSync(state, 0o700);
    }
  });

  test("two identities opening at the same time both keep their key", async () => {
    /*
     * `remember_tab` and `forget_tab` are read-modify-write cycles. `os.replace`
     * makes each WRITE atomic; it does not make the cycle atomic. Measured on
     * this machine before the lock, two processes calling `remember_tab` once
     * each against a fresh state dir: 16 of 200 iterations lost an identity.
     *
     * A lost key is not "the caller retries". Under the refusal it is a call
     * that STOPS, for a tab that is open and working, because somebody else
     * opened one at the same millisecond.
     */
    await openWindow();
    let lost = 0;
    const ROUNDS = 60;
    for (let i = 0; i < ROUNDS; i++) {
      const state = freshState();
      answers.open = { ok: true, value: { id: `t-race-${i}`, tabs: [] } };
      await Promise.all([
        cliIn(state, "open", "--as", "racer-a", "https://example.com/"),
        cliIn(state, "open", "--as", "racer-b", "https://example.com/"),
      ]);
      const held = JSON.parse(readFileSync(join(state, "my-tabs.json"), "utf8"));
      if (!held["racer-a"] || !held["racer-b"]) lost++;
    }
    expect(lost, `${lost} of ${ROUNDS} concurrent pairs lost an identity`).toBe(0);
    /* 60 rounds and not 5. Measured by taking the lock back out and running
       this exact test: 4 of 60 pairs lost an identity, in line with the 16 of
       200 measured against `remember_tab` directly. At that rate a five-round
       test misses the regression two times in three; sixty leaves under a 2%
       chance of a green run with the lock gone. The explicit timeout is
       because 120 python spawns do not fit in bun's 5s default. */
  }, 60_000);
});

