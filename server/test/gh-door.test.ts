import { describe, expect, test, beforeEach } from "bun:test";
import { ghRead, planGhRead, resetBudgets, ghEnv, pinProjectSlug, GH_DOOR_PER_MINUTE, GH_DOOR_GLOBAL_PER_MINUTE, GH_DOOR_MAX_CONCURRENT } from "../src/ghdoor.ts";
import { mcpConfigFor } from "../src/agents/headless.ts";

const SLUG = "orbit/acme-app";
const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
const fake = (stdout = "ok", code = 0) => {
  const seen: string[][] = [];
  return { seen, deps: { gh: async (a: string[]) => { seen.push(a); return { code, stdout, stderr: "" }; }, slugOf: async () => SLUG, log: () => {} } };
};

beforeEach(() => resetBudgets());

describe("gh door: what is a read", () => {
  test("the named reads pass and are pinned to the project repo", () => {
    for (const a of [["pr", "view", "123"], ["pr", "diff", "123"], ["pr", "checks", "123"], ["run", "view", "9", "--log-failed"], ["issue", "view", "7"], ["pr", "view", "123", "--json", "state,title"]]) {
      const p = planGhRead(a, SLUG);
      expect(p.ok).toBe(true);
      if (p.ok) expect(p.args.slice(-2)).toEqual(["--repo", SLUG]);
    }
  });
  test("every write verb is refused with one sentence", () => {
    for (const a of [["pr", "comment", "1", "--body", "x"], ["pr", "merge", "1"], ["pr", "review", "1", "--approve"], ["pr", "edit", "1"], ["pr", "create"], ["issue", "create"], ["issue", "close", "1"], ["run", "rerun", "1"], ["api", "-X", "POST", "repos/a/b/issues"], ["repo", "delete", "x"], ["pr", "view", "1", "--web"]]) {
      const p = planGhRead(a, SLUG);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error.split(/\n/).length).toBe(1);
    }
  });
  test("gh auth token refuses and never prints one", () => {
    const p = planGhRead(["auth", "token"], SLUG);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).not.toMatch(/gh[pousr]_/);
  });
  test("another repo is refused, the project's own is accepted", () => {
    expect(planGhRead(["pr", "view", "1", "--repo", "evil/other"], SLUG).ok).toBe(false);
    expect(planGhRead(["pr", "view", "1", "-R", "evil/other"], SLUG).ok).toBe(false);
    expect(planGhRead(["pr", "view", "1", "--repo", SLUG], SLUG).ok).toBe(true);
    expect(planGhRead(["pr", "view", "https://github.com/evil/other/pull/1"], SLUG).ok).toBe(false);
  });
});

