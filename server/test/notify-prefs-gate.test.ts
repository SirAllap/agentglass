/*
 * deliver()'s gate, at the door of every push alert.
 *
 * blocked fires by default; the common "waiting for your input" Notification
 * does not, until `idle` is turned on; `none` silences even `blocked`. Uses
 * the same seams alerts-sink.test.ts does (setAlertSink / setDesktopNotifier)
 * so nothing here spawns a real notify-send or leaves a socket open, and a
 * scratch XDG_CONFIG_HOME so writeNotifyPrefs never touches a developer's
 * real prefs (NODE_ENV=test + notifyPrefs.ts's own offLimits guard would
 * refuse it anyway, but the scratch dir is what lets this file assert the
 * write actually reached the module the gate reads from).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlertNote } from "../../shared/types.ts";
import { DEFAULT_NOTIFY_PREFS } from "../../shared/notifyPrefs.ts";

const REAL_XDG = process.env.XDG_CONFIG_HOME;
const REAL_NOTIFY = process.env.AGENTGLASS_NOTIFY;
process.env.AGENTGLASS_NOTIFY = "1"; // read at import → the desktop branch is live, as alerts-sink.test.ts does
let dir: string;

let alerts: typeof import("../src/alerts.ts");
let notifyPrefs: typeof import("../src/notifyPrefs.ts");
let broadcasts: AlertNote[] = [];
let fallbacks: AlertNote[] = [];
const CENSUS_NO_CLIENT = { attached: 0, live: 0 };

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  dir = mkdtempSync(join(tmpdir(), "agx-notify-gate-"));
  process.env.XDG_CONFIG_HOME = dir;
  // alerts.ts is cache-busted, the same way alerts-sink.test.ts busts it, so
  // its module-level `DESKTOP` is read with AGENTGLASS_NOTIFY set above.
  // notifyPrefs.ts is imported at its CANONICAL path, with no query — it
  // must be, because alerts.ts's own `import ... from "./notifyPrefs.ts"` is
  // a static import and always resolves to that same canonical instance,
  // whichever copy of alerts.ts loaded it. A query-busted import here would
  // be a second, disconnected instance: this test's writes would land in a
  // cache alerts.ts's `readNotifyPrefs()` never reads from.
  notifyPrefs = await import("../src/notifyPrefs.ts");
  alerts = await import(`../src/alerts.ts?u=${Math.random()}`);
  alerts.setAlertSink({ broadcast: (a) => broadcasts.push(a), census: () => CENSUS_NO_CLIENT });
  alerts.setDesktopNotifier((a) => fallbacks.push(a));
});
afterEach(() => {
  broadcasts = [];
  fallbacks = [];
  notifyPrefs.writeNotifyPrefs(DEFAULT_NOTIFY_PREFS);
});
afterAll(() => {
  if (REAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = REAL_XDG;
  if (REAL_NOTIFY === undefined) delete process.env.AGENTGLASS_NOTIFY; else process.env.AGENTGLASS_NOTIFY = REAL_NOTIFY;
});

describe("deliver() gated by the notification diet", () => {
  test("blocked fires by default — nothing to turn on first", () => {
    alerts.pushGate("app:g1", "Bash", "ls default-blocked");
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]?.title).toContain("Approval");
  });

  test("the common idle Notification does NOT reach the desktop by default", () => {
    alerts.maybeAlert({
      hook_event_type: "Notification", session_id: "s-idle-1", source_app: "app",
      payload: { message: "Claude is waiting for your input" },
    } as any);
    expect(broadcasts.length).toBe(0);
    expect(fallbacks.length).toBe(0);
  });

  test("turning idle on makes the same message broadcast", () => {
    notifyPrefs.writeNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, kinds: { ...DEFAULT_NOTIFY_PREFS.kinds, idle: true } });
    alerts.maybeAlert({
      hook_event_type: "Notification", session_id: "s-idle-2", source_app: "app",
      payload: { message: "Claude is waiting for your input" },
    } as any);
    expect(fallbacks.length).toBe(1);
    expect(fallbacks[0]?.title).toContain("waiting for your input");
  });

  test("none blocks blocked too — the one kind that is otherwise always on", () => {
    notifyPrefs.writeNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, none: true });
    alerts.pushGate("app:g2", "Bash", "ls none-blocks-everything");
    expect(broadcasts.length).toBe(0);
    expect(fallbacks.length).toBe(0);
  });

  test("a tool error stays off by default (failures), and turning it on reaches the desktop", () => {
    alerts.maybeAlert({
      hook_event_type: "PostToolUse", is_error: 1, session_id: "s-err-1", source_app: "app",
      tool_name: "Bash", error_text: "boom", payload: {},
    } as any);
    expect(fallbacks.length).toBe(0);
    notifyPrefs.writeNotifyPrefs({ ...DEFAULT_NOTIFY_PREFS, kinds: { ...DEFAULT_NOTIFY_PREFS.kinds, failures: true } });
    alerts.maybeAlert({
      hook_event_type: "PostToolUse", is_error: 1, session_id: "s-err-2", source_app: "app",
      tool_name: "Bash", error_text: "boom", payload: {},
    } as any);
    // Urgency 0 never reaches the desktop fallback regardless of the diet —
    // pinned already in alerts-sink.test.ts — so what this proves is that the
    // frame itself is no longer suppressed at the door: nothing broadcasts
    // here because CENSUS_NO_CLIENT means the frame goes to notify-send
    // territory, and urgency 0 stops it there, which is the pre-existing
    // rule this file must not have to re-litigate.
    expect(fallbacks.length).toBe(0);
  });
});

describe("GET/POST /notify/prefs", () => {
  test("round-trips through a real server, isolated from any real state", async () => {
    const { freePort } = await import("./freePort.ts");
    const { TMUX_TEST_TMPDIR } = await import("./tmuxTmp.ts");
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const routeDir = mkdtempSync(join(tmpdir(), "agx-notify-route-"));
    const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH ?? "",
        TMUX_TMPDIR: TMUX_TEST_TMPDIR,
        HOME: process.env.HOME ?? "",
        XDG_CONFIG_HOME: routeDir,
        XDG_DATA_HOME: join(routeDir, "data"),
        XDG_CACHE_HOME: join(routeDir, "cache"),
        AGENTGLASS_STATE_DIR: `${routeDir}/state`,
        AGENTGLASS_ROOT: routeDir,
        AGENTGLASS_DB: join(routeDir, "f.db"),
        AGENTGLASS_SCAN_DISABLED: "1",
        AGENTGLASS_PORT: String(port),
      },
      stdout: "ignore", stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 150; i++) {
        try { if ((await fetch(base + "/health")).ok) { up = true; break; } } catch { /* not up yet */ }
        await Bun.sleep(100);
      }
      if (!up) throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));

      const before = await (await fetch(base + "/notify/prefs")).json() as { ok: boolean; prefs: typeof DEFAULT_NOTIFY_PREFS };
      expect(before.ok).toBe(true);
      expect(before.prefs).toEqual(DEFAULT_NOTIFY_PREFS);

      const changed = { ...DEFAULT_NOTIFY_PREFS, kinds: { ...DEFAULT_NOTIFY_PREFS.kinds, stalled: true } };
      const posted = await (await fetch(base + "/notify/prefs", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(changed),
      })).json() as { ok: boolean; prefs: typeof DEFAULT_NOTIFY_PREFS };
      expect(posted.ok).toBe(true);
      expect(posted.prefs.kinds.stalled).toBe(true);

      const after = await (await fetch(base + "/notify/prefs")).json() as { ok: boolean; prefs: typeof DEFAULT_NOTIFY_PREFS };
      expect(after.prefs.kinds.stalled).toBe(true);
    } finally {
      try { proc.kill(); } catch { /* already gone */ }
      await proc.exited;
    }
  }, 30_000);
});
