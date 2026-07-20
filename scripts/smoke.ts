#!/usr/bin/env bun
/**
 * Boot the real production bundle in a headless browser and fail if it doesn't
 * come up.
 *
 * Why this exists: a `ReferenceError: Cannot access 'relOf' before
 * initialization` — a `useMemo` reading a `const` declared further down the
 * component — shipped to a built desktop app and painted a black screen. It
 * passed `tsc --noEmit` (TypeScript does not flag use-before-declaration across
 * a closure), all of `bun test` (which covers the helper modules, not the
 * components) and `vite build` (the bundle is valid JS; it only dies when a
 * browser runs it). Nothing we had could see it, because nothing we had ever
 * *executed* the bundle. This does.
 *
 * Driven over the Chrome DevTools Protocol rather than by scraping
 * `--dump-dom` stderr: attaching to the target *before* navigating is the only
 * way to be sure no console event or exception is missed, `Runtime.evaluate`
 * gives a real answer about whether React mounted instead of a regex over HTML,
 * and stack traces arrive structured instead of glued into log lines.
 *
 *   bun scripts/smoke.ts            # serves web/dist, exits non-zero on failure
 *   bun scripts/smoke.ts --headful  # same, with a visible window, for debugging
 */

import { spawn } from "bun";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "web", "dist");

/** How long React gets to put something inside #root. */
const MOUNT_TIMEOUT_MS = 20_000;
/** Quiet period after mount — errors thrown by effects land here, not at load. */
const SETTLE_MS = 2_000;

// ---------------------------------------------------------------------------
// static server
// ---------------------------------------------------------------------------

/** Serve web/dist with an SPA fallback, on whatever port the OS hands out. */
function serveDist() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
      if (await file.exists()) return new Response(file);
      // Unknown path with no extension is a client route, not a missing asset.
      if (!path.split("/").pop()!.includes("."))
        return new Response(Bun.file(join(DIST, "index.html")), {
          headers: { "content-type": "text/html" },
        });
      return new Response("not found", { status: 404 });
    },
  });
}

// ---------------------------------------------------------------------------
// chrome
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chrome", // what browser-actions/setup-chrome puts on PATH
  "chromium",
  "chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean) as string[];

function findChrome(): string {
  // An explicit CHROME_PATH wins and is never fallen back from: silently using
  // some other browser than the one CI was told to use hides the breakage.
  const pinned = process.env.CHROME_PATH?.trim();
  if (pinned) {
    if (existsSync(pinned) || Bun.which(pinned)) return pinned;
    throw new Error(`CHROME_PATH is set to ${pinned}, which does not exist`);
  }
  for (const c of CHROME_CANDIDATES) {
    if (c.includes("/")) {
      if (existsSync(c)) return c;
      continue;
    }
    if (Bun.which(c)) return c;
  }
  throw new Error(
    `no Chrome found (tried: ${CHROME_CANDIDATES.join(", ")}) — set CHROME_PATH`
  );
}

/**
 * Start Chrome and wait until its DevTools endpoint answers.
 *
 * Port 0 makes Chrome pick a free one and write it to DevToolsActivePort in the
 * profile dir, which is what keeps parallel CI jobs on one runner from fighting
 * over a hardcoded port.
 */
async function launchChrome(headful: boolean) {
  const profile = mkdtempSync(join(tmpdir(), "agentglass-smoke-"));
  const proc = spawn({
    cmd: [
      findChrome(),
      ...(headful ? [] : ["--headless=new"]),
      "--no-sandbox", // GitHub runners and most containers have no user namespaces
      "--disable-gpu",
      "--disable-dev-shm-usage", // /dev/shm is tiny in containers; Chrome crashes without this
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "ignore",
    stderr: "ignore",
  });

  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, "utf8").split("\n")[0]!.trim();
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        const { webSocketDebuggerUrl } = (await r.json()) as {
          webSocketDebuggerUrl: string;
        };
        if (webSocketDebuggerUrl)
          return { proc, profile, wsUrl: webSocketDebuggerUrl };
      } catch {
        /* endpoint not up yet */
      }
    }
    if (proc.exitCode !== null)
      throw new Error(`Chrome exited early (code ${proc.exitCode})`);
    await Bun.sleep(100);
  }
  throw new Error("Chrome did not expose a DevTools endpoint within 30s");
}

// ---------------------------------------------------------------------------
// minimal CDP client
// ---------------------------------------------------------------------------

