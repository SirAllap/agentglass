/*
 * The page ticket through a real server with a token.
 *
 * `/preview/pagelink` (with the token) answers an address that holds a ticket
 * and not the token; that address opens its one file with no token; the same
 * ticket on another path, a path swapped for a link, a rewritten file, or no
 * ticket, is still 401; a dot-folder under home is held back even from a
 * ticket the desk made.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_ISOLATED } from "./tmuxIsolated.ts";
import { freePort } from "./freePort.ts";

const TOKEN = "fake-machine-token-for-the-page-test";
const SOCKET = `agx-pageticket-${process.pid}`;
let dir: string, base: string, page: string, other: string, docs: string, secret: string, cfg: string;
let proc: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-pageticket-live-"));
  const home = join(dir, "home");
  docs = join(home, "docs");
  mkdirSync(docs, { recursive: true });
  // Not a dot-folder, so only the read's own local=false keeps it shut to a ticket.
  cfg = join(home, "cfg");
  mkdirSync(join(home, ".secret"));
  secret = join(home, ".secret", "key.html");
  writeFileSync(secret, "<!doctype html><p>private key</p>");
  page = join(docs, "mockup.html");
  other = join(docs, "other.html");
  writeFileSync(page, "<!doctype html><p>mockup</p>");
  writeFileSync(other, "<!doctype html><p>other</p>");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "", LANG: process.env.LANG || "C.UTF-8", HOME: home,
      TMPDIR: process.env.TMPDIR ?? tmpdir(), TMUX_TMPDIR: TMUX_TEST_TMPDIR, XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "agents.db"), AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port), AGENTGLASS_TMUX_SOCKET: SOCKET, AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_DISK_ROOTS: docs,
    },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(async () => {
  await Bun.spawn(["tmux", "-L", SOCKET, ...TMUX_ISOLATED, "kill-server"], { env: { ...process.env, TMUX_TMPDIR: TMUX_TEST_TMPDIR }, stdout: "ignore", stderr: "ignore" }).exited;
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };
async function linkFor(path: string, scripts = false): Promise<string> {
  const r = await fetch(`${base}/preview/pagelink?path=${encodeURIComponent(path)}${scripts ? "&scripts=1" : ""}`, { headers: auth });
  expect(r.status).toBe(200);
  return ((await r.json()) as { path: string }).path;
}
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;

test("the link opens its one file without the token, scripts off, and nothing else", async () => {
  const path = await linkFor(page);
  expect(path).toContain("ticket=");
  expect(path.includes(TOKEN)).toBe(false);

  const opened = await fetch(base + path);
  expect(opened.status).toBe(200);
  const csp = opened.headers.get("content-security-policy") ?? "";
  expect(csp).toMatch(/^sandbox;/);
  expect(csp.includes("allow-scripts")).toBe(false);
  expect(await opened.text()).toContain("mockup");

  const ticket = new URL(base + path).searchParams.get("ticket")!;
  const swapped = await fetch(`${base}/preview/page?path=${encodeURIComponent(other)}&ticket=${ticket}`);
  expect(swapped.status).toBe(401);
  expect((await fetch(`${base}/preview/page?path=${encodeURIComponent(page)}`)).status).toBe(401);
  // The ticket is for the page route only.
  expect((await fetch(`${base}/preview/raw?path=${encodeURIComponent(page)}&ticket=${ticket}`)).status).toBe(401);
  // Scripts are signed in: adding the switch to a no-scripts ticket is refused.
  expect((await fetch(`${base + path}&scripts=1`)).status).toBe(401);
});

test("scripts run only on the link that asked for them", async () => {
  const opened = await fetch(base + await linkFor(page, true));
  expect(opened.status).toBe(200);
  const csp = opened.headers.get("content-security-policy") ?? "";
  expect(csp).toMatch(/^sandbox allow-scripts;/);
  expect(csp.includes("allow-same-origin")).toBe(false);
});

test("a path swapped for a link to a held-back file after the ticket was made is refused", async () => {
  const swap = join(docs, "swap.html");
  writeFileSync(swap, "<!doctype html><p>harmless</p>");
  const path = await linkFor(swap);
  rmSync(swap);
  symlinkSync(secret, swap);
  const r = await fetch(base + path);
  expect(r.status).toBe(401);
  const error = await errorOf(r);
  expect(error).toMatch(/no longer fits/);
  expect(error.includes("private key")).toBe(false);
});

test("a file rewritten after the ticket was made is refused", async () => {
  const changing = join(docs, "changing.html");
  writeFileSync(changing, "<!doctype html><p>first</p>");
  const path = await linkFor(changing);
  writeFileSync(changing, "<!doctype html><p>second, and longer</p>");
  const r = await fetch(base + path);
  expect(r.status).toBe(401);
  expect(await errorOf(r)).toMatch(/changed/);
});

test("a dot-folder under home is held back even from a ticket the desk made", async () => {
  const r = await fetch(base + await linkFor(secret));
  expect(r.status).toBe(403);
  expect(await r.text()).not.toContain("private key");
});

test("a ticket reads as a narrow caller: the agentglass config folder the desk may open is shut to it", async () => {
  const theme = join(cfg, "agentglass", "theme.json");
  mkdirSync(join(cfg, "agentglass"), { recursive: true });
  writeFileSync(theme, "{\"mode\":\"dark\"}");
  const r = await fetch(base + await linkFor(theme));
  expect(r.status).toBe(404);
  expect(await errorOf(r)).toMatch(/agentglass's keys/);
});

test("a missing file is a 404 sentence, and a picture keeps the preview policy", async () => {
  const missing = await fetch(`${base}/preview/page?path=${encodeURIComponent(join(docs, "gone.html"))}`, { headers: auth });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toContain("application/json");
  expect(await errorOf(missing)).toMatch(/ /);
  expect((await fetch(`${base}/preview/pagelink?path=${encodeURIComponent(join(docs, "gone.html"))}`, { headers: auth })).status).toBe(404);

  const png = join(docs, "dot.png");
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const pic = await fetch(base + await linkFor(png));
  expect(pic.status).toBe(200);
  expect(pic.headers.get("content-type")).toContain("image/png");
  const csp = pic.headers.get("content-security-policy") ?? "";
  expect(csp.includes("sandbox")).toBe(false);
  expect(csp).toContain("default-src 'none'");
});
