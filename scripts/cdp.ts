/**
 * The Chrome DevTools Protocol plumbing the capture scripts share.
 *
 * Driven over CDP rather than a browser-automation library because
 * `Page.captureScreenshot` returns exactly what compositing produced, and
 * every step can wait on a real condition instead of a guessed sleep.
 *
 * This lived twice — once in capture.ts and once in capture-live.ts, with the
 * two copies already drifting in their retry counts — and a third capture
 * script would have made it three. One copy now.
 */
import { jsLit } from "../shared/jsLit.ts";

export type CDP = {
  send: (m: string, p?: unknown) => Promise<any>;
  ev: (expr: string) => Promise<any>;
  shot: () => Promise<Buffer>;
  close: () => void;
};

const CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/usr/bin/google-chrome"];

export function findChrome(): string {
  const pinned = process.env.CHROME_PATH?.trim();
  if (pinned) return pinned;
  for (const c of CHROME) {
    const r = Bun.spawnSync(["which", c]);
    if (r.exitCode === 0) return r.stdout.toString().trim();
  }
  throw new Error("no Chrome found — set CHROME_PATH");
}

export async function connect(port: number, tries = 80): Promise<CDP> {
  let targets: any[] = [];
  for (let i = 0; i < tries; i++) {
    // Cast, because `.json()` is `unknown` and this file is typechecked now:
    // the CDP target list has no schema we control, and the shape we need is
    // asserted a line later by the `find` below.
    try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]; if (targets.length) break; }
    catch { /* not up yet */ }
    await Bun.sleep(250);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map<number, (v: any) => void>();
  await new Promise((r) => ws.addEventListener("open", r as any));
  ws.addEventListener("message", (e: any) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); }
  });
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Runtime.enable");
  const ev = async (expr: string) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
  const shot = async () =>
    Buffer.from((await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data, "base64");
  return { send, ev, shot, close: () => ws.close() };
}

/** Wait for a condition rather than a guessed delay — a fixed sleep either
 *  wastes seconds or captures a half-painted frame, and which one depends on
 *  the machine. */
export async function until(cdp: CDP, expr: string, what: string, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cdp.ev(`!!(${expr})`)) return;
    await Bun.sleep(120);
  }
  throw new Error(`timed out waiting for ${what}`);
}


export const key = (cdp: CDP, k: string, mods: Record<string, boolean> = {}) =>
  cdp.ev(`(()=>{window.dispatchEvent(new KeyboardEvent("keydown",Object.assign({key:${jsLit(k)},bubbles:true,cancelable:true},${jsLit(mods)})));return 1})()`);

/** Click the first element matching a predicate over its trimmed text.
 *  Returns false rather than throwing, so a caller can report which step of a
 *  capture went missing instead of dying with a selector error. */
export const clickByText = (cdp: CDP, selector: string, needle: string) =>
  cdp.ev(`(()=>{const el=[...document.querySelectorAll(${jsLit(selector)})]
    .find(e=>e.textContent.includes(${jsLit(needle)}));el?.click();return !!el})()`);

/** The demo build is based at /agentglass/demo/ so it can be served from
 *  GitHub Pages, so its asset URLs carry that prefix. Serving it at the root
 *  gives a page whose scripts all 404 and a #root that never fills. */
export const DEMO_BASE = "/agentglass/demo";

export function serveDist(dist: string, base = DEMO_BASE) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path.startsWith(base)) path = path.slice(base.length) || "/";
      const file = Bun.file(`${dist}${path === "/" ? "/index.html" : path}`);
      if (await file.exists()) return new Response(file);
      if (!path.split("/").pop()!.includes("."))
        return new Response(Bun.file(`${dist}/index.html`), { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
}
