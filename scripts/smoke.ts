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

  // SIGTERM/SIGINT skip the finally below, so an interrupted smoke would leave
  // the headless Chrome it spawned orphaned (the static server is in-process,
  // but Chrome is a real subprocess). Wire the same teardown to those signals.
  for (const s of ["SIGINT", "SIGTERM"] as const) {
    process.on(s, () => {
      try { chrome?.proc.kill(); } catch { /* already gone */ }
      try { server.stop(true); } catch { /* already down */ }
      process.exit(1);
    });
  }

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

    // The workspace is the app's main surface and all of it sits behind a
    // keypress, so "the dashboard mounted" says nothing about it. Drive it the
    // way a user does: open it, switch views, and check the views really are
    // all mounted at once — the keep-state-alive property is the whole design,
    // and it fails silently (you only notice a lost commit draft later).
    if (mounted) {
      const evaluate = async (expression: string) => {
        const { result, exceptionDetails } = await cdp!.send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          sessionId
        );
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      };

      // A real window-level keydown, which is where App.tsx listens.
      const press = (key: string, mod = false) =>
        evaluate(`(() => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ctrlKey: ${mod}, bubbles: true, cancelable: true }));
          return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        })()`);

      const railSel = '[role="tablist"][aria-label="Workspace views"]';
      const selectedView = () =>
        evaluate(`document.querySelector('${railSel} [aria-selected="true"]')?.getAttribute("data-view") ?? null`);

      // The workspace is the window now — no modal to open with ⌘\ or close with
      // Escape, and the rail is always drawn. Check that it draws a set of view
      // tabs; the exact count is the user's rail to arrange.
      const railTabs = await evaluate(`document.querySelectorAll('${railSel} [role="tab"]').length`);
      if (railTabs < 6) failures.push(`[workspace] expected a rail of view tabs, found ${railTabs}`);

      // ⌘1 and ⌘2 reach two DIFFERENT views: the numbers switch, and to
      // different places. Which view each is depends on the rail order — the
      // user's to change — so this pins that navigation WORKS rather than a
      // specific mapping a reorder would rightly leave alone. Poll for the
      // outcome: under load React has not always committed the previous switch
      // when the next key is read.
      const settle = async (pred: (v: string | null) => boolean) => {
        for (let i = 0; i < 40; i++) { const v = await selectedView(); if (pred(v)) return v; await Bun.sleep(50); }
        return await selectedView();
      };
      await press("1", true);
      const v1 = await settle((v) => !!v);
      await press("2", true);
      const v2 = await settle((v) => !!v && v !== v1);
      if (!v1 || !v2 || v1 === v2) failures.push(`[workspace] ⌘1/⌘2 must switch between two views — ⌘1=${v1}, ⌘2=${v2}`);

      // Bare letters navigate only from the dashboard. Inside a workspace view a
      // body-focused letter must stay a letter: focus falls back to <body>
      // constantly, and a letter that navigated was the terminal-jump bug ("g"
      // in a shell → git). We are on `v2`, a non-dash view that is not git, so
      // press git's `g` with focus on the body — the selection must not move.
      if (v2 && v2 !== "dash" && v2 !== "git") {
        await evaluate(`document.activeElement?.blur?.(); document.body.focus?.(); true`);
        await press("g");
        await Bun.sleep(400);
        const afterBare = await selectedView();
        if (afterBare !== v2) failures.push(`[workspace] a bare letter must not navigate inside a workspace view — moved from ${v2} to ${afterBare}`);
      }

      if (!failures.length) console.log(`✓ smoke: the rail draws ${railTabs} views, ⌘-numbers switch them, bare letters stay put`);

      // Chats have to outlive the page, which is a property no unit test can
      // reach: the store restores at module load, from real storage, in a real
      // document. So drive it the way the accident does, by opening tabs, typing
      // into one and then actually reloading, rather than hand-writing storage,
      // which the running app would rightly overwrite on its way out.
      //
      // This is the crash and the project switch both: that switch deliberately
      // calls location.reload() to rescope every view, and it used to take every
      // open conversation with it.
      if (!(await evaluate(`!!document.querySelector('${railSel}')`))) await press("\\", true);
      await press("c");

      const listSel = '[role="listbox"][aria-label="open chats"]';
      const rows = () => evaluate(`document.querySelectorAll('${listSel} [role="option"]').length`);

      // A chat needs a repo to sit in, and that comes from the server. With no
      // server behind the bundle there is nothing to persist and nothing to check.
      let haveChat = false;
      for (let i = 0; i < 30 && !haveChat; i++) {
        haveChat = (await rows()) > 0;
        if (!haveChat) await Bun.sleep(100);
      }

      if (!haveChat) {
        console.log("• smoke: chat persistence not checked, no server behind the bundle so no chat exists to persist");
      } else {
        // A second tab, so the check cannot be satisfied by the panel simply
        // seeding one fresh blank chat the way it does on a cold start.
        await evaluate(`(() => {
          [...document.querySelectorAll("button")].find((b) => b.textContent.includes("+ new"))?.click();
          return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        })()`);
        await Bun.sleep(300);
        const before = await rows();

        // The draft is the part that exists nowhere else. Claude's own transcript
        // has the conversation, but never what you had not sent yet.
        const DRAFT = "a half typed thing";
        await evaluate(`(() => {
          const ta = document.querySelector('textarea[aria-label="chat composer"]');
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(DRAFT)});
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        })()`);
        // Past the store's debounced write, so the reload is not racing it.
        await Bun.sleep(900);

        await cdp.send("Page.navigate", { url }, sessionId);
        // Same wait as the first mount: the reload throws the whole tree away.
        const reDeadline = Date.now() + MOUNT_TIMEOUT_MS;
        let remounted = false;
        while (Date.now() < reDeadline && !remounted) {
          remounted = (await evaluate(`!!document.querySelector("#root") && document.querySelector("#root").childElementCount > 0`)) === true;
          if (!remounted) await Bun.sleep(250);
        }

        if (!remounted) failures.push("[chat-persist] the app never came back after the reload");
        else {
          await Bun.sleep(SETTLE_MS);
          // The workspace remembers whether it was open, so toggling blind would
          // close it half the time. Ask first.
          // A freshly reloaded page can take a moment to attach the window
          // keydown handler, so the first ⌘\\ may land on nothing. Keep asking
          // until the rail is actually up rather than assuming one press took.
          for (let i = 0; i < 30; i++) {
            if (await evaluate(`!!document.querySelector('${railSel}')`)) break;
            await press("\\", true);
            await Bun.sleep(200);
          }
          for (let i = 0; i < 30; i++) {
            if (await evaluate(`!!document.querySelector('${listSel}')`)) break;
            await press("c");
            await Bun.sleep(200);
          }
          await Bun.sleep(500);

          const after = await rows();
          if (after !== before)
            failures.push(`[chat-persist] ${before} tab(s) were open, ${after} came back`);

          const draft = await evaluate(`document.querySelector('textarea[aria-label="chat composer"]')?.value ?? ""`);
          if (draft !== DRAFT)
            failures.push(`[chat-persist] the draft did not come back, found: ${JSON.stringify(draft)}`);

          if (!failures.length) console.log(`✓ smoke: ${after} chats and the composer draft survive a reload`);
        }
      }
    }

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