type CdpEvent = { method: string; params: any; sessionId?: string };

class Cdp {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #listeners: ((e: CdpEvent) => void)[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (!p) return;
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else {
        for (const l of this.#listeners) l(msg);
      }
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => res(new (Cdp as any)(ws)));
      ws.addEventListener("error", () => rej(new Error("CDP websocket failed")));
    });
  }

  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(fn: (e: CdpEvent) => void) {
    this.#listeners.push(fn);
  }

  close() {
    this.#ws.close();
  }
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

/** A stack for `text`, unless it is an Error whose description carries one. */
const stackOf = (text: string, trace?: { callFrames?: any[] }) => {
  if (/\n\s+at /.test(text)) return "";
  return (trace?.callFrames ?? [])
    .slice(0, 8)
    .map((f) => `      at ${f.functionName || "(anonymous)"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join("\n");
};

async function main() {
  if (!existsSync(join(DIST, "index.html")))
    throw new Error(`no build at ${DIST} — run \`bun run build\` first`);

  const server = serveDist();
  const url = `http://127.0.0.1:${server.port}/`;
  const failures: string[] = [];
  // Declared out here so the cleanup below runs even when Chrome is what fails.
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  let cdp: Cdp | undefined;

  try {
    chrome = await launchChrome(process.argv.includes("--headful"));
    cdp = await Cdp.connect(chrome.wsUrl);

    // Attach before navigating: anything logged while the bundle first
    // evaluates — which is exactly when a TDZ fault fires — is only visible to
    // a listener that was already there.
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

    cdp.on((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.method === "Runtime.exceptionThrown") {
        const d = e.params.exceptionDetails;
        const text = d.exception?.description || d.text || "uncaught exception";
        failures.push(`[uncaught] ${text}\n${stackOf(text, d.stackTrace)}`.trimEnd());
      }
      if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
        const text = e.params.args
          .map((a: any) => a.description ?? a.value ?? JSON.stringify(a.preview ?? a.type))
          .join(" ");
        failures.push(`[console.error] ${text}\n${stackOf(text, e.params.stackTrace)}`.trimEnd());
      }
      // Log.entryAdded carries browser-side errors — but also every failed
      // request. There is no backend behind this static bundle on purpose, so
      // `network` entries are the expected shape of "server isn't running",
      // not a defect in the code being tested.
      if (e.method === "Log.entryAdded" && e.params.entry.level === "error" && e.params.entry.source !== "network")
        failures.push(`[${e.params.entry.source}] ${e.params.entry.text}`);
    });

    for (const m of ["Runtime.enable", "Log.enable", "Page.enable"])
      await cdp.send(m, {}, sessionId);

    await cdp.send("Page.navigate", { url }, sessionId);

    // Poll for a mounted tree rather than trusting the load event: React
    // renders after it, and a bundle that throws still fires `load` happily.
    const deadline = Date.now() + MOUNT_TIMEOUT_MS;
    let mounted = false;
    while (Date.now() < deadline && !mounted) {
      const { result } = await cdp.send(
        "Runtime.evaluate",
        { expression: "!!document.querySelector('#root') && document.querySelector('#root').childElementCount > 0", returnByValue: true },
        sessionId
      );
      mounted = result.value === true;
      // An error already means a failed run, so there is nothing to gain from
      // sitting out the rest of the timeout.
      if (!mounted && failures.length) break;
      if (!mounted) await Bun.sleep(250);
    }

    if (mounted) await Bun.sleep(SETTLE_MS);

    console.log(`smoke: served ${DIST} at ${url}`);
    if (!mounted) {
      console.error(
        failures.length
          ? "\n✗ smoke: the app never mounted — #root is empty and the bundle threw"
          : `\n✗ smoke: #root is still empty after ${MOUNT_TIMEOUT_MS / 1000}s — the app never mounted`
      );
    } else if (failures.length) {
      console.error(`\n✗ smoke: app mounted but ${failures.length} console error(s) were logged`);
    }

    if (failures.length) {
      console.error("\nconsole errors:\n");
      for (const f of failures) console.error(f + "\n");
    }

    if (!mounted || failures.length) process.exitCode = 1;
    else console.log("✓ smoke: app mounted, no console errors");
  } finally {
    cdp?.close();
    if (chrome) {
      chrome.proc.kill();
      await chrome.proc.exited;
      rmSync(chrome.profile, { recursive: true, force: true });
    }
    server.stop(true);
  }
}

await main();
