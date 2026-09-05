/*
 * A handoff brief is the record, trimmed: the task as first asked, the last
 * turns, the files touched, and the one instruction — continue, do not start
 * over. No summariser in the middle.
 */
import { describe, expect, test } from "bun:test";
import { handoffBrief } from "../src/handoff.ts";

const d = {
  first_prompt: "Fix the export that drops the last page. Reproduce first.",
  custom_title: "orbit-1042", ai_title: null, summary: "Reproduced; the retry loses the cursor.",
  cwd_path: "/home/me/code/orbit-wt/orbit-1042",
  conversation: [
    { role: "user" as const, text: "Fix the export that drops the last page. Reproduce first.", ts: 1 },
    { role: "assistant" as const, text: "Reproduced with the fixture: the cursor is reset on retry. " + "x".repeat(2000), ts: 2 },
    { role: "user" as const, text: "ok, fix it and add a test", ts: 3 },
    { role: "assistant" as const, text: "Working on retry.ts …", ts: 4 },
  ],
  changes: [
    { id: 1, timestamp: 1, source_app: "x", session_id: "s", tool: "Edit", file_path: "src/export/retry.ts" },
    { id: 2, timestamp: 2, source_app: "x", session_id: "s", tool: "Write", file_path: "src/export/retry.test.ts" },
    { id: 3, timestamp: 3, source_app: "x", session_id: "s", tool: "Edit", file_path: "src/export/retry.ts" },
  ],
};

describe("the brief", () => {
  test("leads with continue-do-not-start-over, carries title, checkout, summary, the first ask, the turns and the files once each", () => {
    const b = handoffBrief(d);
    expect(b.startsWith("You are taking over a conversation another agent was having in this checkout. Continue it; do not start over")).toBe(true);
    expect(b).toContain("Title: orbit-1042");
    expect(b).toContain("Checkout: /home/me/code/orbit-wt/orbit-1042");
    expect(b).toContain("Summary so far: Reproduced; the retry loses the cursor.");
    expect(b).toContain("The task, as first asked:\nFix the export that drops the last page. Reproduce first.");
    expect(b).toContain("The last 4 turns:");
    expect(b).toContain("Person: ok, fix it and add a test");
    expect(b).toContain("Agent: Working on retry.ts …");
    expect((b.match(/- src\/export\/retry\.ts$/gm) ?? []).length, "a file touched three times is listed once").toBe(1);
    expect(b).toContain("- src/export/retry.test.ts");
    expect(b.endsWith("Begin by saying, in two lines, where you think it left off and what you will do next.")).toBe(true);
  });
  test("a long turn is cut and marked, and the count of turns is the count asked for", () => {
    const b = handoffBrief(d, { turns: 2, each: 40 });
    expect(b).toContain("The last 2 turns:");
    expect(b).not.toContain("Person: Fix the export");
    expect(b).toContain("Agent: Working on retry.ts …");
    const long = handoffBrief(d, { turns: 4, each: 40 });
    expect(long).toContain("Agent: Reproduced with the fixture: the cursor …");
  });
  test("the route composes it server-side and seats a ticket; the client sends only the session and the kind", async () => {
    const index = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const at = index.indexOf('pathname === "/agents/handoff"');
    const body = index.slice(at, index.indexOf('pathname === "/agents/schedule"', at));
    expect(body).toContain("const prompt = handoffBrief(d);");
    expect(body).toContain("mintAgentTicket({ cwd, prompt, yolo: false");
    const ask = await Bun.file(new URL("../../web/src/lib/lanternAsk.ts", import.meta.url)).text();
    const fn = ask.slice(ask.indexOf("export async function handOff("), ask.indexOf("export async function askLantern("));
    expect(fn).toContain("api.agentHandoff(session, kind)");
    expect(fn).not.toContain("prompt");
  });
});
