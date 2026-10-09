/*
 * The working-tree read answers "nothing changed" with a 304.
 *
 * The Git view polls /git/tree every 2.5 s, and the doorbell does not ring for
 * an edit made on disk, so the poll cannot be slowed. Measured on an isolated
 * server: 24 requests a minute, every body identical except the `timestamp:
 * now` stamped on each file, which made a hash or ETag of the bytes useless.
 * The signature now leaves the stamp out, and an unchanged tree is a 304.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { freePort } from "./freePort.ts";

let dir = "", repo = "", base = "";
let proc: ReturnType<typeof Bun.spawn> | null = null;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
const tree = (headers: Record<string, string> = {}) =>
  fetch(`${base}/git/tree?root=${encodeURIComponent(repo)}`, { headers });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-tree-etag-"));
  repo = join(dir, "orbit");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main", "orbit");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "src", "app.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, "src", "app.ts"), "export const a = 2;\n");

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      LANG: process.env.LANG || "C.UTF-8",
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_CACHE_HOME: join(dir, "cache"),
      TMUX_TMPDIR: join(dir, "tmux"),
      AGENTGLASS_STATE_DIR: join(dir, "state"),
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "agents.db"),
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
      AGENTGLASS_TMUX_SOCKET: `agx-tree-etag-${process.pid}`,
    },
    stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(base + "/health")).ok; } catch { /* not up yet */ }
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("the server never answered /health");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("two reads of an unchanged tree carry one signature, and the second can be a 304", async () => {
  const a = await tree();
  const bodyA = await a.json() as { sig?: string; unstaged: { timestamp: number }[] };
  const tag = a.headers.get("etag");
  expect(bodyA.unstaged.length).toBe(1);
  expect(tag).toBe(`"${bodyA.sig}"`);
  // Past the server's 1 s copy, so this is a fresh read with a fresh stamp.
  await Bun.sleep(1300);
  const b = await tree({ "If-None-Match": tag! });
  expect(b.status).toBe(304);
});

test("the stamp is the only thing that differs between two fresh reads", async () => {
  const a = await (await tree()).json() as { sig: string };
  await Bun.sleep(1300);
  const b = await (await tree()).json() as { sig: string };
  expect(b.sig).toBe(a.sig);
});

test("an edit on disk changes the signature, so the poll still sees it", async () => {
  const before = (await (await tree()).json() as { sig: string }).sig;
  writeFileSync(join(repo, "src", "app.ts"), "export const a = 3;\n");
  await Bun.sleep(1300);
  const res = await tree({ "If-None-Match": `"${before}"` });
  expect(res.status).toBe(200);
  const after = await res.json() as { sig: string };
  expect(after.sig).not.toBe(before);
});