describe("gh door: tokens", () => {
  test("a token-shaped string or a token= URL in the ask is refused", () => {
    expect(planGhRead(["pr", "view", "1", "--json", TOKEN], SLUG).ok).toBe(false);
    expect(planGhRead(["pr", "view", "1", "--jq", `.x // "${TOKEN}"`], SLUG).ok).toBe(false);
    expect(planGhRead(["pr", "view", "http://x/?token=abc"], SLUG).ok).toBe(false);
  });
  test("a token in gh's output never reaches the worker", async () => {
    const f = fake(`body ${TOKEN} end`);
    const r = await ghRead("w1", "/p", ["pr", "view", "1"], f.deps);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  test("the log line holds the worker's name and no token", async () => {
    const lines: string[] = [];
    const f = fake();
    await ghRead("w1", "/p", ["pr", "view", "1", "--json", TOKEN], { ...f.deps, log: (l) => lines.push(l) });
    await ghRead("w1", "/p", ["pr", "view", "1"], { ...f.deps, log: (l) => lines.push(l) });
    expect(lines.every((l) => l.includes('"worker":"w1"'))).toBe(true);
    expect(lines.join("")).not.toContain(TOKEN);
  });
});

describe("gh door: scope and budget", () => {
  test("no project, no repo, no read", async () => {
    const f = fake();
    expect((await ghRead("w", undefined, ["pr", "view", "1"], f.deps)).ok).toBe(false);
    expect(f.seen.length).toBe(0);
  });
  test("gh runs in the project root with the project's repo", async () => {
    const f = fake();
    await ghRead("w", "/p", ["pr", "view", "5"], f.deps);
    expect(f.seen[0]).toEqual(["pr", "view", "5", "--repo", SLUG]);
  });
  test("a worker is held to its minute, another is not", async () => {
    const f = fake();
    for (let i = 0; i < GH_DOOR_PER_MINUTE; i++) expect((await ghRead("busy", "/p", ["pr", "view", "1"], f.deps)).ok).toBe(true);
    const r = await ghRead("busy", "/p", ["pr", "view", "1"], f.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
    expect((await ghRead("calm", "/p", ["pr", "view", "1"], f.deps)).ok).toBe(true);
  });
});

describe("gh door: reachable from inside the wall", () => {
  test("every role is given the gh MCP server, whose command is the door", () => {
    const m = mcpConfigFor({ id: "scout" } as never).mcpServers as Record<string, { command: string }>;
    expect(m["agentglass-gh"].command).toBe("agentglass-gh-mcp");
  });
  test("a chosen server cannot take the reserved name", () => {
    const m = mcpConfigFor({ id: "scout" } as never, [{ name: "agentglass-gh", config: { command: "evil" } }]).mcpServers as Record<string, { command: string }>;
    expect(m["agentglass-gh"].command).toBe("agentglass-gh-mcp");
  });
});

describe("gh door: follow-up 1", () => {
  test("F1 --jq, -q, --template are refused", () => {
    for (const a of [["pr", "list", "--json", "number", "--jq", "$ENV"], ["pr", "list", "-q", "env"], ["pr", "view", "1", "--template", "x"], ["pr", "view", "1", "-t", "x"], ["pr", "view", "1", "--jq=$ENV"]]) {
      expect(planGhRead(a, SLUG).ok).toBe(false);
    }
  });
  test("F1 gh env has no agentglass variable", () => {
    const e = ghEnv({ PATH: "/bin", HOME: "/h", AGENTGLASS_TOKEN: "x", AGENTGLASS_PORT: "1", GH_TOKEN: "t", FOO: "1" });
    expect(Object.keys(e).some((k) => k.startsWith("AGENTGLASS"))).toBe(false);
    expect(e.PATH).toBe("/bin");
    expect(e.FOO).toBeUndefined();
  });
  test("F2 the slug stays what it was when pinned, whatever origin becomes", async () => {
    let remote = SLUG;
    const slugOf = async () => remote;
    await pinProjectSlug("/proj", slugOf);
    remote = "victim/private";
    const seen: string[][] = [];
    await ghRead("w", "/proj", ["pr", "list"], { gh: async (a) => { seen.push(a); return { code: 0, stdout: "", stderr: "" }; }, slugOf, log: () => {} });
    expect(seen[0].slice(-2)).toEqual(["--repo", SLUG]);
  });
  test("F3 global cap across workers", async () => {
    const f = fake();
    let refused = 0;
    for (let i = 0; i < GH_DOOR_GLOBAL_PER_MINUTE + 5; i++) {
      const r = await ghRead(`w${i}`, "/p", ["pr", "view", "1"], f.deps);
      if (!r.ok && r.status === 429) refused++;
    }
    expect(refused).toBe(5);
  });
  test("F3 at most 4 gh run at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const deps = { gh: async () => { await gate; return { code: 0, stdout: "", stderr: "" }; }, slugOf: async () => SLUG, log: () => {} };
    const first = Array.from({ length: GH_DOOR_MAX_CONCURRENT }, (_, i) => ghRead(`c${i}`, "/p", ["pr", "view", "1"], deps));
    await new Promise((r) => setTimeout(r, 20));
    const extra = await ghRead("c9", "/p", ["pr", "view", "1"], deps);
    expect(extra.ok).toBe(false);
    release();
    await Promise.all(first);
  });
  test("F4 --log is refused, --log-failed is not, and a capped read says so", async () => {
    expect(planGhRead(["run", "view", "1", "--log"], SLUG).ok).toBe(false);
    expect(planGhRead(["run", "view", "1", "--log-failed"], SLUG).ok).toBe(true);
    const f = { gh: async () => ({ code: 0, stdout: "x", stderr: "", capped: true }), slugOf: async () => SLUG, log: () => {} };
    const r = await ghRead("w", "/p", ["pr", "diff", "1"], f);
    expect(r.ok && r.truncated).toBe(true);
  });
});
