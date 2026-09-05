/*
 * Most sessions have no name.
 *
 * `custom_title` is a rename by hand and `ai_title` is one the agent generated,
 * and both come from lines Claude Code writes into the transcript. A session
 * that never got one shows its own uuid forever — which on a real machine is
 * most of them, and a phone list of thirty rows reading `agentglass:cd3fa401`
 * cannot be scanned by eye at all.
 *
 * The first thing you typed has been in the database the whole time: every
 * prompt is ingested as a `UserPromptSubmit` event. So the rollup carries it,
 * which also means sessions recorded long before this existed get named.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-names-"));
const ROOT = join(dir, "proj");
mkdirSync(ROOT, { recursive: true });
process.env.AGENTGLASS_DB = join(dir, "names.db");
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_ROOT = ROOT;

let db: typeof import("../src/db.ts");
const T0 = Date.now() - 3_600_000;

const event = (over: Record<string, unknown> = {}) => ({
  source_app: "proj",
  session_id: "s1",
  hook_event_type: "PostToolUse",
  tool_name: "Bash",
  tool_use_id: null,
  agent_id: null,
  agent_type: null,
  model_name: "claude-opus-5",
  is_error: 0,
  error_text: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_tokens: 0, cache_read_tokens: 0 },
  usage_is_cumulative: false,
  summary: "x",
  timestamp: T0,
  payload: { project_path: ROOT },
  chat: null,
  ...over,
});

const prompt = (session_id: string, text: string, timestamp: number) =>
  event({ session_id, hook_event_type: "UserPromptSubmit", tool_name: null, timestamp,
          payload: { project_path: ROOT, prompt: text } });

beforeAll(async () => {
  db = await import("../src/db.ts");

  // Two prompts, out of order on the way in — the FIRST is the name.
  db.insertEvent(prompt("s1", "And now make it instant", T0 + 2_000) as any);
  db.insertEvent(prompt("s1", "Rework the companion", T0 + 1_000) as any);
  db.insertEvent(event({ session_id: "s1", timestamp: T0 + 3_000 }) as any);

  // Named by hand: does not need one, and must not be given one.
  db.insertEvent(prompt("s2", "Something I typed", T0 + 1_000) as any);
  db.insertEvent(event({ session_id: "s2", timestamp: T0 + 2_000 }) as any);
  db.setSessionTitles("s2", "Nightly sweep", null);

  // No prompt at all — a hook-only session. Nothing to invent.
  db.insertEvent(event({ session_id: "s3", timestamp: T0 + 1_000 }) as any);

  // A payload that is not readable as JSON must not take a session down with it.
  db.insertEvent(event({ session_id: "s4", hook_event_type: "UserPromptSubmit",
    tool_name: null, timestamp: T0 + 1_000, payload: { project_path: ROOT } }) as any);
});

/**
 * `bun test` shares one process, so another suite's module-level
 * `AGENTGLASS_ROOT` can be the one in force by the time these run — and
 * getSessions scopes by it, which silently removes every row here. config()
 * keys its cache on the value asked for, so re-asserting it at read time is
 * enough to get our own scope back. The alternative was asserting on rows that
 * a leaked scope had already filtered out, which is how a passing test can
 * mean nothing.
 */
const bySession = () => {
  process.env.AGENTGLASS_ROOT = ROOT;
  return new Map(db.getSessions(50).map((s) => [s.session_id, s]));
};

describe("the rollup carries what the session was first asked to do", () => {
  test("the earliest prompt wins, not the most recent", () => {
    expect(bySession().get("s1")?.first_prompt).toBe("Rework the companion");
  });

  test("a session with a title is not given one", () => {
    // It would be work thrown away, and the title is the better name anyway.
    const s2 = bySession().get("s2");
    expect(s2?.custom_title).toBe("Nightly sweep");
    expect(s2?.first_prompt).toBeFalsy();
  });

  test("a session that never prompted gets nothing rather than a guess", () => {
    expect(bySession().get("s3")?.first_prompt).toBeFalsy();
  });

  test("a prompt-shaped event with no prompt in it is skipped", () => {
    expect(bySession().get("s4")?.first_prompt).toBeFalsy();
  });

  test("the detail carries the name too, not just the list", () => {
    /*
     * The type declared custom_title, ai_title and first_prompt on
     * SessionDetail since it was written, and getSession never filled any of
     * them in — so sessionTitle(detail) had nothing to work with and every
     * conversation header showed a uuid, next to a list row showing the real
     * name. Nothing caught it because nothing asserted on the detail's title,
     * and it took opening the app to see.
     */
    const named = db.getSession("s2");
    expect(named?.custom_title).toBe("Nightly sweep");
    // A titled session does not also carry a prompt: same rule as the list.
    expect(named?.first_prompt).toBeFalsy();

    const nameless = db.getSession("s1");
    expect(nameless?.custom_title).toBeFalsy();
    expect(nameless?.first_prompt).toBe("Rework the companion");
  });

  test("every session still comes back", () => {
    // The lookup is a second query merged onto the page; a session missing a
    // prompt must not fall out of the list because of it.
    const ids = [...bySession().keys()].sort();
    expect(ids).toEqual(["s1", "s2", "s3", "s4"]);
  });
});

/*
 * THE SAME NAME, FOR A HANDFUL OF IDS RATHER THAN A WHOLE PAGE.
 *
 * `sessionNames` was written for the Lantern, whose "seen" rows had
 * nothing to call themselves but a raw tmux pane id — a hook carries a
 * `sessionId`, and this is what turns that into the same name
 * `getSessions`/`getSession` already draw the rest of the app's lists with.
 */
