/*
 * Gate rules through the real route — #109.
 *
 * gate-rules.test.ts pins what a rule decides. This pins that the route acts on
 * it, which a unit test of the verdict passes just as happily without: an
 * allowed call answers at once instead of queueing, a denied one answers at
 * once AND is written to history, an outward action is never let through by an
 * allow list, and a project rule follows the directory the hook reports.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const TOKEN = "machine-token-for-this-test";
let dir: string, base: string, proc: ReturnType<typeof Bun.spawn> | null = null;
// Nothing on disk, so inScope answers from the prefix test alone.
const ORBIT = "/nonexistent/code/orbit";
// Somewhere the machine-wide rule covers and no project rule does. A call with
// no directory at all is not placed, and an unplaced call is never allowed.
const OTHER = "/nonexistent/code/other";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agx-gaterules-route-"));
  mkdirSync(join(dir, "agentglass"), { recursive: true });
  writeFileSync(join(dir, "agentglass", "config.json"), JSON.stringify({
    gateRules: [
      { allow: ["Read", "mcp__memory__create_entities", "mcp__notes__*"], deny: ["WebFetch"] },
      { root: ORBIT, allow: ["Bash", "Read"] },
    ],
  }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH ?? "",
      TMUX_TMPDIR: TMUX_TEST_TMPDIR,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      XDG_DATA_HOME: `${dir}/data`,
      XDG_CACHE_HOME: `${dir}/cache`,
      AGENTGLASS_STATE_DIR: `${dir}/state`,
      AGENTGLASS_ROOT: dir,
      AGENTGLASS_DB: join(dir, "gate.db"),
      AGENTGLASS_TOKEN: TOKEN,
      AGENTGLASS_SCAN_DISABLED: "1",
      AGENTGLASS_PORT: String(port),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}, SERVER_BOOT_MS);

afterAll(() => {
  try { proc?.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ }
});

type Json = Record<string, any>;
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let seq = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** POST the way the hook does, and give up quickly: a call a rule decides
 *  answers at once, and one that is held never answers inside this window. */
async function ask(id: string, tool: string, input: Json, cwd?: string): Promise<Json | "held"> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch(base + "/gate", {
      method: "POST", headers, signal: ctl.signal,
      body: JSON.stringify({ id, source_app: "orbit", session_id: "s-rules", tool_name: tool, tool_input: input, timeout_ms: 30_000, cwd }),
    });
    return (await r.json()) as Json;
  } catch {
    return "held";
  } finally {
    clearTimeout(t);
  }
}
const pending = async () => ((await fetch(base + "/gate/pending", { headers }).then((r) => r.json())) as Json).gates as Json[];
const history = async () => ((await fetch(base + "/gate/history?limit=50", { headers }).then((r) => r.json())) as Json).gates as Json[];

