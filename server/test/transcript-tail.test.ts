// The sweep reads only the bytes a transcript grew by — without losing anything
// the from-zero re-parse used to give it for free.
//
// The bug this guards: every 3s the scanner read each changed transcript whole,
// parsed every line, and only then skipped the ones it had already ingested.
// On an 86 MB session that is ~360ms of pure re-parse per tick, ~9% steady CPU,
// on the same single thread that pumps the terminal's PTY — which is why the
// terminal stuttered more the longer a session ran, and why restarting fixed it.
//
// Reading only the tail is easy; reading only the tail *and still* matching a
// tool result to a call made an hour ago, not double-counting a reply's tokens,
// noticing a rename that happened before the offset, coping with a rewritten
// file and with a line the writer has only half-flushed is the part that breaks.
// Each test below is one of those.
import { describe, expect, test, beforeAll } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-tail-"));
const PROJECTS = join(dir, "projects", "-tmp-tailproj");
mkdirSync(PROJECTS, { recursive: true });
// Sweep this fixture, never ~/.claude/projects. Read per sweep by the scanner,
// so this holds however the module got imported.
process.env.AGENTGLASS_PROJECTS_DIR = join(dir, "projects");
// Only set the DB if nothing has claimed one yet: `bun test` shares one process
// and db.ts opens its file at import, so an earlier test file may already own
// it. Sharing is fine — every assertion here is keyed by session id.
process.env.AGENTGLASS_DB ||= join(dir, "tail.db");

let db: typeof import("../src/db.ts");
let scan: typeof import("../src/transcripts.ts");
// A real directory the scanner will accept: it resolves a transcript's cwd on
// the filesystem, and if an earlier test file already pinned a workspace scope
// (config.ts caches it on first call) anything outside it is skipped.
let CWD = join(dir, "tailproj");

beforeAll(async () => {
  db = await import("../src/db.ts");
  scan = await import("../src/transcripts.ts");
  const scope = (await import("../src/config.ts")).workspaceRoot();
  if (scope) CWD = join(scope, "agx-tail-fixture");
  mkdirSync(CWD, { recursive: true });
});

const sweep = () => scan.scanOnce(null);

let clock = Date.now() - 60_000;
const ts = () => new Date((clock += 1000)).toISOString();

const path = (name: string) => join(PROJECTS, `${name}.jsonl`);
const write = (name: string, lines: string[]) =>
  writeFileSync(path(name), lines.map((l) => l + "\n").join(""));
const append = (name: string, lines: string[]) =>
  appendFileSync(path(name), lines.map((l) => l + "\n").join(""));

const prompt = (sid: string, text: string) =>
  JSON.stringify({
    type: "user",
    cwd: CWD,
    sessionId: sid,
    timestamp: ts(),
    message: { role: "user", content: text },
  });

const toolUse = (sid: string, id: string, name: string, msgId = `m-${id}`, usage?: unknown) =>
  JSON.stringify({
    type: "assistant",
    cwd: CWD,
    sessionId: sid,
    timestamp: ts(),
    message: {
      id: msgId,
      model: "claude-opus-4-8",
      role: "assistant",
      content: [{ type: "tool_use", id, name, input: { command: "ls" } }],
      ...(usage ? { usage } : {}),
    },
  });