describe("sessionNames", () => {
  test("a rename wins over everything else", () => {
    expect(db.sessionNames(["s2"]).get("s2")).toBe("Nightly sweep");
  });

  test("the first prompt, when there is no title", () => {
    expect(db.sessionNames(["s1"]).get("s1")).toBe("Rework the companion");
  });

  test("nothing for a session with neither — the pane id stays the pane id", () => {
    expect(db.sessionNames(["s3"]).has("s3")).toBe(false);
  });

  test("several ids in one call, each answered on its own rule", () => {
    const names = db.sessionNames(["s1", "s2", "s3"]);
    expect(names.get("s1")).toBe("Rework the companion");
    expect(names.get("s2")).toBe("Nightly sweep");
    expect(names.has("s3")).toBe(false);
  });

  test("an empty list costs no query and answers empty", () => {
    expect(db.sessionNames([]).size).toBe(0);
  });

  test("an id nobody has heard of is simply absent, not an error", () => {
    expect(db.sessionNames(["never-seen"]).size).toBe(0);
  });
});

/*
 * WHO IS STOPPED ON A PERSON, written the moment the hook says so.
 *
 * Lantern greps the screen for "your approval" / "waiting on you". Claude Code
 * fires a Notification hook when it stops for a person — and that hook is the
 * ONLY place the fact exists for a session the scanner owns: /ingest answers
 * those before inserting, and the transcript carries no hook-only
 * notifications. So the wait is noted from the hook stream itself, and ended
 * by whatever the session does next.
 */
describe("noteWaitFromHook / latestWaits", () => {
  const T1 = T0 + 10_000;
  const hook = (session_id: string, hook_event_type: string, message?: string) =>
    ({ session_id, hook_event_type, payload: message ? { message } : {} });

  test("a permission nobody answered is a wait, and a blockage", () => {
    db.noteWaitFromHook(hook("w-perm", "Notification", "Claude needs your permission to use Bash"), T1);
    const w = db.latestWaits(["w-perm"]).get("w-perm");
    expect(w).toEqual({ kind: "permission", why: "Claude needs your permission to use Bash", since: T1 });
  });

  test("a turn that ended is a wait of the other kind", () => {
    db.noteWaitFromHook(hook("w-input", "Notification", "Claude is waiting for your input"), T1);
    expect(db.latestWaits(["w-input"]).get("w-input")?.kind).toBe("input");
  });

  test("a session that does anything after is not waiting, whatever it said", () => {
    db.noteWaitFromHook(hook("w-moved", "Notification", "Claude needs your permission to use Bash"), T1);
    db.noteWaitFromHook(hook("w-moved", "PostToolUse"), T1 + 5_000);
    expect(db.latestWaits(["w-moved"]).has("w-moved")).toBe(false);
  });

  test("a notification that is merely news neither starts nor ends a wait", () => {
    db.noteWaitFromHook(hook("w-news", "Notification", "usage limit reset at 14:00"), T1);
    expect(db.latestWaits(["w-news"]).has("w-news")).toBe(false);
    db.noteWaitFromHook(hook("w-keep", "Notification", "Claude needs your approval"), T1);
    db.noteWaitFromHook(hook("w-keep", "Notification", "usage limit reset at 14:00"), T1 + 1);
    expect(db.latestWaits(["w-keep"]).get("w-keep")?.kind).toBe("permission");
  });

  test("a session with no wait, an unknown session, and an empty ask answer empty", () => {
    expect(db.latestWaits(["never-seen"]).size).toBe(0);
    expect(db.latestWaits([]).size).toBe(0);
    db.noteWaitFromHook(hook("unknown", "Notification", "Claude needs your permission"), T1);
    expect(db.latestWaits(["unknown"]).size).toBe(0);
  });

  test("several at once, each on its own newest event", () => {
    const m = db.latestWaits(["w-perm", "w-input", "w-moved", "s1"]);
    expect([...m.keys()].sort()).toEqual(["w-input", "w-perm"]);
  });
});

/*
 * A NAME A PERSON COULD RECOGNISE, not whatever arrived first.
 *
 * On the first real Lantern, three rows read `<cross-session-message …>` and
 * one read `/model`: the earliest prompt of those sessions was a message from
 * another session or a slash command, and `firstPrompts` takes the earliest.
 * The sessions page keeps that rule; the Lantern walks past those to the
 * first prompt somebody typed as a request.
 */
describe("sessionNames skips prompts that are not a name", () => {
  beforeAll(() => {
    db.insertEvent(prompt("n-tag", '<cross-session-message from="uds:/run/x.sock">hola</cross-session-message>', T0 + 1_000) as any);
    db.insertEvent(prompt("n-tag", "Arregla el scroll del panel", T0 + 2_000) as any);
    db.insertEvent(prompt("n-cmd", "/model", T0 + 1_000) as any);
    db.insertEvent(prompt("n-cmd", "sí", T0 + 2_000) as any);
    db.insertEvent(prompt("n-cmd", "Revisa la PR #264", T0 + 3_000) as any);
    db.insertEvent(prompt("n-none", "/clear", T0 + 1_000) as any);
  });

  test("a cross-session tag is not a name; the next real prompt is", () => {
    expect(db.sessionNames(["n-tag"]).get("n-tag")).toBe("Arregla el scroll del panel");
  });

  test("a slash command and a bare 'sí' are skipped too", () => {
    expect(db.sessionNames(["n-cmd"]).get("n-cmd")).toBe("Revisa la PR #264");
  });

  test("a session with nothing better keeps no name — the pane id is more honest", () => {
    expect(db.sessionNames(["n-none"]).has("n-none")).toBe(false);
  });

  test("a title still wins over any prompt", () => {
    expect(db.sessionNames(["s2"]).get("s2")).toBe("Nightly sweep");
  });
});
