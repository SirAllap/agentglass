/*
 * Walk the whole app in a real browser and report what breaks.
 *
 * The gap this closes: `tsc`, a Metro bundle and a Hermes export all pass on
 * code that does not run. So the first thing ever to execute a screen was a
 * phone, and the first person to see one fail was whoever was holding it.
 *
 * This builds the web target — the same component tree, with the native modules
 * swapped for stand-ins (see metro.config.js) — pairs itself against a real
 * agentglass server so the screens have real data, then visits every route and
 * collects every console error, every uncaught exception and what actually
 * rendered.
 *
 *   bun scripts/qa.ts [--server http://127.0.0.1:4010] [--keep]
 *
 * It pairs by walking the real handshake, so it proves that path too. The
 * device is asked for at `read` scope and the server's own rules then decide
 * what the screens may do — a QA run must not be able to push a branch.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "bun";
import { makeKeys, unseal } from "../src/lib/pairing.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const SERVER = flag("server", "http://127.0.0.1:4010");
/**
 * What the harness is allowed to do.
 *
 * `read` by default: a sweep walks every screen and must not be able to stage,
 * commit, push or answer a gate. But `/terminal/pty` needs `full`, so a run
 * that wants to see the terminal actually attach has to ask for it — and that
 * is a decision worth making out loud rather than a default.
 */
const SCOPE = flag("scope", "read");
const WEB_PORT = 4599;
const CDP_PORT = 9456;
const OUT = join(import.meta.dir, "..", ".qa");
/** Screenshots, kept after the run so they can be looked at. */
const SHOTS = join(import.meta.dir, "..", ".qa-shots");

/** Every screen, and how to know it drew rather than merely mounted.
 *
 *  `pane` marks the one screen whose real output is inside the WebView. See
 *  `paneText` and the check in the loop: under `full` a green row there has to
 *  mean characters arrived from a live tmux pane, not that a bar mounted. */
const ROUTES: { path: string; name: string; expect: RegExp; pane?: boolean }[] = [
  // Eight: the bar offers five and the other three are still routes. Two names
  // that were here are not any more, and neither drifted out — Chats was
  // deleted with the conversation UI, and Review was dissolved into the two
  // destinations it used to wrap. Both of those are visited on their own below.
  { path: "/", name: "Inbox", expect: /On the machine|things want you|Nothing is waiting|Quiet/i },
  { path: "/now", name: "Now", expect: /waiting on you|Nothing is waiting|Empty/i },
  // Not "Esc". That is on the key bar whatever the terminal is doing, and
  // asserting it is how this screen passed three times while showing nothing —
  // the comment saying so has been sitting above the regex that does it. What
  // is asserted here instead is the chrome telling the truth about the state
  // it is in, and, under `full`, the pane itself.
  { path: "/terminal", name: "Terminal", pane: true,
    expect: /Attaching|Disconnected|Nothing open|Looking|·p\d|^\s*\d+ /im },
  { path: "/prs", name: "PRs", expect: /My review|Nothing open|Cannot ask GitHub/i },
  // The detail is reached with two params and nothing else knows them, so this
  // walks it directly. `#0` is not a pull request anywhere, which is the point:
  // what is asserted is that the screen mounts and SAYS it could not read it,
  // rather than rendering a blank on a number that does not exist.
  { path: "/pr/0?root=%2Ftmp", name: "PR detail", expect: /Cannot read it|could not be read|out of scope|not a git repository/i },
  // The screen this app never had. `Mine` is its own filter row rather than a
  // row of results, so it holds whether or not the repository has any issues —
  // which is the point: the failure this catches is the screen not mounting.
  { path: "/issues", name: "Issues", expect: /Mine|Nothing open|Cannot ask GitHub/i },
  { path: "/repos", name: "Repos", expect: /changed|Nothing changed/i },
  { path: "/tasks", name: "Cards", expect: /hiding done|Nothing here|Cannot read the board/i },
  { path: "/settings", name: "Settings", expect: /Paired with|This phone may/i },
];

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

