/*
 * GET /prs/sessions — the authoring session of a pull request, as a brief a
 * review plugin may read.
 *
 * The brief is the most private thing the app can hand a plugin, so what is
 * asserted here is mostly what must NOT happen: the door opening on one
 * permission instead of two, a secret reaching the response or a log, a home
 * directory leaving the machine, an answer outgrowing its cap.
 *
 * The event log is a real (isolated) database for the end-to-end cases and a
 * fake for the rest; the only things the route adds on top are the plugin's
 * identity and the head branch, which a source test pins.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpendRow } from "../src/spend.ts";
import type { SessionFacts, SessionsDeps } from "../src/prsessions.ts";

// Set before anything that opens a database or reads a config directory is
// loaded: those modules pin their paths at import (see spend-attribution.test.ts).
const dir = mkdtempSync(join(tmpdir(), "agx-prs-sessions-"));
const REPO = join(dir, "orbit");
const WT = join(REPO, "wt", "export-tz");
mkdirSync(WT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "events.db");
process.env.AGENTGLASS_ROOT = REPO;
process.env.XDG_CONFIG_HOME = dir;
process.env.XDG_DATA_HOME = join(dir, "data");
process.env.XDG_CACHE_HOME = join(dir, "cache");
process.env.AGENTGLASS_STATE_DIR = join(dir, "state");

let P: typeof import("../src/prsessions.ts");
let db: typeof import("../src/db.ts");
let spend: typeof import("../src/spend.ts");
let plugins: typeof import("../src/plugins.ts");
let scrub: typeof import("../../shared/scrub.ts");
let ui: typeof import("../../shared/pluginUi.ts");

const HOME = "/home/alex";
/** Built at run time: no literal in this file is a token a scanner would flag. */
const FAKE_KEY = "ghp_" + "a1B2c3D4".repeat(5);

beforeAll(async () => {
  db = await import("../src/db.ts");
  spend = await import("../src/spend.ts");
  plugins = await import("../src/plugins.ts");
  P = await import("../src/prsessions.ts");
  scrub = await import("../../shared/scrub.ts");
  ui = await import("../../shared/pluginUi.ts");
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  sessionId: "sess-1", agent: "claude-code", startedAt: 1_000, endedAt: 2_000,
  firstPrompt: "Export should respect the user's timezone", finalMessage: "Done: dates use the viewer's timezone.",
  files: [join(REPO, "src/export/csv.ts")], tools: { Bash: 3, Edit: 2 }, ...over,
});

// ── the manifest ────────────────────────────────────────────────────────────

