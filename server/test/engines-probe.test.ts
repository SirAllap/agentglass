/*
 * The readiness probe, against the fake engines: what each CLI printed becomes
 * a verdict, the cheap part is cached, the one-line test is bounded, and
 * nothing a CLI printed beyond a few names reaches an answer.
 *
 * The probe is handed absolute paths to the stubs (`which`), so no PATH is
 * changed in this process; `readCalls` is what proves the stub ran.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PROVIDERS } from "../../shared/agentKinds.ts";
import { deriveReadiness, probeEngines, redact, testEngine } from "../src/agentprobe.ts";
import { db } from "../src/db.ts";
import { installFakeEngines, readCalls, type FakeFleet } from "./fixtures/fakeEngines.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// A fleet in a fresh directory, and the `which` that finds only what was written.
function fleet(spec: FakeFleet) {
  const dir = mkdtempSync(join(tmpdir(), "agx-engines-"));
  roots.push(dir);
  const paths = installFakeEngines(dir, spec);
  return { dir, paths, which: (c: string) => paths[c] ?? null };
}
const byId = async (f: ReturnType<typeof fleet>, id: string, fresh = true) => {
  const r = await probeEngines({ which: f.which, fresh });
  return r.engines.find((e) => e.id === id)!;
};
const provider = (id: string) => AGENT_PROVIDERS.find((p) => p.id === id)!;

// A token-shaped line, in the way a status command prints one.
const SECRET = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

describe("probeEngines against the fakes", () => {
  test("an engine not on the PATH is found:false with one install command", async () => {
    const f = fleet({});
    const e = await byId(f, "claude");
    expect(e.found).toBe(false);
    expect(e.path).toBeNull();
    expect(e.missing).toHaveLength(1);
    expect(e.missing[0].kind).toBe("command");
    expect(e.missing[0].command).toBe(provider("claude").probe!.install);
    expect(e.roles.worker.ok).toBe(false);
  });

  test("Hermes 0.21.0 is too old: versionOk false, fix is hermes update, worker says why", async () => {
    const f = fleet({ hermes: { version: { out: "Hermes Agent v0.21.0 (2026.9.1) · upstream 1234abcd" } } });
    const e = await byId(f, "hermes");
    expect(e.version).toBe("0.21.0");
    expect(e.min).toBe("0.21.4");
    expect(e.versionOk).toBe(false);
    expect(e.missing[0]).toMatchObject({ kind: "command", command: "hermes update" });
    expect(e.missing[0].what).toContain("0.21.0 is installed. agentglass needs 0.21.4 or later");
    expect(e.roles.worker.ok).toBe(false);
    expect(e.roles.worker.why).toContain("0.21.0 is older than 0.21.4");
    // The deny-list check is not run on a CLI too old to have the subcommand.
    expect(readCalls(f.dir, "hermes").some((c) => c.argv[0] === "approvals")).toBe(false);
  });

  test("a --version that exits 1 puts its stderr line in missing[0]", async () => {
    const f = fleet({ hermes: { version: { stderr: "ModuleNotFoundError: No module named 'hermes_cli'", exit: 1 } } });
    const e = await byId(f, "hermes");
    expect(e.found).toBe(true);
    expect(e.version).toBeNull();
    expect(e.versionOk).toBeNull();
    expect(e.missing[0].what).toContain("ModuleNotFoundError: No module named 'hermes_cli'");
    expect(e.roles.worker.ok).toBe(false);
  });

  test("a command that times out is versionOk null and a manual fix naming the timeout, never not-installed", () => {
    const e = deriveReadiness(provider("codex"), {
      found: true, path: "/x/codex", status: null, check: null,
      version: { out: "", err: "", code: null, timedOut: true },
    });
    expect(e.found).toBe(true);
    expect(e.versionOk).toBeNull();
    expect(e.missing[0].kind).toBe("manual");
    expect(e.missing[0].what).toContain("did not answer");
    expect(e.missing[0].what).toContain("5 s");
    expect(e.missing[0].what).not.toContain("not installed");
  });

  test("signed out Codex has a login fix and cannot work", async () => {
    const f = fleet({ codex: { status: { out: "Not logged in", exit: 1 } } });
    const e = await byId(f, "codex");
    expect(e.account.signedIn).toBe(false);
    expect(e.missing[0]).toMatchObject({ kind: "login", command: "codex login" });
    expect(e.roles.worker.ok).toBe(false);
    expect(e.roles.worker.why).toContain("Not signed in");
  });

  test("a ready Claude can work and orchestrate, and has not answered yet", async () => {
    const f = fleet({ claude: {} });
    const e = await byId(f, "claude");
    expect(e.version).toBe("2.1.296");
    expect(e.versionOk).toBe(true);
    expect(e.account).toMatchObject({ signedIn: true, provider: "firstParty", account: "claude.ai" });
    expect(e.missing).toEqual([]);
    expect(e.roles.worker.ok).toBe(true);
    expect(e.roles.orchestrator.ok).toBe(true);
    expect(e.answers.state).toBe("never");
    expect(e.envelope.enforced).toBe("yes");
  });

  test("a ready Hermes can work, cannot orchestrate, and its deny list is checked live", async () => {
    // The default stub answers `approvals test` as an unknown command (exit 2),
    // which is "ask" and not "deny": the person's deny list does not hold.
    const f = fleet({ hermes: {} });
    const e = await byId(f, "hermes");
    expect(e.versionOk).toBe(true);
    expect(e.account.provider).toBe("Nous Portal");
    expect(e.envelope.enforced).toBe("no");
    expect(e.envelope.note).toContain("Refuses git push: no");
    expect(e.missing.some((m) => m.what.includes("does not refuse"))).toBe(true);
    expect(readCalls(f.dir, "hermes").some((c) => c.argv.join(" ").startsWith("approvals test"))).toBe(true);
  });

  test("Hermes whose deny list holds is partly enforced and a worker, not an orchestrator", () => {
    const e = deriveReadiness(provider("hermes"), {
      found: true, path: "/x/hermes", check: { out: "", err: "", code: 3, timedOut: false },
      version: { out: "Hermes Agent v0.21.5 (2026.9.24)", err: "", code: 0, timedOut: false },
      status: { out: "Nous Portal   ✓ logged in", err: "", code: 0, timedOut: false },
    });
    expect(e.envelope.enforced).toBe("partly");
    expect(e.envelope.note).toContain("Refuses git push: yes");
    expect(e.roles.worker.ok).toBe(true);
    expect(e.roles.orchestrator.ok).toBe(false);
    expect(e.roles.orchestrator.why).toBe("Cannot orchestrate yet: agentglass does not know how to read Hermes's screen.");
  });

  test("OpenCode with no credential is still a worker: its catalogue is free", async () => {
    const f = fleet({ opencode: { status: { out: "0 credentials" } } });
    const e = await byId(f, "opencode");
    expect(e.account.signedIn).toBe(false);
    expect(e.missing).toEqual([]);
    expect(e.roles.worker.ok).toBe(true);
  });

  test("an engine with no headless facet or no envelope says so as a worker", async () => {
    const f = fleet({ gemini: {}, agy: {} });
    const gemini = await byId(f, "gemini");
    expect(gemini.roles.worker.ok).toBe(false);
    expect(gemini.roles.worker.why).toContain("without a terminal");
    const agy = await byId(f, "antigravity");
    expect(agy.roles.worker.ok).toBe(false);
    expect(agy.roles.worker.why).toContain("permissions");
  });
});

describe("the cache", () => {
  test("a second call with nothing changed spawns no process; touching the binary spawns again", async () => {
    const f = fleet({ claude: {}, codex: {} });
    await probeEngines({ which: f.which, fresh: true });
    const first = readCalls(f.dir).length;
    expect(first).toBeGreaterThan(0);
    await probeEngines({ which: f.which });
    expect(readCalls(f.dir).length).toBe(first);
    const claude = readCalls(f.dir, "claude").length;
    const codex = readCalls(f.dir, "codex").length;
    const later = new Date(Date.now() + 5000);
    utimesSync(f.paths.claude, later, later);
    await probeEngines({ which: f.which });
    // Claude asked again (version, status); Codex, untouched, did not.
    expect(readCalls(f.dir, "claude").length).toBe(claude * 2);
    expect(readCalls(f.dir, "codex").length).toBe(codex);
  });

  test("fresh skips the cache", async () => {
    const f = fleet({ claude: {} });
    await probeEngines({ which: f.which, fresh: true });
    const n = readCalls(f.dir).length;
    await probeEngines({ which: f.which, fresh: true });
    expect(readCalls(f.dir).length).toBe(n * 2);
  });
});

describe("what never leaves", () => {
  test("a token-shaped line in a status output is not in the answer", async () => {
    const f = fleet({
      claude: { status: { out: `{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "apiKey": "${SECRET}"}` } },
      codex: { status: { out: `Logged in using ChatGPT\nbearer ${SECRET}` } },
      hermes: { status: { out: `Nous Portal   ✓ logged in\n  token: ${SECRET}\n  Model: nous/space-bunny-alpha` } },
    });
    const r = await probeEngines({ which: f.which, fresh: true });
    const body = JSON.stringify(r);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("AbCdEf0123456789");
    expect(r.engines.find((e) => e.id === "hermes")!.account.model).toBe("nous/space-bunny-alpha");
  });

  test("an error line is redacted before it is shown", async () => {
    const f = fleet({ codex: { version: { stderr: `fatal: bad key ${SECRET}`, exit: 1 } } });
    const e = await byId(f, "codex");
    expect(e.missing[0].what).toContain("fatal: bad key");
    expect(e.missing[0].what).not.toContain(SECRET);
  });

  test("redact cuts the shapes of a key", () => {
    expect(redact(`x ${SECRET} y`)).toBe("x [redacted] y");
    expect(redact("ghp_abcdefghijklmnop")).toBe("[redacted]");
    expect(redact("just words")).toBe("just words");
  });

  test("the probe's environment has no AGENTGLASS_TOKEN", async () => {
    process.env.AGENTGLASS_TOKEN = "probe-must-not-see-this";
    try {
      const f = fleet({ claude: {} });
      await probeEngines({ which: f.which, fresh: true });
      const calls = readCalls(f.dir, "claude");
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c.env.AGENTGLASS_TOKEN).toBeUndefined();
    } finally { delete process.env.AGENTGLASS_TOKEN; }
  });
});

describe("the one-line test", () => {
  test("a working engine answers ok with a time, and the answer is stored", async () => {
    const f = fleet({ claude: {} });
    const r = await testEngine("claude", { which: f.which });
    expect(r.ok).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    const call = readCalls(f.dir, "claude").find((c) => c.argv.includes("-p"))!;
    expect(call.argv).toContain("Reply with the single word: ok");
    const e = await byId(f, "claude", false);
    expect(e.answers.state).toBe("ok");
    expect(e.answers.at).toBeGreaterThan(0);
  });

  test("a failing engine is failed with its own line", async () => {
    const f = fleet({ codex: { headless: { stderr: "Error: rate limit reached, try again later", exit: 1, frames: [] } } });
    const r = await testEngine("codex", { which: f.which });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rate limit reached");
    expect((await byId(f, "codex", false)).answers).toMatchObject({ state: "failed" });
  });

  test("a hanging engine is killed at the ceiling and nothing is left running", async () => {
    const f = fleet({ claude: { headless: { hang: true } } });
    const t0 = Date.now();
    const r = await testEngine("claude", { which: f.which, timeoutMs: 600 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("did not finish");
    expect(Date.now() - t0).toBeLessThan(5000);
    const pid = readCalls(f.dir, "claude").find((c) => c.argv.includes("-p"))!.pid;
    await Bun.sleep(100);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  test("a second test of the same engine at once is refused", async () => {
    const f = fleet({ claude: { headless: { delayMs: 500 } } });
    const first = testEngine("claude", { which: f.which });
    await Bun.sleep(100);
    const second = await testEngine("claude", { which: f.which });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already being tested");
    expect((await first).ok).toBe(true);
  });

  test("an unknown engine and a missing one are refused with a sentence", async () => {
    expect((await testEngine("emacs")).error).toBe("no such engine");
    const f = fleet({});
    expect((await testEngine("claude", { which: f.which })).error).toContain("not on this machine");
  });
});

describe("the probe writes only to the database", () => {
  test("it creates no file of its own beside the stubs", async () => {
    const f = fleet({ claude: {} });
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM engine_probe").get()!.n;
    await probeEngines({ which: f.which, fresh: true });
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM engine_probe").get()!.n;
    expect(after).toBeGreaterThanOrEqual(before);
    // The stub's own call log is the only thing the fake directory gains.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(f.dir).filter((n) => !["claude", ".calls"].includes(n))).toEqual([]);
  });
});
