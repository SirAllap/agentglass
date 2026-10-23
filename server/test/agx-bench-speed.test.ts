/**
 * agx-bench speed, the parts that run without a browser or a model: the
 * fixture pages' verdicts, the task graders, and the runner's accounting.
 */
import { describe, expect, test } from "bun:test";
import { freshState, makeHandler } from "../../scripts/agx-bench/fixtures.ts";
import { LOGIN, ORDER_RIGHT, SEARCH_RIGHT, SHADOW_CODE, SIGNUP, SPEED_TASKS } from "../../scripts/agx-bench/fixtures3.ts";
import { foldLine, skillText, summarize, toMarkdown, type SpeedRun } from "../../scripts/agx-bench/speed.ts";

const O = "http://127.0.0.1:1";
const post = (h: ReturnType<typeof makeHandler>, path: string, body?: unknown) =>
  h(new Request(O + path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
const task = (id: string) => SPEED_TASKS.find((t) => t.id === id)!;

describe("speed fixtures", () => {
  test("every task's page is served in full every time", async () => {
    const h = makeHandler(freshState());
    for (const p of ["login", "search", "signup", "orders", "promo", "docs", "terms", "shadow", "overlay"]) {
      for (let i = 0; i < 2; i++) {
        const r = await h(new Request(`${O}/speed/${p}`));
        expect(r.status).toBe(200);
        expect((await r.text()).length).toBeGreaterThan(100);
      }
    }
  });

  test("a task's prompt names a page the server has", async () => {
    const h = makeHandler(freshState());
    for (const t of SPEED_TASKS) {
      const path = /http:\/\/[^/\s]+(\/speed\/[a-z]+)/.exec(t.prompt(O))?.[1];
      expect(path).toBeTruthy();
      expect((await h(new Request(O + path))).status).toBe(200);
    }
  });

  test("the verdict is the server's: right and wrong answers land on different beacons", async () => {
    const state = freshState();
    const h = makeHandler(state);
    await post(h, "/api/speed/login", { email: LOGIN.email, pw: "nope" });
    expect(task("login").pass(state.beacons)).toBe(false);
    await post(h, "/api/speed/login", { email: LOGIN.email, pw: LOGIN.password });
    expect(state.beacons["speed-login-bad"]).toBe(1);
    // A wrong try first is still a failed task: the grader wants a clean run.
    expect(task("login").pass(state.beacons)).toBe(false);

    const s2 = freshState();
    const h2 = makeHandler(s2);
    await post(h2, `/api/speed/pick?id=${SEARCH_RIGHT}`);
    expect(task("search-pick").pass(s2.beacons)).toBe(true);
    await post(h2, "/api/speed/pick?id=g2");
    expect(task("search-pick").pass(s2.beacons)).toBe(false);
  });

  test("signup needs the exact person, plan and the terms", async () => {
    const s = freshState();
    const h = makeHandler(s);
    await post(h, "/api/speed/signup", { ...SIGNUP, terms: false });
    expect(s.beacons["speed-signup-wrong"]).toBe(1);
    await post(h, "/api/speed/signup", { ...SIGNUP, terms: true });
    expect(s.beacons["speed-signup"]).toBe(1);
  });

  test("orders: the look-alike customer is the wrong one", async () => {
    const s = freshState();
    const h = makeHandler(s);
    await post(h, "/api/speed/ship?id=1013");
    expect(task("table-pages").pass(s.beacons)).toBe(false);
    const s2 = freshState();
    await post(makeHandler(s2), `/api/speed/ship?id=${ORDER_RIGHT}`);
    expect(task("table-pages").pass(s2.beacons)).toBe(true);
  });

  test("shadow: the code typed inside the widget is what counts", async () => {
    const s = freshState();
    await post(makeHandler(s), `/api/speed/shadow?code=${SHADOW_CODE}`);
    expect(task("shadow").pass(s.beacons)).toBe(true);
  });

  test("pages that report by beacon pass only on the beacon, once", () => {
    for (const [id, name] of [["late-modal", "speed-promo"], ["popup", "speed-popup"], ["overlay", "speed-overlay"]] as const) {
      expect(task(id).pass({})).toBe(false);
      expect(task(id).pass({ [name]: 1 })).toBe(true);
      expect(task(id).pass({ [name]: 2 })).toBe(false);
    }
  });

  test("an unknown speed API is not found, a GET on it is not served", async () => {
    const h = makeHandler(freshState());
    expect((await post(h, "/api/speed/nothing")).status).toBe(404);
    expect((await h(new Request(`${O}/api/speed/login`))).status).toBe(404);
  });
});

describe("speed runner accounting", () => {
  test("tool calls are rounds, commands are kept, the result line carries tokens and cost", () => {
    const t = { rounds: 0, inTokens: 0, outTokens: 0, usd: 0, commands: [] as string[] };
    foldLine(t, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", input: { command: "agentglass-browser open x" } }] } }));
    foldLine(t, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { command: "agentglass-browser observe" } }] } }));
    foldLine(t, "not json at all");
    foldLine(t, JSON.stringify({ type: "result", total_cost_usd: 0.02, usage: { input_tokens: 2, cache_creation_input_tokens: 3000, cache_read_input_tokens: 4000, output_tokens: 150 } }));
    expect(t).toEqual({ rounds: 2, inTokens: 7002, outTokens: 150, usd: 0.02, commands: ["agentglass-browser open x", "agentglass-browser observe"] });
  });

  test("the front matter is not part of the skill text the model reads", () => {
    const text = skillText(new URL("../../skills/browser-use/SKILL.md", import.meta.url).pathname);
    expect(text.startsWith("---")).toBe(false);
    expect(text).toContain("# Using the built-in browser");
  });

  test("a task is summarised by medians, success as k of n, and the table totals it", () => {
    const run = (rep: number, rounds: number, pass: boolean): SpeedRun => ({ task: "login", rep, rounds, inTokens: rounds * 1000, outTokens: 100, seconds: rounds * 2, usd: 0.01, pass, commands: [] });
    const rows = summarize([run(1, 4, true), run(2, 6, true), run(3, 20, false)]);
    expect(rows).toEqual([{ task: "login", n: 3, passed: 2, rounds: 6, inK: 6, outK: 0.1, seconds: 12, usd: 0.03 }]);
    const md = toMarkdown("baseline", rows);
    expect(md).toContain("| login | 2/3 | 6 | 6 | 0.1 | 12 | 0.03 |");
    expect(md).toContain("| **all** | 2/3 |");
  });
});