/* ── pair, the way the phone does ─────────────────────────────────────────── */

async function pair(): Promise<{ origin: string; token: string; scope: string; deviceId: string }> {
  const machine = process.env.AGENTGLASS_TOKEN ?? "";
  const desk = (path: string, body?: unknown): Promise<Response> =>
    fetch(SERVER + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(machine ? { authorization: `Bearer ${machine}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const ticket = await (await desk("/pair/ticket", {})).json() as { ok: boolean; id: string; code: string };
  if (!ticket.ok) throw new Error("the server would not mint a pairing ticket — is AGENTGLASS_TOKEN set?");

  const keys = makeKeys();
  const claim = await (await fetch(`${SERVER}/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket: ticket.id, code: ticket.code, label: "QA harness", pub: keys.pub }),
  })).json() as { ok: boolean; secret: string; error?: string };
  if (!claim.ok) throw new Error(`claim refused: ${claim.error}`);

  // `read`, deliberately. A QA run walks every screen and must not be able to
  // stage, commit, push or answer a gate on somebody's real machine.
  const accepted = await (await desk("/pair/accept", { ticket: ticket.id, scope: SCOPE })).json() as unknown;

  const got = await (await fetch(
    `${SERVER}/pair/collect?ticket=${encodeURIComponent(ticket.id)}&secret=${encodeURIComponent(claim.secret)}`,
  )).json() as { state: string; wrapped: { pub: string; iv: string; data: string }; scope: string };
  if (got.state !== "accepted") throw new Error(`collect said ${got.state}`);

  return {
    origin: SERVER,
    token: unseal(got.wrapped, keys.priv, ticket.id),
    scope: got.scope,
    // Handed back so the run can revoke itself. A sweep that leaves a working
    // credential behind on every invocation fills somebody's paired-devices
    // list with a dozen "QA harness" rows — which is what happened, in the
    // pane they then have to scroll past to pair a real phone.
    deviceId: (accepted as { device?: { id?: string } }).device?.id ?? "",
  };
}

/* ── the browser ──────────────────────────────────────────────────────────── */

interface Cdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  on: (method: string, fn: (params: Record<string, unknown>) => void) => void;
  close: () => void;
}