const toolResult = (sid: string, id: string) =>
  JSON.stringify({
    type: "user",
    cwd: CWD,
    sessionId: sid,
    timestamp: ts(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

const rows = (sid: string) =>
  db.db
    .query<{ hook_event_type: string; tool_name: string | null; payload: string }, [string]>(
      "SELECT hook_event_type, tool_name, payload FROM events WHERE session_id = ? ORDER BY id"
    )
    .all(sid);

const prompts = (sid: string) =>
  rows(sid)
    .filter((r) => r.hook_event_type === "UserPromptSubmit")
    .map((r) => JSON.parse(r.payload).prompt as string);

const progress = (name: string) =>
  db.db
    .query<{ lines_done: number }, [string]>("SELECT lines_done FROM transcript_files WHERE path = ?")
    .get(path(name));

describe("incremental transcript sweep", () => {
  test("an appended line is ingested exactly once", async () => {
    const sid = "s-append";
    write("append", [prompt(sid, "one"), prompt(sid, "two")]);
    await sweep();
    expect(prompts(sid)).toEqual(["one", "two"]);

    append("append", [prompt(sid, "three")]);
    await sweep();
    // A tail read that forgot the offset would re-ingest "one"/"two"; one that
    // over-advanced it would drop "three".
    expect(prompts(sid)).toEqual(["one", "two", "three"]);

    // Unchanged file: the sweep must not manufacture anything on a re-run.
    await sweep();
    expect(prompts(sid)).toEqual(["one", "two", "three"]);
    expect(progress("append")?.lines_done).toBe(3);
  });

  test("a tool result resolves the name of a call made in an earlier sweep", async () => {
    const sid = "s-pair";
    write("pair", [toolUse(sid, "t1", "Bash")]);
    await sweep();

    // The call is now far behind the byte offset. Its name and input live only
    // in the carried-over map; losing them empties tool_input, which is what the
    // diff list and repo discovery read off the PostToolUse.
    append("pair", [toolResult(sid, "t1")]);
    await sweep();

    const post = rows(sid).find((r) => r.hook_event_type === "PostToolUse");
    expect(post?.tool_name).toBe("Bash");
    expect(JSON.parse(post!.payload).tool_input).toEqual({ command: "ls" });
  });

  test("one reply's usage is not counted twice when its lines span sweeps", async () => {
    const sid = "s-usage";
    const usage = { input_tokens: 100, output_tokens: 10 };
    // Claude Code repeats the identical usage on every content-block line of the
    // same message.id. The dedupe set has to survive the sweep boundary or the
    // second line re-adds the whole reply's tokens.
    write("usage", [toolUse(sid, "u1", "Bash", "msg-shared", usage)]);
    await sweep();
    append("usage", [toolUse(sid, "u2", "Bash", "msg-shared", usage)]);
    await sweep();

    const s = db.db
      .query<{ input_tokens: number; output_tokens: number }, [string]>(
        "SELECT input_tokens, output_tokens FROM sessions WHERE session_id = ?"
      )
      .get(sid);
    expect(s?.input_tokens).toBe(100);
    expect(s?.output_tokens).toBe(10);
  });

  test("a rename appended after the offset is picked up", async () => {
    const sid = "s-title";
    write("title", [prompt(sid, "hello")]);
    await sweep();

    append("title", [JSON.stringify({ type: "custom-title", customTitle: "Ship the thing" })]);
    await sweep();
    expect(
      db.db
        .query<{ custom_title: string | null }, [string]>(
          "SELECT custom_title FROM sessions WHERE session_id = ?"
        )
        .get(sid)?.custom_title
    ).toBe("Ship the thing");

    // And a rename that happened *before* the offset must still be the name
    // after a later append that carries no title line at all.
    append("title", [prompt(sid, "more")]);
    await sweep();
    expect(
      db.db
        .query<{ custom_title: string | null }, [string]>(
          "SELECT custom_title FROM sessions WHERE session_id = ?"
        )
        .get(sid)?.custom_title
    ).toBe("Ship the thing");
  });

  test("a rewritten, shorter file is re-read whole", async () => {
    const sid = "s-rewrite";
    write("rewrite", [prompt(sid, "aaaaaaaaaaaaaaaaaaaa"), prompt(sid, "bbbbbbbbbbbbbbbbbbbb"), prompt(sid, "cccccccccccccccccccc")]);
    await sweep();
    expect(prompts(sid).length).toBe(3);

    // Fewer bytes than before: the saved offset now points past EOF, and every
    // line it names is different content. Tailing here would ingest nothing and
    // leave the session showing records that no longer exist on disk.
    write("rewrite", [prompt(sid, "rw-1"), prompt(sid, "rw-2")]);
    await sweep();
    const after = prompts(sid);
    expect(after).toContain("rw-1");
    expect(after).toContain("rw-2");
    expect(progress("rewrite")?.lines_done).toBe(2);
  });

  test("a half-written final line is held back, then ingested exactly once", async () => {
    const sid = "s-partial";
    const full = prompt(sid, "complete-at-last");
    const cut = Math.floor(full.length / 2);
    write("partial", [prompt(sid, "first")]);
    // The writer got half the record out and no newline — exactly what a sweep
    // landing mid-append sees. Counting it as done loses the record for good.
    appendFileSync(path("partial"), full.slice(0, cut));
    await sweep();
    expect(prompts(sid)).toEqual(["first"]);
    expect(progress("partial")?.lines_done).toBe(1);

    appendFileSync(path("partial"), full.slice(cut) + "\n");
    await sweep();
    expect(prompts(sid)).toEqual(["first", "complete-at-last"]);

    await sweep();
    expect(prompts(sid)).toEqual(["first", "complete-at-last"]);
  });

  test("a final record with no trailing newline is not stranded", async () => {
    // A finished transcript whose last line lacks its newline would otherwise
    // never be ingested, because the tail cut always held it back.
    const sid = "s-nonewline";
    writeFileSync(path("nonewline"), prompt(sid, "only") + "\n" + prompt(sid, "last"));
    await sweep();
    expect(prompts(sid)).toEqual(["only", "last"]);

    // And appending the missing newline plus another record must not re-ingest
    // the line we already took.
    appendFileSync(path("nonewline"), "\n" + prompt(sid, "next") + "\n");
    await sweep();
    expect(prompts(sid)).toEqual(["only", "last", "next"]);
  });

  test("a cold cache with a warm database ingests only the new lines", async () => {
    // What a server restart looks like: the byte offset is gone (it is memory
    // only, by design), the durable lines_done is not. The full re-read must
    // still skip exactly what it already has.
    const sid = "s-cold";
    write("cold", [prompt(sid, "c1"), prompt(sid, "c2")]);
    await sweep();
    scan.__dropTailCache();
    append("cold", [prompt(sid, "c3")]);
    await sweep();
    expect(prompts(sid)).toEqual(["c1", "c2", "c3"]);
  });
});
