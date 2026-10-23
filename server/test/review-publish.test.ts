/*
 * Publishing a local review as one pull-request comment. The builder is pure
 * and is exercised on invented findings; the GitHub reads and writes are a spy
 * (nothing here has a network), and the route's gate is asked of a booted
 * server with a scratch home.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PUBLISH_OPTIONS, PUBLISH_MAX_CHARS, buildReviewComment, checkEdited, cleanPublishOptions, findPublished, previewReview, publishReview,
  reviewMarker, type PrCommentRef, type PublishDeps, type PublishOptions,
} from "../src/review-publish.ts";
import { validateRun, type NoteReply, type PrNote, type PrRun } from "../../shared/pluginUi.ts";
import { UI_ACTIONS, UI_REFUSED_FOR_AGENTS } from "../../shared/uiActions.ts";
import { freePort } from "./freePort.ts";
import { TMUX_TEST_TMPDIR } from "./tmuxTmp.ts";
import { SERVER_BOOT_MS } from "./serverBoot.ts";

const P = "acme-review";
const REPO = "acme/orbit";
const run: PrRun = {
  id: "run-7", repo: REPO, number: 1042, sha: "3f9a2c1d0e8b7a6f5e4d3c2b1a09f8e7d6c5b4a3", state: "done", title: "Local review",
  agent: "Claude Code", model: "claude-sonnet", costUsd: 0.4, startedAt: Date.UTC(2026, 9, 17, 9), finishedAt: Date.UTC(2026, 9, 17, 10),
};
let seq = 0;
function note(over: Partial<PrNote> = {}): PrNote {
  seq++;
  return {
    id: `f-${seq}`, repo: REPO, number: 1042, severity: "medium", title: `Finding ${seq}`, status: "open", createdAt: 1000 + seq, updatedAt: 1000 + seq,
    path: "src/a.ts", line: 10, ...over,
  };
}
const reply = (text: string, over: Partial<NoteReply> = {}): NoteReply => ({ id: `r${++seq}`, text, at: 1, by: "user", ...over });
const opts = (over: Partial<PublishOptions> = {}): PublishOptions => ({ ...DEFAULT_PUBLISH_OPTIONS, ...over });
function md(notes: PrNote[], o: Partial<PublishOptions> = {}, r: PrRun = run, viewer = "acme-user"): string {
  const b = buildReviewComment({ plugin: P, repo: REPO, number: 1042, run: r, notes, options: opts(o), viewer });
  if (!b.ok) throw new Error(b.error);
  return b.markdown;
}

const crit = note({ severity: "critical", title: "Guard runs after the loop", body: "The guard runs too late.", id: "f-crit" });
const high = note({ severity: "high", title: "High one", id: "f-high" });
const low = note({ severity: "low", title: "Low one", id: "f-low" });
const resolved = note({ status: "resolved", title: "Description is stale", id: "f-res", replies: [reply("Fixed in 9c1d4e2.", { withStatus: "resolved" })] });
const dismissed = note({ status: "dismissed", title: "Legacy path", id: "f-dis", replies: [reply("Intentional until v2.", { withStatus: "dismissed" })] });
const idea = note({ severity: "idea", title: "Maybe rename", id: "f-idea" });

describe("the defaults share the minimum", () => {
  test("GUARD: only the header and the open findings are on", () => {
    expect(DEFAULT_PUBLISH_OPTIONS).toEqual({ includeHeader: true, includeOpen: true, includeResolved: false, includeDismissed: false, includeReplies: false, includeInfo: false });
    expect(cleanPublishOptions(undefined)).toEqual(DEFAULT_PUBLISH_OPTIONS);
    expect(cleanPublishOptions({ includeResolved: "yes", includeReplies: 1 })).toEqual(DEFAULT_PUBLISH_OPTIONS);
    expect(cleanPublishOptions({ includeResolved: true }).includeResolved).toBe(true);
  });
  test("with the defaults a resolved, a dismissed and an info finding stay out", () => {
    const t = md([crit, resolved, dismissed, idea]);
    expect(t).toContain("Guard runs after the loop");
    expect(t).not.toContain("Description is stale");
    expect(t).not.toContain("Legacy path");
    expect(t).not.toContain("Maybe rename");
    expect(t).not.toContain("Fixed in 9c1d4e2");
  });
});

describe("the header", () => {
  test("a table from the run record, a short commit, a date and the marker last", () => {
    const t = md([crit]);
    expect(t).toContain("### 🔍 Local review · Claude Code · acme-review");
    expect(t).toContain("| Agent | Model | Commit | Cost | Date |");
    expect(t).toContain("| Claude Code | claude-sonnet | `3f9a2c1` | $0.40 | 2026-10-17 |");
    expect(t).toContain("Reviewed locally on the author's machine; not a GitHub review (no approval, no change request).");
    expect(t.endsWith(reviewMarker(P))).toBe(true);
    expect(t.match(/<!-- agentglass-review:/g)).toHaveLength(1);
  });
  test("what the run does not carry is a dash, and meta is never read", () => {
    const bare: PrRun = { id: "r", repo: REPO, number: 1042, state: "done", title: "t", meta: "local-review · $9.99 · 82 s", startedAt: Date.UTC(2026, 0, 2) };
    const t = md([crit], {}, bare);
    expect(t).toContain("| - | - | - | - | 2026-01-02 |");
    expect(t).not.toContain("9.99");
  });
  test("no header option: only the findings", () => {
    const t = md([crit], { includeHeader: false });
    expect(t).not.toContain("| Agent |");
    expect(t).not.toContain("Verdict");
    expect(t).toContain("Guard runs after the loop");
  });
});

describe("the verdict comes from the findings alone", () => {
  test("open critical or high: needs changes", () => {
    expect(md([crit])).toContain("**Verdict: needs changes before merge** — 1 critical open.");
    expect(md([high, low])).toContain("needs changes before merge");
  });
  test("open medium or low: minor issues", () => {
    expect(md([low])).toContain("**Verdict: minor issues open** — 1 low open.");
  });
  test("none open: no open findings; resolved and info do not count", () => {
    expect(md([resolved, dismissed, idea])).toContain("**Verdict: no open findings** — 0 open.");
    expect(md([])).toContain("no open findings");
  });
  test("the verdict counts findings the person left out of the comment", () => {
    expect(md([crit], { includeOpen: false })).toContain("needs changes before merge");
  });
  test("the count line adds resolved and dismissed only when they are included", () => {
    expect(md([crit, resolved, dismissed])).toContain("1 critical open. Reviewed");
    expect(md([crit, resolved, dismissed], { includeResolved: true, includeDismissed: true })).toContain("1 critical open, 1 resolved, 1 dismissed.");
  });
});

describe("the findings", () => {
  test("open first by severity, then resolved, then dismissed", () => {
    const t = md([dismissed, resolved, low, crit, high], { includeResolved: true, includeDismissed: true });
    const at = (s: string) => t.indexOf(s);
    expect(at("Guard runs after the loop")).toBeLessThan(at("High one"));
    expect(at("High one")).toBeLessThan(at("Low one"));
    expect(at("Low one")).toBeLessThan(at("Description is stale"));
    expect(at("Description is stale")).toBeLessThan(at("Legacy path"));
  });
  test("one collapsed block each: severity, file:line, title, state, body", () => {
    const t = md([crit]);
    expect(t).toContain("<details open>");
    expect(t).toContain("<summary><b>CRITICAL</b> Guard runs after the loop · `src/a.ts:10` · <b>open</b></summary>");
    expect(t).toContain("The guard runs too late.");
    expect(md([resolved], { includeResolved: true })).toMatch(/<details>\n<summary><b>MEDIUM<\/b> Description is stale .* <b>resolved<\/b>/);
  });
  test("a closed finding quotes how it was closed; the whole thread needs includeReplies", () => {
    const talky = note({ status: "resolved", id: "f-talk", title: "Talky", replies: [reply("Looking."), reply("Fixed.", { withStatus: "resolved" })] });
    const closing = md([talky], { includeResolved: true });
    expect(closing).toContain("> **acme-user** (resolved): Fixed.");
    expect(closing).not.toContain("Looking.");
    expect(md([talky], { includeResolved: true, includeReplies: true })).toContain("> **acme-user**: Looking.");
    const openTalky = note({ id: "f-open-talk", title: "Open talky", replies: [reply("Checking.")] });
    expect(md([openTalky])).not.toContain("Checking.");
    expect(md([openTalky], { includeReplies: true })).toContain("> **acme-user**: Checking.");
  });
  test("an agent's reply is named as an agent", () => {
    const n = note({ id: "f-ag", status: "dismissed", replies: [reply("On it.", { by: "agent:bug-fixer", withStatus: "dismissed" })] });
    expect(md([n], { includeDismissed: true })).toContain("> **agent bug-fixer** (dismissed): On it.");
  });
  test("info and idea findings only when asked", () => {
    expect(md([idea], { includeInfo: true })).toContain("Maybe rename");
    expect(md([idea])).not.toContain("Maybe rename");
  });
  test("the footer names the commit and the re-publishing note", () => {
    expect(md([crit])).toContain("Published from agentglass · review of `3f9a2c1` · re-publishing after a push edits this comment.");
  });
  test("it is deterministic", () => {
    expect(md([crit, high, resolved], { includeResolved: true })).toBe(md([crit, high, resolved], { includeResolved: true }));
  });
});

describe("escaping", () => {
  test("no raw HTML, no way out of the block, no forged marker", () => {
    const evil = note({ id: "f-evil", title: "<img src=x onerror=alert(1)>", body: "</details><script>x()</script> <!-- agentglass-review:other -->" });
    const t = md([evil]);
    expect(t).not.toMatch(/<img|<script|<\/details><script/);
    expect(t).toContain("&lt;/details>");
    expect(t.match(/<\/details>/g)).toHaveLength(1);
    expect(t.match(/<!-- agentglass-review:/g)).toHaveLength(1);
  });
  test("an @mention gets a zero-width break; an email-like text and code are left alone", () => {
    const n = note({ id: "f-at", title: "ping @octocat", body: "cc @acme-user and @acme/team, mail a@b.co" });
    const t = md([n]);
    expect(t).not.toMatch(/@octocat|@acme-user|@acme\/team/);
    expect(t).toContain("@​octocat");
    expect(t).toContain("a@b.co");
  });
  test("an image is neutralised and an open fence is closed", () => {
    const n = note({ id: "f-img", body: "![x](https://tracker.example/p.png)\n```ts\nlet a = 1" });
    const t = md([n]);
    expect(t).not.toContain("![x]");
    expect((t.match(/^```/gm) ?? []).length % 2).toBe(0);
  });
  test("a home directory becomes ~", () => {
    const n = note({ id: "f-home", path: "/home/acme-user/code/orbit/src/a.ts", body: "see /Users/acme/notes/x.md and /home/acme-user/.config/y" });
    const t = md([n]);
    expect(t).not.toMatch(/\/home\/|\/Users\//);
    expect(t).toContain("~/code/orbit/src/a.ts");
  });
  test("reply text is escaped the same way", () => {
    const n = note({ id: "f-r", status: "resolved", replies: [reply("thanks @octocat <b>x</b>", { withStatus: "resolved" })] });
    const t = md([n], { includeResolved: true });
    expect(t).not.toMatch(/@octocat|<b>x/);
  });
});

describe("the size cap", () => {
  test("lowest severities become counts and no finding is cut in half", () => {
    const big = "x ".repeat(2500);
    const many = [
      note({ id: "k-crit", severity: "critical", title: "Keep me", body: big }),
      ...Array.from({ length: 30 }, (_, i) => note({ id: `k-low-${i}`, severity: "low", title: `Low ${i}`, body: big })),
    ];
    const b = buildReviewComment({ plugin: P, repo: REPO, number: 1042, run, notes: many, options: opts() });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.chars).toBeLessThanOrEqual(PUBLISH_MAX_CHARS);
    expect(b.markdown).toContain("Keep me");
    expect(b.omitted).toBeGreaterThan(0);
    expect(b.markdown).toMatch(/Left out to fit GitHub's size limit: \d+ low/);
    expect(b.markdown.match(/<details/g)!.length).toBe(b.markdown.match(/<\/details>/g)!.length);
    expect(b.markdown.endsWith(reviewMarker(P))).toBe(true);
  });
});

describe("credentials", () => {
  test("a finding that holds one stops the publish, names its id, never echoes it", () => {
    const token = "ghp_" + "x".repeat(36);
    const b = buildReviewComment({ plugin: P, repo: REPO, number: 1042, run, notes: [note({ id: "f-secret", body: `token ${token}` })], options: opts() });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error).toContain("f-secret");
    expect(b.error).not.toContain(token);
  });
  test("a commit id in a finding is not a credential", () => {
    expect(() => md([note({ body: "introduced in 3f9a2c1d0e8b7a6f5e4d3c2b1a09f8e7d6c5b4a3" })])).not.toThrow();
  });
  test("a finding left out is not scanned", () => {
    const token = "ghp_" + "x".repeat(36);
    expect(() => md([note({ status: "dismissed", body: token })])).not.toThrow();
  });
});

// ── the two entry points, with a spy for GitHub ─────────────────────────────

function spyDeps(comments: PrCommentRef[] = [], over: Partial<{ viewer: string; headSha: string; createFails: boolean }> = {}) {
  const calls = { create: [] as string[], edit: [] as { id: string; body: string }[] };
  const deps: PublishDeps = {
    read: async () => ({ ok: true, comments, viewer: over.viewer ?? "acme-user", headSha: over.headSha ?? run.sha }),
    create: async (body) => { calls.create.push(body); return over.createFails ? { ok: false, error: "HTTP 403" } : { ok: true, url: "https://github.com/acme/orbit/pull/1042#issuecomment-9" }; },
    edit: async (id, body) => { calls.edit.push({ id, body }); return { ok: true }; },
  };
  return { deps, calls };
}
const req = (notes: PrNote[], o: Partial<PublishOptions> = {}) => ({ plugin: P, repo: REPO, number: 1042, run, notes, options: opts(o) });
const existingComment = (over: Partial<PrCommentRef> = {}): PrCommentRef => ({ nodeId: "IC_old", author: "acme-user", body: `old\n\n${reviewMarker(P)}`, url: "https://github.com/acme/orbit/pull/1042#issuecomment-1", ...over });

describe("preview", () => {
  test("is read-only: it reads, writes nothing, and finds the existing comment", async () => {
    const { deps, calls } = spyDeps([existingComment()]);
    const r = await previewReview(req([crit]), deps);
    expect(r.ok && r.existing).toEqual({ commentId: "IC_old", url: "https://github.com/acme/orbit/pull/1042#issuecomment-1" });
    expect(calls.create).toHaveLength(0);
    expect(calls.edit).toHaveLength(0);
  });
  test("stale when the head moved, with the open count", async () => {
    const r = await previewReview(req([crit, low, resolved]), spyDeps([], { headSha: "ffffffffffffffffffffffffffffffffffffffff" }).deps);
    expect(r.ok && r.stale).toBe(true);
    expect(r.ok && r.openCount).toBe(2);
    expect((await previewReview(req([crit]), spyDeps().deps)).ok && (await previewReview(req([crit]), spyDeps().deps) as { stale: boolean }).stale).toBe(false);
  });
  test("only the signed-in user's own marked comment counts", () => {
    expect(findPublished([existingComment({ author: "someone-else" })], P, "acme-user")).toBeNull();
    expect(findPublished([existingComment({ body: "no marker" })], P, "acme-user")).toBeNull();
    expect(findPublished([existingComment({ body: reviewMarker("other-plugin") })], P, "acme-user")).toBeNull();
    expect(findPublished([existingComment()], P, "ACME-USER")?.nodeId).toBe("IC_old");
    expect(findPublished([existingComment()], P, "")).toBeNull();
  });
});

describe("publish", () => {
  test("creates the comment when none is there, and answers its url", async () => {
    const { deps, calls } = spyDeps();
    const r = await publishReview(req([crit]), undefined, deps);
    expect(r).toMatchObject({ ok: true, edited: false, url: "https://github.com/acme/orbit/pull/1042#issuecomment-9" });
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]!.endsWith(reviewMarker(P))).toBe(true);
    expect(calls.edit).toHaveLength(0);
  });
  test("edits the marked comment when it is found", async () => {
    const { deps, calls } = spyDeps([existingComment()]);
    const r = await publishReview(req([crit]), undefined, deps);
    expect(r).toMatchObject({ ok: true, edited: true, url: "https://github.com/acme/orbit/pull/1042#issuecomment-1" });
    expect(calls.create).toHaveLength(0);
    expect(calls.edit.map((e) => e.id)).toEqual(["IC_old"]);
  });
  test("a failing post is reported, nothing retries", async () => {
    const { deps, calls } = spyDeps([], { createFails: true });
    const r = await publishReview(req([crit]), undefined, deps);
    expect(r).toEqual({ ok: false, error: "HTTP 403" });
    expect(calls.create).toHaveLength(1);
  });
  test("a deps that throws is a failed post", async () => {
    const { deps } = spyDeps();
    deps.create = async () => { throw new Error("gh not found"); };
    expect(await publishReview(req([crit]), undefined, deps)).toEqual({ ok: false, error: "gh not found" });
  });
  test("one request at a time per pull request", async () => {
    const { deps } = spyDeps();
    let release!: () => void;
    deps.create = () => new Promise((res) => { release = () => res({ ok: true, url: "u" }); });
    const first = publishReview(req([crit]), undefined, deps);
    await Bun.sleep(5);
    expect(await publishReview(req([crit]), undefined, spyDeps().deps)).toMatchObject({ ok: false, error: expect.stringContaining("already being posted") });
    release();
    expect((await first).ok).toBe(true);
    expect((await publishReview(req([crit]), undefined, spyDeps().deps)).ok).toBe(true);
  });
  test("edited markdown is re-validated: marker re-appended, size and credentials checked", async () => {
    const { deps, calls } = spyDeps();
    const ok = await publishReview(req([crit]), "My own words, no marker.", deps);
    expect(ok.ok).toBe(true);
    expect(calls.create[0]).toBe(`My own words, no marker.\n\n${reviewMarker(P)}`);
    const moved = checkEdited(`text\n${reviewMarker(P)}\nmore`, P);
    expect(moved.ok && moved.markdown).toBe(`text\n\nmore\n\n${reviewMarker(P)}`);
    expect(checkEdited("x".repeat(PUBLISH_MAX_CHARS), P).ok).toBe(false);
    expect(checkEdited("   ", P).ok).toBe(false);
    const token = "ghp_" + "x".repeat(36);
    const bad = await publishReview(req([crit]), `hi ${token}`, spyDeps().deps);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain(token);
  });
  test("the module has no approval and no change request in it", async () => {
    const src = (await Bun.file(join(import.meta.dir, "../src/review-publish.ts")).text()).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/submitReview|--approve|request_changes|APPROVE/);
  });
});

describe("the run record", () => {
  const base = { id: "run-7", repo: REPO, number: 1042, state: "done", title: "Local review" };
  test("agent and model are accepted, sanitized, bounded; absent is fine", () => {
    const ok = validateRun({ ...base, agent: "  <b>claude</b>\u0000  code ", model: "claude-sonnet-5-5" });
    expect(ok.ok && ok.value).toMatchObject({ agent: "claude code", model: "claude-sonnet-5-5" });
    const long = validateRun({ ...base, agent: "a".repeat(100), model: "m".repeat(200) });
    expect(long.ok && long.value.agent).toHaveLength(40);
    expect(long.ok && long.value.model).toHaveLength(80);
    const none = validateRun({ ...base, agent: "   ", model: 5 });
    expect(none.ok && none.value.agent).toBeUndefined();
    expect(none.ok && none.value.model).toBeUndefined();
    expect(validateRun(base).ok).toBe(true);
  });
  test("a plugin cannot send `published`", () => {
    const r = validateRun({ ...base, published: { at: 1, url: "https://example.test" } });
    expect(r.ok && r.value.published).toBeUndefined();
  });
});

describe("the door and the gate", () => {
  test("the action is refused for agents, with a reason, and has no door", () => {
    expect(UI_REFUSED_FOR_AGENTS["pr.review.publish"]).toContain("their own click");
    for (const id of Object.keys(UI_REFUSED_FOR_AGENTS)) expect(Object.keys(UI_ACTIONS), id).not.toContain(id);
    expect(Object.keys(UI_ACTIONS).filter((k) => /publish/i.test(k))).toEqual([]);
  });

  test("GUARD: the publish route asks mayPublishReview before it reads the body", async () => {
    const src = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const fn = src.slice(src.indexOf("function mayPublishReview("), src.indexOf("}\n", src.indexOf("function mayPublishReview(")));
    expect(fn).toContain('req.headers.get("x-agentglass-agent")');
    expect(fn).toContain("mayChangePolicy(req, caller)");
    const start = src.indexOf('if ((pathname === "/plugins/pr-notes/publish-preview"');
    const route = src.slice(start, src.indexOf('if (pathname === "/plugins/pr-notes/cost"', start));
    expect(route.indexOf("mayPublishReview(req, caller)")).toBeGreaterThan(0);
    expect(route.indexOf("mayPublishReview(req, caller)")).toBeLessThan(route.indexOf("req.json()"));
    // The one place a review reaches GitHub is these two calls, behind that gate.
    expect(route.match(/addComment\(/g)).toHaveLength(1);
    expect(route.match(/editComment\(/g)).toHaveLength(1);
    expect(route).not.toMatch(/submitReview/);
    // Nothing else in the plugin routes may call the review publisher.
    expect(src.match(/publishReview\(/g)).toHaveLength(1);
  });

  describe("on a booted server", () => {
    let dir = "", base = "", proc: ReturnType<typeof Bun.spawn> | null = null;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "agx-publish-review-"));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      proc = Bun.spawn(["bun", "run", new URL("../src/index.ts", import.meta.url).pathname], {
        env: {
          PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
          TMUX_TMPDIR: TMUX_TEST_TMPDIR, HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"),
          AGENTGLASS_STATE_DIR: `${dir}/state`, CLAUDE_CONFIG_DIR: join(dir, ".claude"), AGENTGLASS_ROOT: dir,
          AGENTGLASS_DB: join(dir, "f.db"), AGENTGLASS_SCAN_DISABLED: "1", AGENTGLASS_PORT: String(port),
        },
        stdout: "ignore", stderr: "pipe",
      });
      for (let i = 0; i < 150; i++) {
        try { if ((await fetch(base + "/health")).ok) return; } catch { /* not up yet */ }
        await Bun.sleep(100);
      }
      throw new Error("the server did not come up: " + (await new Response(proc.stderr as ReadableStream).text()).slice(0, 400));
    }, SERVER_BOOT_MS);
    afterAll(() => {
      try { proc?.kill(); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    });

    const body = JSON.stringify({ plugin: P, repo: REPO, number: 1042, root: dir });
    const post = (path: string, headers: Record<string, string>) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

    for (const path of ["/plugins/pr-notes/publish-preview", "/plugins/pr-notes/publish"]) {
      test(`${path}: a caller with no window origin (an agent's shell, a plugin) is refused`, async () => {
        const r = await post(path, {});
        expect(r.status).toBe(403);
      });
      test(`${path}: a request presenting an agent's name is refused even from a window origin`, async () => {
        const r = await post(path, { origin: "http://127.0.0.1:5173", "x-agentglass-agent": "bug-fixer" });
        expect(r.status).toBe(403);
      });
      test(`${path}: the window gets past the gate (and is stopped by the missing review)`, async () => {
        const r = await post(path, { origin: "http://127.0.0.1:5173" });
        expect(r.status).toBe(404);
      });
    }
  });
});