describe("the route acts on a rule", () => {
  test("an allowed tool answers at once, queues nothing, and is written down with an empty reason", async () => {
    const id = nextId();
    // An empty reason on purpose: the hook reads it as "agentglass has no
    // opinion" and Claude Code's own permission prompt still runs. An allow
    // list means "do not hold this", never "skip every other check".
    expect(await ask(id, "Read", { file_path: "/tmp/x" }, OTHER)).toEqual({ decision: "allow", reason: "" });
    expect((await pending()).some((g) => g.id === id)).toBe(false);
    const row = (await history()).find((g) => g.id === id);
    expect(row).not.toBeUndefined();
    expect(row!.resolution).toBe("rule");
    expect(row!.decision).toBe("allow");
    expect(row!.decided_by).toBeNull();
  });

  test("a retry of an id a rule allowed replays the allow with the empty reason, and no second row", async () => {
    // A reason on an allow is what makes the hook skip Claude Code's own
    // permission prompt; the replay reads the stored row, so the row must not
    // carry one either.
    const id = nextId();
    await ask(id, "Read", { file_path: "/tmp/x" }, OTHER);
    expect(await ask(id, "Read", { file_path: "/tmp/x" }, OTHER)).toEqual({ decision: "allow", reason: "" });
    expect((await history()).filter((g) => g.id === id).length).toBe(1);
  });

  test("the unattended history leaves a rule's allows out, and keeps its denials", async () => {
    const allowed = nextId(), denied = nextId();
    await ask(allowed, "Read", { file_path: "/tmp/x" }, OTHER);
    await ask(denied, "WebFetch", { url: "https://example.com" }, OTHER);
    const r = (await fetch(base + "/gate/history?limit=50&rule_allows=0", { headers }).then((x) => x.json())) as Json;
    const ids = (r.gates as Json[]).map((g) => g.id);
    expect(ids).toContain(denied);
    expect(ids).not.toContain(allowed);
  });

  test("a call nobody could place is never allowed: the machine's allow list holds it instead", async () => {
    const id = nextId();
    expect(await ask(id, "Read", { file_path: "/tmp/x" })).toBe("held");
    expect((await pending()).some((g) => g.id === id)).toBe(true);
  });

  test("but the machine's deny list still binds a call nobody could place", async () => {
    const out = await ask(nextId(), "WebFetch", { url: "https://example.com" });
    expect(out).not.toBe("held");
    expect((out as Json).decision).toBe("deny");
  });

  test("a denied tool answers at once and is written down as the rule's decision", async () => {
    const id = nextId();
    const out = await ask(id, "WebFetch", { url: "https://example.com" });
    expect(out).not.toBe("held");
    expect((out as Json).decision).toBe("deny");
    const row = (await history()).find((g) => g.id === id);
    expect(row).toBeDefined();
    // Nobody decided this, so nobody is recorded as having done so.
    expect(row!.resolution).toBe("rule");
    expect(row!.decided_by).toBeNull();
    expect(row!.tool_name).toBe("WebFetch");
  });

  test("a retry of an id already held is answered from the hold, not from the rules", async () => {
    // The hook re-POSTs an id after a dropped connection. Whatever the rules
    // would say about it now, it is the request a person is already looking
    // at, and it must not be replaced by a denial underneath them.
    const id = nextId();
    expect(await ask(id, "Edit", { file_path: "/tmp/x" })).toBe("held");
    expect(await ask(id, "WebFetch", { url: "https://example.com" })).toBe("held");
    expect((await pending()).some((g) => g.id === id)).toBe(true);
    expect((await history()).some((g) => g.id === id)).toBe(false);
  });

  test("a retry of an id already denied gets the same answer and no second row", async () => {
    const id = nextId();
    const first = await ask(id, "WebFetch", { url: "https://example.com" });
    const again = await ask(id, "WebFetch", { url: "https://example.com" });
    expect(again).toEqual(first);
    expect((await history()).filter((g) => g.id === id).length).toBe(1);
  });

  test("a tool on neither list is still held for a person", async () => {
    const id = nextId();
    expect(await ask(id, "Edit", { file_path: "/tmp/x" })).toBe("held");
    expect((await pending()).some((g) => g.id === id)).toBe(true);
  });
});

describe("a project rule follows the directory the hook reports", () => {
  test("inside the project its allow list applies", async () => {
    expect(await ask(nextId(), "Bash", { command: "ls" }, `${ORBIT}/web`)).toEqual({ decision: "allow", reason: "" });
  });

  test("outside it the machine's rule applies and the same call is held", async () => {
    const id = nextId();
    expect(await ask(id, "Bash", { command: "ls" }, "/nonexistent/code/other")).toBe("held");
    expect((await pending()).some((g) => g.id === id)).toBe(true);
  });

  test("an outward action is held even when its tool is on the allow list", async () => {
    // A push has left the machine the moment it runs. The allow list is about
    // what a person does not need to see; an outward action is by definition
    // something they do.
    const id = nextId();
    expect(await ask(id, "Bash", { command: "git push origin main" }, `${ORBIT}/web`)).toBe("held");
    expect((await pending()).some((g) => g.id === id)).toBe(true);
  });

  test("a relative cwd is not trusted as a place", async () => {
    // Only an absolute path names a directory; anything else falls back to
    // what the pane knows, which here is nothing — so the project rule does not
    // apply and the machine's rule holds the call.
    const id = nextId();
    expect(await ask(id, "Bash", { command: "ls" }, "code/orbit")).toBe("held");
  });
});

describe("a local tool whose name reads as outward", () => {
  test("is released by an allow rule that names it exactly", async () => {
    // `create` is the verb of a memory store as well as of a pull request.
    // Naming the one tool is a person saying which this is.
    expect(await ask(nextId(), "mcp__memory__create_entities", { entities: [] }, OTHER)).toEqual({ decision: "allow", reason: "" });
  });

  test("but not by a prefix, which never saw the tool it would be releasing", async () => {
    const id = nextId();
    expect(await ask(id, "mcp__notes__delete_note", { id: "n-1" }, OTHER)).toBe("held");
    expect((await pending()).some((g) => g.id === id)).toBe(true);
  });
});
