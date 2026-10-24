// /machine/disk-clean on a booted server whose PATH holds only the fake docker,
// git, gh, df and du, and whose home is a scratch directory. The server is the
// real one; nothing it can reach is.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiskCleanReport, DiskCleanRunResult } from "../../shared/types.ts";
import { GB, makeFixture, populateHome, type Fixture } from "./diskcleanFixture.ts";
import { freePort } from "./freePort.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";

const TOKEN = "orbit-diskclean-token-0123456789abcdef", AUTH = { authorization: `Bearer ${TOKEN}` };
const DESK = "x-agentglass-desk", KEY = "k".repeat(48);
let fx: Fixture;
let sessions: Record<string, string> = {};
interface Booted { base: string; proc: ReturnType<typeof Bun.spawn>; claim: AbortController | null }
let desk: Booted, bare: Booted;

/** A real server on the fakes. `claim`: the desktop app has adopted it and holds its desk. */
async function boot(claim: boolean): Promise<Booted> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
    env: {
      ...fx.env,
      PATH: [fx.shim, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
      TMUX_TMPDIR: TMUX_TEST_TMPDIR, CLAUDE_CONFIG_DIR: join(fx.dir, ".claude"), AGENTGLASS_ROOT: fx.dir,
      AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port), AGENTGLASS_TOKEN: TOKEN,
      // a state dir and database of its own, so two servers do not share one
      AGENTGLASS_STATE_DIR: join(fx.dir, claim ? "state-desk" : "state-bare"), AGENTGLASS_DB: join(fx.dir, claim ? "desk.db" : "bare.db"),
    },
    stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) {
        if (!claim) return { base, proc, claim: null };
        const ctl = new AbortController();
        const res = await fetch(base + "/desk/claim", { method: "POST", headers: { ...AUTH, [DESK]: KEY }, signal: ctl.signal });
        if (res.status !== 200) throw new Error("the desk claim was refused: " + res.status);
        return { base, proc, claim: ctl };
      }
    } catch (e) { if (String(e).includes("desk claim")) throw e; /* not up yet */ }
    await Bun.sleep(100);
  }
  throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
}

beforeAll(async () => {
  fx = makeFixture();
  sessions = populateHome(fx).sessions;
  desk = await boot(true);
  bare = await boot(false);
}, SERVER_BOOT_MS * 2);
afterAll(() => {
  for (const b of [desk, bare]) { try { b?.claim?.abort(); } catch { /* gone */ } try { b?.proc.kill(); } catch { /* already gone */ } }
  rmSync(fx.dir, { recursive: true, force: true });
});
// The tests share one booted server and one call log: each starts from a clean log and the disks as the fixture left them.
beforeEach(() => {
  writeFileSync(fx.log, "");
  fx.put("df-home", String(5.1 * GB));
  fx.put("df-vault", String(215 * GB));
});

