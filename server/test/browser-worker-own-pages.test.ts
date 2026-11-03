/*
 * A WORKER'S WHOLE LEGITIMATE FLOW, against a stub window.
 *
 * The relay canonicalises to the worker's own container: a page id is usable
 * only when the window's reply filed it under this worker, and the registry is
 * filled from those replies alone. These tests drive open -> click -> fill ->
 * observe -> shot -> close through that registry, and then prove the same ids
 * stop working once they are not the worker's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentAskRefusal, askBrowser, forgetWorkerPages, noteBrowserReady, noteWorkerAsk, noteWorkerPage, parseAsk,
  resetBrowserDrive, runSteps, setBrowserSink, settleBrowser, workerOwnsPage,
} from "../src/browserdrive.ts";
import { agentContainerName } from "../../shared/workerContainer.ts";

const OWN = "orbit-1";
let sent: Array<{ id: string; op: string; page?: unknown }> = [];
let nextReply: (op: string) => Record<string, unknown> = () => ({});

/** Gate, parse and ask — the route's own order. The stub answers in a
 *  microtask, after `askBrowser` has parked the ask. */
const drive = async (op: string, body: Record<string, unknown>) => {
  const refusal = agentAskRefusal(body, OWN, op);
  if (refusal) return { refused: refusal };
  const parsed = parseAsk(op, body);
  if ("error" in parsed) return { refused: parsed.error };
  noteWorkerAsk(parsed.ask.id, OWN, parsed.ask.op);
  return askBrowser(parsed.ask);
};

beforeEach(() => {
  resetBrowserDrive();
  sent = [];
  setBrowserSink({
    send: (ask) => {
      sent.push({ id: ask.id, op: ask.op, page: (ask.args as Record<string, unknown>).page });
      const id = ask.id;
      const value = nextReply(ask.op);
      queueMicrotask(() => settleBrowser(id, { ok: true, value }));
      return true;
    },
    listeners: () => 1,
    live: () => true,
  });
  nextReply = (op) => (op === "tabs" ? { tab: "t1-own", profile: agentContainerName(OWN) } : { tab: "t1-own", profile: agentContainerName(OWN), url: "https://example.test" });
  noteBrowserReady("win-test", true);
});

afterEach(() => {
  resetBrowserDrive();
});

describe("the worker's own flow works end to end (M1)", () => {
  test("open, click, fill, observe, shot and close", async () => {
    const opened = await drive("open", { as: OWN, profile: OWN, url: "https://example.test" });
    expect(opened).toMatchObject({ ok: true });
    expect(workerOwnsPage(OWN, "t1-own")).toBe(true);

    for (const [op, body] of [
      ["click", { as: OWN, page: "t1-own", selector: "#save" }],
      ["fill", { as: OWN, page: "t1-own", fields: { "#name": "orbit" } }],
      ["observe", { as: OWN, page: "t1-own" }],
      ["shot", { as: OWN, page: "t1-own", path: ".agx-tmp/shot.png" }],
      ["closetab", { as: OWN, id: "t1-own" }],
    ] as Array<[string, Record<string, unknown>]>) {
      // `shot` needs a path; the stub answers it as any other ask.
      const r = await drive(op, body);
      expect({ op, refused: (r as { refused?: string }).refused }).toEqual({ op, refused: undefined });
    }
    // Closed: the id is no longer this worker's, so the next ask is refused.
    expect(agentAskRefusal({ as: OWN, page: "t1-own" }, OWN, "click")).not.toBeNull();
  });

  test("a `do` call registers the page its own `open` minted", async () => {
    const r = await runSteps(
      [
        { op: "open", args: { profile: OWN, url: "https://example.test" } },
        { op: "click", args: { selector: "#save" } },
      ],
      { caller: { as: OWN }, worker: OWN, page: undefined },
    );
    // The first step asks; the stub files t1-own; the second step is legal.
    expect(r.ok).toBe(true);
    expect(workerOwnsPage(OWN, "t1-own")).toBe(true);
  });

  test("a `do --observe` looks at the page its own `open` minted", async () => {
    const r = await runSteps(
      [{ op: "open", args: { profile: OWN, url: "https://example.test" } }],
      { caller: { as: OWN }, worker: OWN, observe: true },
    );
    expect(r.ok).toBe(true);
    /* The trailing observation is evidence for the sequence; built from
       `opts.page` alone it named no page, and the panel refused it against the
       person's tab in front. */
    expect(sent.filter((s) => s.op === "observe").map((s) => s.page)).toEqual(["t1-own"]);
    expect(r.steps.at(-1)).toMatchObject({ op: "observe", ok: true });
  });

  test("a step may name the page an earlier own `open` minted", async () => {
    const r = await runSteps(
      [
        { op: "open", args: { profile: OWN, url: "https://example.test" } },
        { op: "click", args: { selector: "#save", page: "t1-own" } },
      ],
      { caller: { as: OWN }, worker: OWN },
    );
    expect(r.ok).toBe(true);
    expect(sent.map((s) => s.op)).toEqual(["open", "click"]);
  });

  test("a step that names a page the worker does not own is refused before it is sent", async () => {
    const r = await runSteps(
      [
        { op: "open", args: { profile: OWN, url: "https://example.test" } },
        { op: "click", args: { selector: "#pay", page: "t1-person" } },
      ],
      { caller: { as: OWN }, worker: OWN },
    );
    expect({ ok: r.ok, stoppedAt: r.stoppedAt }).toEqual({ ok: false, stoppedAt: 1 });
    expect(String((r.steps[1] as { error?: string }).error)).toContain("not one it opened");
    expect(sent.map((s) => s.op)).toEqual(["open"]);
  });
});

describe("the registry is the only way a page becomes the worker's", () => {
  test("revoking the credential forgets the pages it opened", () => {
    resetBrowserDrive();
    noteWorkerPage(OWN, "t1-own");
    expect(workerOwnsPage(OWN, "t1-own")).toBe(true);
    forgetWorkerPages(OWN);
    expect(workerOwnsPage(OWN, "t1-own")).toBe(false);
  });

  test("a person's tab id is refused even with the worker's own `as`", async () => {
    const r = await drive("click", { as: OWN, page: "t1-person", pageExplicit: true, selector: "#pay" });
    expect((r as { refused?: string }).refused).toContain("not one it opened");
  });

  test("an ask that names no page does not fall through to the front tab", () => {
    expect(agentAskRefusal({ as: OWN, selector: "#pay" }, OWN, "click")).not.toBeNull();
  });
});