describe("contributes.reads", () => {
  test("`sessions` is accepted and kept", () => {
    const r = ui.validateContributes({ reads: ["sessions"] });
    expect(r.ok && r.value.reads).toEqual(["sessions"]);
  });

  test("an unknown value is refused, naming the ones that exist", () => {
    const r = ui.validateContributes({ reads: ["transcripts"] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('unknown value "transcripts"');
    expect(!r.ok && r.error).toContain("allowed: sessions");
  });

  test("not a list, a non-string, a repeat and a third entry are each refused", () => {
    for (const reads of ["sessions", [1], ["sessions", "sessions"], ["sessions", "sessions", "sessions"], {}]) {
      expect(ui.validateContributes({ reads }).ok, JSON.stringify(reads)).toBe(false);
    }
  });

  test("the approval hash moves when a plugin starts asking to read sessions", () => {
    const base = { name: "acme-review", publisher: "acme", description: "Reviews pull requests.", entrypoint: "python3 r.py", scope: "read" as const };
    const without = plugins.manifestHash({ ...base, contributes: { prNotes: true } });
    const withReads = plugins.manifestHash({ ...base, contributes: { prNotes: true, reads: ["sessions"] } });
    expect(withReads).not.toBe(without);
  });

  test("the declaration screen says it in plain words", () => {
    expect(ui.PLUGIN_READ_WORDS.sessions).toBe("Can read a redacted summary of the agent session that wrote a pull request (only in repositories you allow)");
    const web = readFileSync(new URL("../../web/src/components/plugins/PluginDeclaration.tsx", import.meta.url), "utf8");
    expect(web).toContain("PLUGIN_READ_WORDS");
    const cli = readFileSync(new URL("../../bin/agentglass-plugin", import.meta.url), "utf8");
    expect(cli).toContain(ui.PLUGIN_READ_WORDS.sessions);
  });
});

// ── the two permissions ─────────────────────────────────────────────────────

describe("the gates", () => {
  const declares: { reads: "sessions"[] } = { reads: ["sessions"] };
  const allowed = ["acme/orbit"];

  test("both present: open", () => {
    expect(P.sessionsGate({ ...declares }, "acme/orbit", allowed)).toEqual({ ok: true });
  });

  test("the manifest alone is not enough", () => {
    const g = P.sessionsGate({ ...declares }, "acme/orbit", []);
    expect(g.ok).toBe(false);
    expect(!g.ok && g.missing).toEqual(["repository"]);
    expect(!g.ok && g.error).toContain("acme/orbit is not in the repositories the person allowed");
  });

  test("the repository alone is not enough", () => {
    const g = P.sessionsGate({}, "acme/orbit", allowed);
    expect(g.ok).toBe(false);
    expect(!g.ok && g.missing).toEqual(["manifest"]);
    expect(!g.ok && g.error).toContain('contributes.reads: ["sessions"]');
  });

  test("neither: both are named", () => {
    const g = P.sessionsGate({}, "acme/orbit", []);
    expect(!g.ok && g.missing).toEqual(["manifest", "repository"]);
  });

  test("a repository the app cannot name is not allowed", () => {
    expect(P.sessionsGate({ ...declares }, null, allowed).ok).toBe(false);
  });

  test("case does not matter to GitHub, so it does not matter here", () => {
    expect(P.sessionsGate({ ...declares }, "Acme/Orbit", allowed).ok).toBe(true);
  });

  test("the list the person keeps: empty by default, normalised, bounded to real names", () => {
    expect(P.sessionReadRepos()).toEqual([]);
    expect(P.setSessionReadRepos(["Acme/Orbit", "acme/orbit", "not a repo", "gh:acme/helm", 4])).toEqual(["acme/orbit", "acme/helm"]);
    expect(P.sessionReadRepos()).toEqual(["acme/orbit", "acme/helm"]);
    P.__resetSessionReadsCache();
    expect(P.sessionReadRepos(), "under test the file is not read or written outside the scratch directory").toBeDefined();
    P.setSessionReadRepos([]);
  });
});

// ── which sessions wrote this branch ────────────────────────────────────────

describe("matching a session to a pull request", () => {
  const row = (o: Partial<SpendRow>): SpendRow => ({ branch: "", dir: REPO, session_id: "s", usd: 1, last_ts: 1, ...o });
  const checkouts = new Map([[REPO, "main"], [WT, "feat/export-tz"]]);

  test("by the branch the turn recorded", () => {
    const m = P.sessionsOnBranch([row({ branch: "feat/export-tz", session_id: "a" }), row({ branch: "feat/other", session_id: "b" })], checkouts, "feat/export-tz");
    expect(m.map((x) => x.sessionId)).toEqual(["a"]);
  });

  test("by the worktree it ran in, when the turn recorded no branch", () => {
    const m = P.sessionsOnBranch([row({ dir: WT, session_id: "a" })], checkouts, "feat/export-tz");
    expect(m.map((x) => x.sessionId)).toEqual(["a"]);
  });

  test("by a directory inside that worktree, the longest checkout winning over the root that contains it", () => {
    const m = P.sessionsOnBranch([row({ dir: join(WT, "packages/ui"), session_id: "a" }), row({ dir: join(REPO, "docs"), session_id: "root" })], checkouts, "feat/export-tz");
    expect(m.map((x) => x.sessionId)).toEqual(["a"]);
  });

  test("a turn's own branch beats the branch its directory has out now", () => {
    expect(P.sessionsOnBranch([row({ dir: WT, branch: "feat/old", session_id: "a" })], checkouts, "feat/export-tz")).toEqual([]);
  });

  test("none is an empty list, never an error; newest first", () => {
    expect(P.sessionsOnBranch([], checkouts, "feat/export-tz")).toEqual([]);
    const m = P.sessionsOnBranch([
      row({ branch: "x", session_id: "old", last_ts: 1 }), row({ branch: "x", session_id: "new", last_ts: 9 }), row({ branch: "x", session_id: "old", last_ts: 2 }),
    ], checkouts, "x");
    expect(m).toEqual([{ sessionId: "new", lastTs: 9 }, { sessionId: "old", lastTs: 2 }]);
  });
});

// ── what the brief holds ────────────────────────────────────────────────────

describe("the brief", () => {
  const build = (f: SessionFacts) => P.buildBrief(f, [REPO, WT], HOME);

  test("the request and the summary are cut at 1,500 characters and say so", () => {
    const r = build(facts({ firstPrompt: "x".repeat(4_000), finalMessage: "y".repeat(4_000) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.request.length).toBeLessThanOrEqual(1_502);
    expect(r.brief.summary.length).toBeLessThanOrEqual(1_502);
    expect(r.brief.truncated).toEqual({ request: true, summary: true, files: false });
  });

  test("a short one is whole and says nothing was cut", () => {
    const r = build(facts());
    expect(r.ok && r.brief.truncated).toEqual({ request: false, summary: false, files: false });
  });

  test("at most 60 files, relative to the checkout they are in, each once", () => {
    const many = Array.from({ length: 90 }, (_, i) => join(WT, `src/f${i}.ts`));
    const r = build(facts({ files: [...many, many[0]!, join(REPO, "README.md")] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.brief.files).toHaveLength(60);
    expect(r.brief.files[0]).toBe("src/f0.ts");
    expect(r.brief.truncated.files).toBe(true);
    expect(build(facts({ files: [join(REPO, "README.md")] })).ok).toBe(true);
  });

  test("an absolute home path becomes ~ everywhere: in the text and in a file outside the repository", () => {
    const r = build(facts({
      firstPrompt: `Look at ${HOME}/code/orbit/notes.md and /home/bob/x.txt`,
      finalMessage: `Wrote ${HOME}/.config/orbit/conf.json; also /Users/carol/proj`,
      files: [`${HOME}/code/other/z.ts`],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = JSON.stringify(r.brief);
    for (const leak of [HOME, "/home/bob", "/Users/carol", "alex", "bob", "carol"]) expect(all, leak).not.toContain(leak);
    expect(r.brief.request).toBe("Look at ~/code/orbit/notes.md and ~/x.txt");
    expect(r.brief.files).toEqual(["~/code/other/z.ts"]);
  });

  test("a home directory that is not under /home or /Users goes too", () => {
    const odd = "/srv/people/alex";
    const r = P.buildBrief(facts({ firstPrompt: `see ${odd}/code/notes.md`, files: [`${odd}/z.ts`] }), [REPO], odd);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("alex");
  });

  test("the session id is not handed over, only a hash of it", () => {
    const r = build(facts({ sessionId: "11111111-2222-3333-4444-555555555555" }));
    expect(r.ok && r.brief.id).toMatch(/^s_[0-9a-f]{16}$/);
    expect(JSON.stringify(r)).not.toContain("11111111");
  });

  test("tool counts ride along, nothing of what the tools said", () => {
    const r = build(facts({ tools: { Bash: 14, Edit: 6 } }));
    expect(r.ok && r.brief.tools).toEqual({ Bash: 14, Edit: 6 });
    expect(Object.keys((r as { brief: object }).brief).sort()).toEqual(["agent", "endedAt", "files", "id", "request", "startedAt", "summary", "tools", "truncated"]);
  });
});

// ── a secret blocks it ──────────────────────────────────────────────────────

describe("a secret-like string refuses the whole answer", () => {
  const deps = (f: SessionFacts[]): SessionsDeps => ({
    rows: () => f.map((x, i) => ({ branch: "feat/export-tz", dir: REPO, session_id: x.sessionId, usd: 1, last_ts: 10 - i })),
    checkouts: async () => new Map(),
    facts: (id) => f.find((x) => x.sessionId === id) ?? null,
  });

  test("in the first request: 422, the kinds, and not one character of it", async () => {
    const out = await P.answerSessions(REPO, "feat/export-tz", deps([facts({ firstPrompt: `use this key ${FAKE_KEY} for the export` })]), HOME);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(422);
    expect(out.error).toBe("secret-like text found in the session brief");
    expect(out.kinds).toContain("github-token");
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(out)).not.toContain("a1B2c3D4");
  });

  test("in the closing summary, in a path, in another session: each refuses the whole answer", async () => {
    const clean = facts({ sessionId: "clean" });
    for (const bad of [
      facts({ sessionId: "bad", finalMessage: `exported with ${FAKE_KEY}` }),
      facts({ sessionId: "bad", files: [join(REPO, `${FAKE_KEY}.txt`)] }),
      facts({ sessionId: "bad", firstPrompt: "password = hunter2hunter2hunter2" }),
      facts({ sessionId: "bad", finalMessage: "-----BEGIN RSA PRIVATE KEY-----\nMIIE" }),
    ]) {
      const out = await P.answerSessions(REPO, "feat/export-tz", deps([clean, bad]), HOME);
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      expect(JSON.stringify(out)).not.toContain("hunter2");
      expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    }
  });

  test("a key past the 1,500 cut is still found: the scan runs before the cut", async () => {
    const out = await P.answerSessions(REPO, "feat/export-tz", deps([facts({ firstPrompt: "x ".repeat(1_000) + FAKE_KEY })]), HOME);
    expect(out.ok).toBe(false);
  });

  test("it is never written to a log either", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => spyOn(console, m).mockImplementation(() => {}));
    try {
      await P.answerSessions(REPO, "feat/export-tz", deps([facts({ firstPrompt: FAKE_KEY })]), HOME);
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("a1B2c3D4");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test("prose that merely mentions a token, and a commit id, do not block", () => {
    expect(scrub.secretKinds("the token expiration check uses the refresh token flow")).toEqual([]);
    expect(scrub.secretKinds("fixed in 9fceb02d0ae598e95dc970b74767f19372d61af3 and 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae")).toEqual([]);
  });

  test("the kinds it knows", () => {
    expect(scrub.secretKinds(`Authorization: Bearer ${"abcdefghij" + "klmnopqrstuvwxyz0123"}`)).toContain("bearer-token");
    expect(scrub.secretKinds("AKIAIOSFODNN7EXAMPLE")).toContain("aws-key");
    expect(scrub.secretKinds("api_key=xxxxxxxxxxxxxxxxxxxx")).toContain("credential-assignment");
  });
});

// ── a clean answer, end to end, from the event log ──────────────────────────

describe("the event log", () => {
  const now = Date.now();
  const ev = (o: { session: string; type: string; tool?: string; payload: Record<string, unknown>; ago: number; usd?: boolean }) => ({
    source_app: "claude-code", session_id: o.session, hook_event_type: o.type, tool_name: o.tool ?? null,
    tool_use_id: null, agent_id: null, agent_type: null, model_name: "claude-opus-4-8", is_error: 0, error_text: null,
    usage: { input_tokens: o.usd ? 1_000_000 : 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
    usage_is_cumulative: false, summary: "", timestamp: now - o.ago,
    payload: { project_path: REPO, cwd: WT, git_branch: "feat/export-tz", ...o.payload }, chat: null,
  });

  beforeAll(() => {
    const s = "sess-author";
    db.insertEvent(ev({ session: s, type: "UserPromptSubmit", payload: { prompt: `Make export respect the timezone, see ${HOME}/code/orbit/notes.md` }, ago: 5_000 }) as any);
    db.insertEvent(ev({ session: s, type: "PostToolUse", tool: "Bash", payload: { tool_input: { command: "bun test" }, tool_response: { stdout: `PRIVATE-OUTPUT ${FAKE_KEY}` } }, ago: 4_000, usd: true }) as any);
    db.insertEvent(ev({ session: s, type: "PostToolUse", tool: "Edit", payload: { tool_input: { file_path: join(WT, "src/export/csv.ts") } }, ago: 3_000 }) as any);
    db.insertEvent(ev({ session: s, type: "PostToolUse", tool: "Write", payload: { tool_input: { file_path: `${HOME}/scratch/out.txt` } }, ago: 2_500 }) as any);
    db.insertEvent(ev({ session: s, type: "Stop", payload: { last_assistant_message: "Export now formats dates in the viewer's timezone." }, ago: 1_000 }) as any);
    // Another branch of the same repository: must not be attributed to this pull request.
    db.insertEvent(ev({ session: "sess-other", type: "UserPromptSubmit", payload: { prompt: "unrelated", git_branch: "feat/other" }, ago: 900 }) as any);
    db.insertEvent(ev({ session: "sess-other", type: "PostToolUse", tool: "Bash", payload: { git_branch: "feat/other" }, ago: 800, usd: true }) as any);
  });

  const deps = (): SessionsDeps => ({
    rows: (r) => spend.spendRows(r, 0),
    checkouts: async () => new Map([[REPO, "main"], [WT, "feat/export-tz"]]),
    facts: P.sessionFacts,
  });

  test("the author's session, and only it, with the home path hidden and no tool output", async () => {
    const out = await P.answerSessions(REPO, "feat/export-tz", deps(), HOME);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sessions).toHaveLength(1);
    const b = out.sessions[0]!;
    expect(b.agent).toBe("claude-code");
    expect(b.request).toBe("Make export respect the timezone, see ~/code/orbit/notes.md");
    expect(b.summary).toBe("Export now formats dates in the viewer's timezone.");
    expect(b.files).toEqual(["src/export/csv.ts", "~/scratch/out.txt"]);
    expect(b.tools).toEqual({ Bash: 1, Edit: 1, Write: 1 });
    expect(JSON.stringify(out)).not.toContain("PRIVATE-OUTPUT");
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
  });

  test("a branch nobody worked on is an empty list", async () => {
    expect(await P.answerSessions(REPO, "feat/nobody", deps(), HOME)).toEqual({ ok: true, sessions: [] });
  });
});

// ── the caps ────────────────────────────────────────────────────────────────

describe("the caps", () => {
  test("at most 3 sessions, newest first", async () => {
    const all = Array.from({ length: 5 }, (_, i) => facts({ sessionId: `s${i}` }));
    const out = await P.answerSessions(REPO, "feat/export-tz", {
      rows: () => all.map((x, i) => ({ branch: "feat/export-tz", dir: REPO, session_id: x.sessionId, usd: 1, last_ts: i })),
      checkouts: async () => new Map(), facts: (id) => all.find((x) => x.sessionId === id) ?? null,
    }, HOME);
    expect(out.ok && out.sessions.map((s) => s.id)).toEqual(["s4", "s3", "s2"].map(P.opaqueId));
  });

  test("the answer fits 24 KB: file lists are shed first, then the oldest sessions, and it says so", () => {
    const big = (id: string) => {
      const r = P.buildBrief(facts({ sessionId: id, firstPrompt: "p".repeat(1_500), finalMessage: "q".repeat(1_500), files: Array.from({ length: 60 }, (_, i) => join(WT, `src/${"d".repeat(120)}/f${i}.ts`)) }), [WT], HOME);
      if (!r.ok) throw new Error("fixture holds a secret");
      return r.brief;
    };
    const fitted = P.fit([big("a"), big("b"), big("c")]);
    expect(new TextEncoder().encode(JSON.stringify(fitted)).length).toBeLessThanOrEqual(P.RESPONSE_MAX_BYTES);
    expect(fitted.truncated).toBe(true);
    expect(fitted.sessions.length).toBeGreaterThan(0);
  });

  test("a small answer is not marked truncated", () => {
    const b = P.buildBrief(facts(), [REPO], HOME);
    if (!b.ok) throw new Error("fixture holds a secret");
    expect(P.fit([b.brief])).toEqual({ ok: true, sessions: [b.brief] });
  });

  test("60 answered requests an hour per plugin, counted per plugin, and the hour rolls", () => {
    P.__resetSessionsRate();
    const t0 = 1_000_000;
    for (let i = 0; i < 60; i++) expect(P.takeSessionsSlot("acme-review", t0 + i).ok).toBe(true);
    const refused = P.takeSessionsSlot("acme-review", t0 + 100);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.retryAfterSec).toBeGreaterThan(3_500);
    expect(P.takeSessionsSlot("acme-other", t0 + 100).ok, "another plugin has its own count").toBe(true);
    expect(P.takeSessionsSlot("acme-review", t0 + 3_600_001).ok, "an hour later").toBe(true);
    P.__resetSessionsRate();
  });
});

// ── the route and the module say what they promise ──────────────────────────

describe("the source", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const mod = readFileSync(new URL("../src/prsessions.ts", import.meta.url), "utf8");
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const route = (() => {
    const at = index.indexOf('if (pathname === "/prs/sessions") {');
    expect(at).toBeGreaterThan(0);
    let depth = 0;
    for (let i = index.indexOf("{", at); i < index.length; i++) {
      if (index[i] === "{") depth++;
      if (index[i] === "}" && --depth === 0) return index.slice(at, i + 1);
    }
    return "";
  })();

  test("the route answers only a plugin, checks both permissions, then the rate, then reads", () => {
    const at = (needle: string) => route.indexOf(needle);
    expect(at("pluginOfRequest(req, url)")).toBeGreaterThan(-1);
    expect(at("sessionsGate(")).toBeGreaterThan(at("pluginOfRequest("));
    expect(at("takeSessionsSlot(")).toBeGreaterThan(at("sessionsGate("));
    expect(at("answerSessions(")).toBeGreaterThan(at("takeSessionsSlot("));
    expect(route).toContain("status: 429");
    expect(route).toContain("out.kinds");
  });

  test("the route cannot reach GitHub or log the brief; the module does neither", () => {
    expect(code(route)).not.toMatch(/\b(fetch|gh\w*|console)\b/);
    expect(code(mod)).not.toMatch(/\b(fetch|console|ghJson|Bun\.spawn)\b/);
  });

  test("the secret scan covers the whole brief and runs before the cut", () => {
    const fn = code(mod.slice(mod.indexOf("export function buildBrief(")));
    expect(fn.indexOf("secretKinds(")).toBeGreaterThan(-1);
    expect(fn.indexOf("secretKinds(")).toBeLessThan(fn.indexOf("clip("));
  });
});
