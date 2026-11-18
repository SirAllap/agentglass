/*
 * One render per burst, whatever the burst closes, and fewer of them off the
 * Starboard.
 *
 * Every flush of the live socket re-renders the root. Two things made that
 * happen more often than the 220 ms coalescing promised: a finished tool call
 * was taken off the open list with a state update of its own, per Post event,
 * outside the flush; and the flush ran five times a second in every view,
 * though only the Starboard draws what it carries.
 */
import { describe, expect, test } from "bun:test";
import { closeTools, flushDelay } from "../src/lib/liveFlush.ts";
import type { OpenToolCall, WatchEvent } from "../../shared/types.ts";

const live = await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url)).text();
const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

const open = (over: Partial<OpenToolCall>): OpenToolCall => ({ session_id: "s1", source_app: "orbit", tool_name: "Bash", since: 1000, ...over }) as OpenToolCall;
const post = (over: Partial<WatchEvent>): WatchEvent => ({ id: 1, session_id: "s1", source_app: "orbit", hook_event_type: "PostToolUse", tool_name: "Bash", timestamp: 2000, ...over }) as WatchEvent;

describe("closing tools with the batch", () => {
  test("a Post closes its own call and no other", () => {
    const cur = [open({}), open({ tool_name: "Edit" }), open({ session_id: "s2" })];
    const next = closeTools(cur, [post({})]);
    expect(next.map((s) => `${s.session_id}:${s.tool_name}`)).toEqual(["s1:Edit", "s2:Bash"]);
  });

  test("nothing closed is the same array, so setting it renders nothing", () => {
    const cur = [open({ session_id: "s2" })];
    expect(closeTools(cur, [post({})])).toBe(cur);
    expect(closeTools(cur, [])).toBe(cur);
    const none: OpenToolCall[] = [];
    expect(closeTools(none, [post({})])).toBe(none);
  });

  test("a Post from before the call opened does not close it", () => {
    // The same tool run twice: the first run's Post arrives after the second run's seed.
    const cur = [open({ since: 3000 })];
    expect(closeTools(cur, [post({ timestamp: 2000 })])).toBe(cur);
  });

  test("a Post with no tool name closes every call of its session, and a batch closes several at once", () => {
    const cur = [open({}), open({ tool_name: "Edit" }), open({ session_id: "s2", tool_name: "Read" })];
    expect(closeTools(cur, [post({ tool_name: null })]).map((s) => s.session_id)).toEqual(["s2"]);
    expect(closeTools(cur, [post({}), post({ id: 2, session_id: "s2", tool_name: "Read" })]).map((s) => s.tool_name)).toEqual(["Edit"]);
  });
});

describe("how often the root is re-rendered", () => {
  test("five times a second on the Starboard, once a second anywhere else", () => {
    expect(flushDelay(false)).toBe(220);
    expect(flushDelay(true)).toBe(1000);
  });

  test("the socket handler sets no state per event: the flush does", () => {
    const at = live.indexOf('} else if (frame.type === "event") {');
    expect(at).toBeGreaterThan(-1);
    const body = live.slice(at, live.indexOf("\n      }\n", at));
    expect(body).toContain("scheduleFlush();");
    expect(body).not.toContain("setOpenTools(");
    const flush = live.slice(live.indexOf("const flush = useCallback(() => {"), live.indexOf("const scheduleFlush = useCallback("));
    expect(flush).toContain("setOpenTools((cur) => foldTools(cur, toolsFrame, posts));");
    expect(live).toContain("timer.current = setTimeout(flush, flushDelay(slowRef.current, focusedRef.current));");
  });

  test("the root asks for the slow flush whenever the Starboard is not on screen, and catches up when it is", () => {
    expect(app).toContain("useLive(anyPanelOpen, !dashActive)");
    expect(live).toContain("if (!slow) flush();");
  });
});
