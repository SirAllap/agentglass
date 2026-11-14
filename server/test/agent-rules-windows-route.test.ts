import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const dir = mkdtempSync(join(tmpdir(), "agx-rule-paths-"));
let proc: ReturnType<typeof Bun.spawn> | undefined;
let base = "";
let errors: Promise<string>;
beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir,
      XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_DB: join(dir, "test.db"), TMUX_TMPDIR: join(dir, "tmux"),
      AGENTGLASS_ROOT: dir, AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: "rule-path-test",
    }, stdout: "ignore", stderr: "pipe",
  });
  proc = child;
  errors = new Response(child.stderr).text();
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(await errors);
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error("isolated rules server did not start");
}, SERVER_BOOT_MS);
afterAll(async () => {
  proc?.kill();
  if (proc) await proc.exited;
  rmSync(dir, { recursive: true, force: true });
});

test("rules GET accepts both drive slash styles and rejects relative/traversal roots", async () => {
  for (const root of ["*", "D:/code/orbit", "D:\\code\\orbit"]) {
    const r = await fetch(`${base}/agent-rules?${new URLSearchParams({ root })}`, { headers: { Authorization: "Bearer rule-path-test" } });
    expect(r.status, await r.text()).toBe(200);
  }
  for (const root of ["orbit", "D:orbit", "D:/code/../orbit", "D:\\code\\..\\orbit", "/work/../orbit"]) {
    const r = await fetch(`${base}/agent-rules?${new URLSearchParams({ root })}`, { headers: { Authorization: "Bearer rule-path-test" } });
    expect(r.status, root).toBe(400);
  }
});