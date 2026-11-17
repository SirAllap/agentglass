/*
 * A guide card can carry a draft for the text field it points at
 * (`--suggest`). This follows it from the real CLI's body, through the
 * relay's checks, to the activity the panel draws the card from, and the
 * person's insert back to the agent as news that does not end the step. The
 * card and the insert itself are in web/test/browser-guide-suggest.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setBrowserAsker, askBrowser, parseAsk, resetBrowserDrive, type BrowserAsk, type BrowserReply } from "../src/browserdrive.ts";
import { resetGuides, setGuideClock } from "../src/browserGuide.ts";

const CLI = join(import.meta.dir, "../../bin/agentglass-browser");
const PY = Bun.which("python3");
const DRAFT = "Thanks for the review.\nI moved the check into the hook, as you asked.";

describe.skipIf(!PY)("the CLI puts --copy in the point body", () => {
  let dir = "";
  let relay: ReturnType<typeof Bun.serve> | null = null;
  const sent: Array<{ op: string; body: Record<string, unknown> }> = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agx-guide-suggest-"));
    relay = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const op = new URL(req.url).pathname.split("/").pop() ?? "";
        let body: Record<string, unknown> = {};
        try { body = (await req.json()) as Record<string, unknown>; } catch { /* none */ }
        sent.push({ op, body });
        return Response.json({ ok: true, value: { step: 1, followed: true } });
      },
    });
  });
  afterAll(() => { relay?.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const run = async (...argv: string[]) => {
    const p = Bun.spawn({
      cmd: [PY!, CLI, "--page", "t1-ab01", ...argv],
      env: {
        PATH: process.env.PATH ?? "", HOME: dir, XDG_CONFIG_HOME: dir, XDG_DATA_HOME: dir, XDG_CACHE_HOME: dir,
        AGENTGLASS_STATE_DIR: join(dir, "state"), AGENTGLASS_BROWSER_STATE_DIR: join(dir, "bstate"),
        AGENTGLASS_SERVER: `http://127.0.0.1:${relay!.port}`, AGENTGLASS_TOKEN: "orbit-token",
        AGENTGLASS_BROWSER_AS: "orbit-keys", AGENTGLASS_AGENT_NAME: "orbit-keys",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  };

  test("a multi-line draft arrives verbatim", async () => {
    sent.length = 0;
    const r = await run("point", "e14", "--say", "Here is a reply you can edit.", "--suggest", DRAFT);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(sent.find((x) => x.op === "point")!.body).toMatchObject({ selector: "e14", say: "Here is a reply you can edit.", suggest: DRAFT });
  });

  test("no --suggest, no suggest field", async () => {
    sent.length = 0;
    expect((await run("point", "e14", "--say", "Click it.")).code).toBe(0);
    expect("suggest" in sent.find((x) => x.op === "point")!.body).toBe(false);
  });
});

describe("the relay carries suggest to the card", () => {
  let seen: BrowserAsk[] = [];
  let nextEvents: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    resetBrowserDrive(); resetGuides(); seen = []; nextEvents = [];
    setGuideClock(() => Date.parse("2026-11-13T15:02:00"));
    __setBrowserAsker(async (a): Promise<BrowserReply> => {
      seen.push(a);
      if (a.op === "tabs") return { ok: true, value: [{ id: "t1", active: true }] };
      if (a.op === "point") return { ok: true, value: { followed: true } };
      if (a.op === "guide" && a.args.action === "next") return { ok: true, value: nextEvents.shift() ?? { event: null } };
      return { ok: true, value: {} };
    });
  });
  afterEach(() => { __setBrowserAsker(null); setGuideClock(null); resetBrowserDrive(); });
  const ask = async (op: string, body: Record<string, unknown>): Promise<BrowserReply> => {
    const p = parseAsk(op, body);
    if ("error" in p) return { ok: false, error: p.error };
    return askBrowser(p.ask);
  };
  const start = () => ask("guide", { action: "start", why: "Reply to the review", as: "orbit-keys", page: "t1" });
  const activity = () => seen.find((a) => a.op === "point")!.args.activity as Record<string, unknown>;

  test("suggest rides on the point's activity, as given", async () => {
    await start();
    expect((await ask("point", { selector: "e14", say: "Edit and send.", suggest: DRAFT, as: "orbit-keys" })).ok).toBe(true);
    expect(activity()).toMatchObject({ kind: "guide", phase: "point", say: "Edit and send.", suggest: DRAFT });
  });

  test("no suggest, nothing on the activity", async () => {
    await start();
    expect((await ask("point", { selector: "e14", say: "Click it.", as: "orbit-keys" })).ok).toBe(true);
    expect("suggest" in activity()).toBe(false);
  });

  test("2000 characters fit; 2001 are refused with a sentence that says what to do", async () => {
    await start();
    expect((await ask("point", { selector: "e1", say: "x", suggest: "a".repeat(2000), as: "orbit-keys" })).ok).toBe(true);
    const r = await ask("point", { selector: "e1", say: "x", suggest: "a".repeat(2001), as: "orbit-keys" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("suggest is 2001 characters; at most 2000 fit on a guide card. Shorten the draft");
  });

  test("suggest that is not text, or only blanks, is refused", async () => {
    await start();
    for (const suggest of [42, "   ", ""]) {
      expect((await ask("point", { selector: "e1", say: "x", suggest, as: "orbit-keys" })).error).toMatch(/suggest is the draft/);
    }
  });

  test("suggest-inserted reaches the agent and the step stays open for its answer", async () => {
    await start();
    await ask("point", { selector: "e14", say: "Edit and send.", suggest: DRAFT, as: "orbit-keys" });
    nextEvents = [{ event: "suggest-inserted" }, { event: "ok" }];
    const first = await ask("guide", { action: "next", as: "orbit-keys", page: "t1" });
    expect(first).toEqual({ ok: true, value: { event: "suggest-inserted", step: 1 } });
    const second = await ask("guide", { action: "next", as: "orbit-keys", page: "t1" });
    expect(second.ok).toBe(true);
    expect(second.value).toMatchObject({ event: "ok", step: 1 });
  });
});
