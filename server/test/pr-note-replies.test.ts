/*
 * Replies under a plugin's findings. The storage and the event are exercised
 * through plugin-ui.ts against a private notes file. A reply never leaves
 * the machine; the guards below say so.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunning } from "../src/plugins.ts"; // imported first: the cycle plugins.ts <-> plugin-ui.ts resolves only from this side
import {
  __setPluginNotesPath, answerNote, dropNotesOf, notesFor, setLivenessCheck, setNoteStatus, takeEvents, upsertNotes,
  type NoteAnswer,
} from "../src/plugin-ui.ts";
import { REPLY_MAX_CHARS, REPLIES_PER_NOTE, type Contributes } from "../../shared/pluginUi.ts";

const C = { prNotes: true } as Contributes;
const P = "acme-review";
const REPO = "acme/orbit";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agx-note-replies-"));
  __setPluginNotesPath(join(dir, "plugin-notes.json"));
  // No plugin process here; events are dropped for one that is not running.
  setLivenessCheck(() => true);
});
afterAll(() => {
  __setPluginNotesPath(null);
  setLivenessCheck((name) => isRunning(name)); // what plugins.ts installs
  rmSync(dir, { recursive: true, force: true });
});

function seed(id = "f-1", extra: Record<string, unknown> = {}) {
  const r = upsertNotes(P, C, [{ id, repo: REPO, number: 1042, severity: "critical", title: "Guard runs after the loop", path: "src/a.ts", line: 10, ...extra }]);
  expect(r.ok).toBe(true);
}
const stored = (id = "f-1") => notesFor(REPO, 1042)!.notes.find((n) => n.id === id)!;

const as = (over: Partial<NoteAnswer>): NoteAnswer => ({ by: "user", ...over });

beforeEach(async () => {
  dropNotesOf(P);
  await takeEvents(P, 0);
  seed();
});

describe("storing a reply", () => {
  test("reply only: the status stays, the reply is kept with the note", async () => {
    const r = await answerNote(P, "f-1", as({ reply: { text: "Checking this one." } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("open");
    expect(r.replies).toHaveLength(1);
    expect(stored().replies?.[0]).toMatchObject({ text: "Checking this one.", by: "user" });
    expect(stored().replies?.[0]?.withStatus).toBeUndefined();
    expect(stored().status).toBe("open");
  });

  test("reply + resolve and reply + dismiss are one request each", async () => {
    await answerNote(P, "f-1", as({ status: "resolved", reply: { text: "Fixed in 3f9a2c1." } }));
    expect(stored()).toMatchObject({ status: "resolved", statusBy: "person" });
    expect(stored().replies?.[0]?.withStatus).toBe("resolved");
    seed("f-2");
    await answerNote(P, "f-2", as({ status: "dismissed", reply: { text: "Intentional until v2." } }));
    expect(stored("f-2").status).toBe("dismissed");
    expect(stored("f-2").replies?.[0]?.withStatus).toBe("dismissed");
  });

  test("replies are oldest first and survive Reopen and the plugin sending the finding again", async () => {
    await answerNote(P, "f-1", as({ reply: { text: "one" } }));
    await answerNote(P, "f-1", as({ status: "resolved", reply: { text: "two" } }));
    expect(setNoteStatus(P, "f-1", "open").ok).toBe(true);
    seed(); // the plugin's next pass sends the same finding again
    expect(stored().status).toBe("open");
    expect(stored().replies?.map((x) => x.text)).toEqual(["one", "two"]);
  });

  test("an agent reply carries its name", async () => {
    await answerNote(P, "f-1", as({ by: "agent:bug-fixer", reply: { text: "On it." } }));
    expect(stored().replies?.[0]?.by).toBe("agent:bug-fixer");
  });

  test("removing the plugin removes its replies", async () => {
    await answerNote(P, "f-1", as({ reply: { text: "x" } }));
    dropNotesOf(P);
    expect(notesFor(REPO, 1042)!.notes).toHaveLength(0);
  });
});

describe("limits and cleaning", () => {
  test("4000 characters fit, 4001 are refused, nothing is stored", async () => {
    expect((await answerNote(P, "f-1", as({ reply: { text: "a".repeat(REPLY_MAX_CHARS) } }))).ok).toBe(true);
    const over = await answerNote(P, "f-1", as({ reply: { text: "a".repeat(REPLY_MAX_CHARS + 1) } }));
    expect(over.ok).toBe(false);
    expect(stored().replies).toHaveLength(1);
  });

  test("50 replies per finding, the 51st is refused", async () => {
    for (let i = 0; i < REPLIES_PER_NOTE; i++) expect((await answerNote(P, "f-1", as({ reply: { text: `r${i}` } }))).ok).toBe(true);
    const r = await answerNote(P, "f-1", as({ reply: { text: "one too many" } }));
    expect(r.ok).toBe(false);
    expect(stored().replies).toHaveLength(REPLIES_PER_NOTE);
  });

  test("tags and control characters are stripped, newlines kept", async () => {
    await answerNote(P, "f-1", as({ reply: { text: "  ok <script>alert(1)</script> <b>bold</b>\u0000\u0007 line\r\nnext  " } }));
    expect(stored().replies?.[0]?.text).toBe("ok alert(1) bold line\nnext");
  });

  test("bad input is refused: empty, whitespace, wrong types, nothing to do", async () => {
    for (const bad of [
      as({ reply: { text: "   " } }), as({ reply: { text: 5 } }), as({ reply: "hi" }), as({ reply: [] }),
    as({ status: "done" }), as({ status: 1 }), as({}),
      as({ by: "someone else", reply: { text: "x" } }),
    ]) {
      const r = await answerNote(P, "f-1", bad);
      expect(r.ok).toBe(false);
    }
    expect(stored().replies).toBeUndefined();
    expect(stored().status).toBe("open");
  });

  test("a finding that does not exist, or is on another pull request, is refused", async () => {
    expect((await answerNote(P, "nope", as({ reply: { text: "x" } }))).ok).toBe(false);
    expect((await answerNote("other-plugin", "f-1", as({ reply: { text: "x" } }))).ok).toBe(false);
    expect((await answerNote(P, "f-1", as({ repo: REPO, number: 7, reply: { text: "x" } }))).ok).toBe(false);
    expect((await answerNote(P, "f-1", as({ repo: "acme/other", number: 1042, reply: { text: "x" } }))).ok).toBe(false);
    expect((await answerNote(P, "f-1", as({ repo: REPO, reply: { text: "x" } }))).ok).toBe(false);
    expect((await answerNote(P, "f-1", as({ repo: REPO, number: 1042, reply: { text: "x" } }))).ok).toBe(true);
  });
});

describe("the note-status event", () => {
  test("a reply carries reply and replies next to what the event had", async () => {
    await answerNote(P, "f-1", as({ reply: { text: "first" } }));
    await takeEvents(P, 0);
    await answerNote(P, "f-1", as({ status: "resolved", reply: { text: "second" } }));
    const [ev] = (await takeEvents(P, 0)) as any[];
    expect(ev).toMatchObject({ type: "note-status", repo: REPO, number: 1042, id: "f-1", status: "resolved" });
    expect(typeof ev.at).toBe("number");
    expect(ev.reply).toMatchObject({ text: "second", by: "user", withStatus: "resolved" });
    expect(Object.keys(ev.reply).sort()).toEqual(["at", "by", "id", "text", "withStatus"]);
    expect(ev.replies.map((x: any) => x.text)).toEqual(["first", "second"]);
  });

  test("a status with no reply sends no `reply`; a finding with no replies sends neither", async () => {
    expect(setNoteStatus(P, "f-1", "resolved").ok).toBe(true);
    const [bare] = (await takeEvents(P, 0)) as any[];
    expect(Object.keys(bare).sort()).toEqual(["at", "id", "number", "repo", "status", "type"]);
    await answerNote(P, "f-1", as({ reply: { text: "x" } }));
    await takeEvents(P, 0);
    await answerNote(P, "f-1", as({ status: "open" }));
    const [statusOnly] = (await takeEvents(P, 0)) as any[];
    expect(statusOnly.reply).toBeUndefined();
    expect(statusOnly.replies).toHaveLength(1);
  });
});

describe("nothing here reaches GitHub", () => {
  test("GUARD: no reply route calls a GitHub poster, whatever the request says", async () => {
    const r = answerNote(P, "f-1", as({ reply: { text: "Fixed.", postToGitHub: true } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r).sort()).toEqual(["replies", "ok", "status"].sort());
    expect(stored().replies?.[0]).not.toHaveProperty("postedOnGitHub");
  });

  test("the status route and the plugin reply route never name the poster", async () => {
    const index = await Bun.file(join(import.meta.dir, "../src/index.ts")).text();
    const start = index.indexOf('if (pathname === "/plugins/pr-notes/status"');
    const route = index.slice(start, index.indexOf('if ((pathname === "/plugins/pr-notes/publish-preview"', start))
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(route).toContain("answerNote(");
    expect(route).not.toMatch(/addComment|editComment|prRepoIdFor|postToGitHub|mayPost/);
    const ui = (await Bun.file(join(import.meta.dir, "../src/plugin-ui.ts")).text()).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(ui).not.toMatch(/GitHubPoster|githubReplyBody|postToGitHub|mayPost|postedOnGitHub/);
  });
});