const calls = () => readFileSync(fx.log, "utf8").split("\n").filter(Boolean);
/** The desktop app's own request: its origin and the desk key it holds. */
const person = (b: Booted = desk): Record<string, string> => ({ origin: b.base, [DESK]: KEY });
const post = (body: unknown, headers: Record<string, string> = person(), b: Booted = desk) =>
  fetch(b.base + "/machine/disk-clean/run", { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("GET /machine/disk-clean", () => {
  test("answers from the fakes: lines with verdicts, the mounts with their free space, and no Docker volume command", async () => {
    expect(Bun.which("docker")).not.toBeNull();
    const r = await fetch(desk.base + "/machine/disk-clean?fresh=1", { headers: AUTH });
    expect(r.status).toBe(200);
    const rep = (await r.json()) as DiskCleanReport;
    expect(rep.lines.find((l) => l.id === "docker:images")).toMatchObject({ verdict: "safe", mount: "/vault" });
    expect(rep.mounts.map((m) => m.mount).sort()).toEqual(["/home", "/vault"]);
    expect(calls()).toContain("docker system df --format {{json .}}");
    expect(calls().some((l) => /volume|prune/.test(l))).toBe(false);
    // the server read the scratch home and not the real one: every path it can delete lies under it
    const paths = rep.lines.flatMap((l) => (l.target && "path" in l.target ? [l.target.path] : []));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith(fx.home + "/")).toBe(true);
  });
});

describe("POST /machine/disk-clean/run: who may clean", () => {
  test("GUARD: a caller with only the machine token (an agent's shell) is refused before anything is read", async () => {
    const r = await post({ ids: ["docker:images"] }, {});
    expect(r.status).toBe(403);
    expect(calls().some((l) => /prune/.test(l))).toBe(false);
  });

  test("GUARD: a page from another site is blocked as a cross-origin write", async () => {
    const r = await post({ ids: ["docker:images"] }, { origin: "https://evil.example", [DESK]: KEY });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("cross-origin");
    expect(calls().some((l) => /prune/.test(l))).toBe(false);
  });

  test("GUARD: a request presenting an agent's name is refused even with the window's origin and key", async () => {
    const r = await post({ ids: ["docker:images"] }, { ...person(), "x-agentglass-agent": "bug-fixer" });
    expect(r.status).toBe(403);
    expect(calls().some((l) => /prune/.test(l))).toBe(false);
  });

  test("GUARD: where the desk is held, the window's origin alone is not enough: no desk key, no clean", async () => {
    const r = await post({ ids: ["docker:images"] }, { origin: desk.base });
    expect(r.status).toBe(403);
    expect(calls().some((l) => /prune/.test(l))).toBe(false);
  });

  test("GUARD: a hand-started server with no desk answers a forged window origin with a 403 and cleans nothing", async () => {
    const r = await post({ ids: ["docker:images"] }, { origin: bare.base, [DESK]: KEY }, bare);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain("desktop app");
    expect(calls().some((l) => /prune|worktree remove/.test(l))).toBe(false);
  });

  test("a dry run stays open on the hand-started server: it only reads", async () => {
    const r = await post({ dryRun: true }, { origin: bare.base }, bare);
    expect(r.status).toBe(200);
    expect(((await r.json()) as DiskCleanRunResult).lines.every((l) => l.status === "planned")).toBe(true);
    expect(calls().some((l) => /prune|worktree remove/.test(l))).toBe(false);
  });
});

describe("POST /machine/disk-clean/run: what a clean does", () => {
  test("a body that is not JSON, or ids that are not a list, is a 400 and removes nothing", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ ids: "all" })).status).toBe(400);
    expect((await post({ ids: [{ path: "/etc" }] })).status).toBe(400);
    expect(calls().some((l) => /prune|worktree remove/.test(l))).toBe(false);
  });

  test("a confirm that names a scan the server does not have is a 400 and removes nothing", async () => {
    const r = await post({ ids: ["trash"], at: 1 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as DiskCleanRunResult).error).toContain("scan again");
    expect(existsSync(join(fx.home, ".local/share/Trash/files/old.zip"))).toBe(true);
  });

  test("a dry run says what would go and removes nothing", async () => {
    const r = await post({ dryRun: true });
    const res = (await r.json()) as DiskCleanRunResult;
    expect(r.status).toBe(200);
    expect(res.dryRun).toBe(true);
    expect(res.lines.length).toBeGreaterThan(3);
    expect(res.lines.every((l) => l.status === "planned")).toBe(true);
    expect(calls().some((l) => /prune|worktree remove/.test(l))).toBe(false);
  });

  test("a path in the body is never used: ids pick lines of the scan, and an unknown one is refused", async () => {
    const r = await post({ ids: ["/etc/passwd", "../../home", sessions.live!] });
    const res = (await r.json()) as DiskCleanRunResult;
    expect(res.lines.map((l) => l.status)).toEqual(["refused", "refused", "refused"]);
    expect(existsSync(sessions.live!)).toBe(true);
  });

  test("one line from the window: Docker's images go through the CLI and df on /vault says how much", async () => {
    const r = await post({ ids: ["docker:images"] });
    const res = (await r.json()) as DiskCleanRunResult;
    expect(res.lines).toMatchObject([{ id: "docker:images", status: "freed", freed: 5 * GB }]);
    expect(res.mounts).toEqual([{ mount: "/vault", before: 215 * GB, after: 220 * GB }]);
    expect(calls()).toContain("docker image prune -a -f");
    expect(calls().some((l) => /volume|--volumes|system prune|builder|container prune/.test(l))).toBe(false);
  });

  test("the whole plan: an old session folder goes, a running one stays", async () => {
    const r = await post({});
    const res = (await r.json()) as DiskCleanRunResult;
    expect(res.ok).toBe(true);
    expect(res.freed).toBeGreaterThan(0);
    expect(existsSync(sessions.old!)).toBe(false);
    expect(existsSync(sessions.live!)).toBe(true);
    expect(calls().some((l) => /volume|--volumes|system prune/.test(l))).toBe(false);
  });
});
