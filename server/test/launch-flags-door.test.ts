/**
 * Who may loosen what an engine starts with. `launch.flags.*` is an escalation
 * and has no `narrows`, so a change from an agent is a request the person
 * answers, never a write; and through a booted server an agent's
 * `POST /launch-flags` comes back 202 and leaves the stored flags alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { agentVerdict, classOf } from "../../shared/settingClass.ts";

describe("the class of launch.flags.*", () => {
  const id = "launch.flags.codex";
  test("is an escalation with no narrowing rule", () => {
    expect(classOf(id)?.class).toBe("escalation");
    expect(classOf(id)?.narrows).toBeUndefined();
  });
  test("an agent's change is asked about, whatever the direction", () => {
    expect(agentVerdict(id, {}, { bypassPermissions: "--dangerously-bypass-approvals-and-sandbox" }, false)).toBe("ask");
    expect(agentVerdict(id, { auto: "--approve-for-me" }, {}, false)).toBe("ask");
    expect(agentVerdict(id, { auto: "--a --b" }, { auto: "--a" }, false)).toBe("ask");
  });
});

const TOKEN = "tok-launch-flags-example";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-flags-door-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
      AGENTGLASS_STATE_DIR: `${dir}/state`, AGENTGLASS_ROOT: dir, AGENTGLASS_DB: join(dir, "o.db"),
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* booting */ }
    await Bun.sleep(100);
  }
  throw new Error("server did not start");
}, SERVER_BOOT_MS);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /launch-flags", () => {
  const post = (headers: Record<string, string>, kind = "codex") =>
    fetch(base + "/launch-flags", { method: "POST", headers, body: JSON.stringify({ kind, modes: { default: "--dangerously-bypass-approvals-and-sandbox" } }) });
  const stored = async () => ((await (await fetch(base + "/launch-flags", { headers: auth })).json()) as { overrides: Record<string, unknown> }).overrides;

  test("an agent's loosening waits for the person and writes nothing", async () => {
    const r = await post({ ...auth, "x-agentglass-agent": "orbit-worker" });
    expect(r.status).toBe(202);
    expect(await stored()).toEqual({});
  });
  test("the token with no agent header is also not the person", async () => {
    expect((await post(auth)).status).toBe(202);
    expect(await stored()).toEqual({});
  });
  test("Claude is refused", async () => {
    expect((await post({ ...auth, "x-agentglass-agent": "orbit-worker" }, "claude")).status).not.toBe(200);
    expect(await stored()).toEqual({});
  });
});