async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("could not attach to chrome"));
  });
  let id = 0;
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  /*
   * Both dispatches below look up a handler with a name that came off the wire,
   * which is the shape of a real vulnerability — with a plain OBJECT. A frame
   * claiming `"__proto__"` or `"constructor"` would find something inherited,
   * and calling it dispatches somewhere nobody wrote.
   *
   * These are Maps, and that is the whole answer: a Map resolves only keys that
   * were `set`. Measured — `__proto__`, `constructor`, `toString` and `valueOf`
   * all come back `undefined`, and so does the string `"1"` against the number
   * key `1`. The `?.()` then makes a miss a no-op rather than a throw. The only
   * callables in reach are the ones this function put there: a promise resolver
   * keyed by a local counter, and listeners keyed by our own literals.
   *
   * Written down because a scanner flags this every time and the answer is not
   * visible at the call site — it is in the choice of Map over {}.
   */
  ws.onmessage = (m: { data: string }) => {
    const frame = JSON.parse(m.data) as { id?: number; method?: string; result?: unknown; params?: unknown };
    if (frame.id !== undefined) pending.get(frame.id)?.((frame.result ?? {}) as Record<string, unknown>);
    if (frame.method) {
      for (const fn of listeners.get(frame.method) ?? []) fn((frame.params ?? {}) as Record<string, unknown>);
    }
  };

  return {
    send: (method, params = {}) => new Promise((res) => {
      const mine = ++id;
      pending.set(mine, res);
      ws.send(JSON.stringify({ id: mine, method, params }));
    }),
    on: (method, fn) => {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    close: () => ws.close(),
  };
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const keep = args.includes("--keep");

rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

say(`building the web target…`);
const build = Bun.spawnSync(
  ["npx", "expo", "export", "--platform", "web", "--output-dir", OUT],
  { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
);
if (build.exitCode !== 0) {
  say(build.stderr.toString().slice(-3000));
  throw new Error("the web build failed — that is the first thing to fix");
}

const host = await pair();
say(`paired with ${host.origin} at scope "${host.scope}"`);

const web = serve({
  port: WEB_PORT,
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = join(OUT, path === "/" ? "index.html" : path.slice(1));
    // Expo Router is a single-page app: an unknown path is a route, not a 404.
    return new Response(Bun.file(existsSync(file) && !file.endsWith("/") ? file : join(OUT, "index.html")));
  },
});

const profile = mkdtempSync(join(tmpdir(), "agx-qa-"));

/**
 * Which browser to drive.
 *
 * It used to be the literal `/usr/bin/google-chrome`, which is a path a Chrome
 * install does not always leave behind: on Arch the package installs
 * `google-chrome-stable` and nothing else, so the spawn failed silently
 * (`stderr: "ignore"`) and the run died 20 seconds later on "chrome never
 * opened a page" — a message about the browser that says nothing about the
 * binary being missing. Any Chromium build serves: what this harness needs from
 * it is the DevTools protocol, which they all speak.
 */
function browser(): string {
  const tried = [
    process.env.CHROME ?? "",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  const found = tried.find((path) => existsSync(path));
  if (!found) throw new Error(`no Chrome to drive — looked at ${tried.join(", ")}. Set CHROME=<path>.`);
  return found;
}

const chrome = Bun.spawn([
  browser(), "--headless=new", "--disable-gpu", "--no-first-run",
  // The app talks to the agentglass server on another port. A browser calls
  // that cross-origin; a phone does not. This is a harness, and the thing under
  // test is the screens, not the browser's own rules.
  "--disable-web-security", `--user-data-dir=${profile}`,
  "--window-size=412,915", `--remote-debugging-port=${CDP_PORT}`, "about:blank",
], { stdout: "ignore", stderr: "ignore" });

const target = await (async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as
        { type: string; webSocketDebuggerUrl?: string }[];
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  throw new Error("chrome never opened a page");
})();

const cdp = await connect(target);
const problems: { route: string; text: string }[] = [];
let route = "boot";

const record = (text: string): void => {
  const line = text.split("\n")[0]!.trim();
  if (!line) return;
  // Noise from the harness itself, and from React's development build telling
  // us about the shims. Neither is the app being wrong.
  if (/\[shim\]|Download the React DevTools|was preloaded using link preload/i.test(line)) return;
  problems.push({ route, text: line.slice(0, 200) });
};

cdp.on("Runtime.consoleAPICalled", (p) => {
  const params = p as { type: string; args: { value?: unknown; description?: string }[] };
  if (params.type !== "error") return;
  record(params.args.map((a) => String(a.value ?? a.description ?? "")).join(" "));
});
cdp.on("Runtime.exceptionThrown", (p) => {
  const params = p as { exceptionDetails: { exception?: { description?: string }; text: string } };
  record(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
});

await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

// Seed the paired host before the app boots, so every screen has real data.
await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `localStorage.setItem(${JSON.stringify("agentglass.host")}, ${JSON.stringify(JSON.stringify({
    origin: host.origin, token: host.token, label: "QA harness", scope: host.scope, pairedAt: Date.now(),
  }))});`,
});

const text = async (): Promise<string> => {
  const answer = await cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText || ''",
    returnByValue: true,
  }) as { result?: { value?: string } };
  return answer.result?.value ?? "";
};

/**
 * What is on the terminal's own screen, which the sweep above cannot see.
 *
 * The pane runs inside the WebView, and under this harness the WebView is a
 * real iframe (`src/web-shims/webview.tsx`) — so `document.body.innerText`
 * stops at its border and reads the chrome around an empty box. Every
 * assertion this sweep has ever made about the terminal was therefore about
 * the tab strip and the key bar, which is exactly how the screen passed three
 * times while showing nothing.
 *
 * The iframe is `srcDoc`, so it inherits this origin and its document is
 * readable from here.
 */
const paneText = async (): Promise<string> => {
  const answer = await cdp.send("Runtime.evaluate", {
    expression: "(document.querySelector('iframe')?.contentDocument?.body?.innerText) || ''",
    returnByValue: true,
  }) as { result?: { value?: string } };
  return answer.result?.value ?? "";
};

say("");
let failures = 0;
for (const screen of ROUTES) {
  route = screen.name;
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${WEB_PORT}${screen.path}` });
  // Long enough for the first load and for a screen's own fetches to land.
  // The terminal opens a socket, tmux attaches and the pane redraws — none of
  // that is instant, and a screenshot taken too early shows an empty box and
  // calls it a pass.
  await Bun.sleep(screen.path === "/" ? 6000 : screen.path === "/terminal" ? 9000 : 3500);
  // A screenshot per screen, because a regex over innerText says a string is
  // present and nothing about whether anybody could see it. These are for
  // LOOKING at — the whole point of the harness is to stop handing that job to
  // somebody with a phone.
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data?: string };
  if (shot.data) {
    await Bun.write(join(SHOTS, `${screen.name.toLowerCase()}.png`), Buffer.from(shot.data, "base64"));
  }
  const shown = await text();
  let drew = screen.expect.test(shown);
  let note = "";
  /*
   * The pane, where there is one to have.
   *
   * Two gates, and both were learnt by getting them wrong. `read` cannot open a
   * pane at all — the server refuses `/terminal/pty` — so demanding content
   * there fails the honest case. And a machine whose tmux has no client
   * attached has no panes to list, which is a state the screen reports
   * correctly and must not be scored as a break; the first version of this
   * check failed the sweep for it.
   *
   * What is NOT allowed is the middle: a pane opened and nothing drawn. Forty
   * non-space characters is a prompt and a line of something, and xterm writes
   * its rows out as text even on an idle pane.
   *
   * `nothing` is said out loud in the row either way. A green Terminal on a
   * machine with no panes proves the empty state and nothing else, and this
   * screen has been reported working three times on exactly that much.
   */
  if (drew && screen.pane && SCOPE === "full") {
    const nothing = /Nothing open|Looking/i.test(shown);
    const inside = (await paneText()).replace(/\s+/g, "");
    if (nothing) {
      note = "no tmux pane on this machine — the empty state, not the terminal";
    } else if (inside.length < 40) {
      drew = false;
      note = `a pane is open and the WebView drew nothing — ${inside.length} characters`;
    } else {
      note = `${inside.length} characters on the pane`;
    }
  }
  const mine = problems.filter((p) => p.route === screen.name);
  if (!drew || mine.length) failures++;
  say(`${drew && !mine.length ? "  ok  " : " FAIL "} ${screen.name.padEnd(9)} ${
    drew
      ? (note ? `${note} — ` : "") + shown.replace(/\s+/g, " ").slice(0, 74)
      : note || `did not draw — saw ${JSON.stringify(shown.replace(/\s+/g, " ").slice(0, 60))}`
  }`);
  for (const p of mine) say(`         ✗ ${p.text}`);
}

const boot = problems.filter((p) => p.route === "boot");
if (boot.length) {
  say(`\nal arrancar (${boot.length}):`);
  for (const p of boot) say(`  ✗ ${p.text}`);
}

say(`\n${ROUTES.length - failures}/${ROUTES.length} pantallas ${failures ? "— FAIL" : "— PASS"}`);
say(`capturas en ${SHOTS}`);

// Revoke this run's credential. The machine token is what is allowed to do it,
// and the harness is the only thing that knows which device was its own.
if (host.deviceId) {
  await fetch(`${SERVER}/pair/forget`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.AGENTGLASS_TOKEN ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: host.deviceId }),
  }).catch(() => { /* the server may already be gone */ });
}

cdp.close();
chrome.kill();
web.stop(true);
rmSync(profile, { recursive: true, force: true });
if (!keep) rmSync(OUT, { recursive: true, force: true });
process.exit(failures || boot.length ? 1 : 0);
