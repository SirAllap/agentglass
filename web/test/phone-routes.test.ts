/*
 * Two faults with one cause: a destination on the phone could not be named.
 *
 * `MobileChats` owned `openId` privately, and `MobileApp` rendered it
 * conditionally, so nothing outside could say "open THIS chat". Every intent
 * that wanted to therefore degraded to the nearest expressible thing:
 *
 *   - the queue's "Open chat" became `setTab("chats")` and dropped the card, so
 *     tapping the accent action on a stalled agent landed you on a list that by
 *     construction could not contain it — the list opens on "working", and the
 *     card exists precisely because that agent stopped working;
 *   - `onOpenChatWith` was declared by the pull request and repo screens and
 *     passed by nobody, so "Review locally with Claude" and "Ask Claude why"
 *     have never once been on screen.
 *
 * And the conversation was not on the shared back stack, so the one surface a
 * person sits in for minutes answered the phone's back gesture by quitting
 * agentglass.
 *
 * The last test here is the one that matters over time: it is a rule over the
 * tree, not an assertion about these two screens.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const MOBILE = join(SRC, "mobile");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("a conversation can be opened by name", () => {
  const chats = read("mobile/MobileChats.tsx");
  const app = read("mobile/MobileApp.tsx");

  test("MobileChats takes the open chat as a prop instead of owning it", () => {
    expect(chats).toContain("openChat: OpenChat | null");
    expect(chats).toContain("onOpenChat:");
    // The private state is what made it unaddressable.
    expect(chats).not.toContain("const [openId, setOpenId]");
    expect(chats).not.toContain("const [composing, setComposing]");
  });

  test("the shell holds it, so anything can set it", () => {
    expect(app).toContain("useState<OpenChat | null>");
    expect(app).toContain("openSession");
  });

  test("the queue's session card opens that session, not the tab", () => {
    // The whole bug in one line: `run: () => { setTab("chats"); drop(it.id); }`.
    const actions = app.slice(app.indexOf('case "session":'), app.indexOf('case "pr-red":'));
    expect(actions).toContain("openSession(o.session)");
    expect(actions).not.toContain('setTab("chats"); drop(');
  });

  test("opening a session carries where it runs, not just its id", () => {
    // Without the directory the conversation announces that a chat it has only
    // just been handed cannot be resumed.
    const opener = app.slice(app.indexOf("const openSession"), app.indexOf("const openChatWith"));
    expect(opener).toContain("cwd_path");
  });
});

describe("the hand-offs are wired", () => {
  const app = read("mobile/MobileApp.tsx");

  test("MobileApp passes onOpenChatWith to both screens that offer it", () => {
    // Both render their button behind `onOpenChatWith && …`, so an unpassed
    // prop is not a broken button — it is no button at all.
    const uses = app.split("onOpenChatWith={openChatWith}").length - 1;
    expect(uses, "RepoScreen and MobilePr must both receive it").toBe(2);
  });

  test("every screen that declares the hand-off is given one", () => {
    // The rule rather than the two call sites: a third screen offering this
    // must not ship with it dangling.
    const declared: string[] = [];
    for (const file of walk(MOBILE)) {
      const src = readFileSync(file, "utf8");
      if (/onOpenChatWith\?:/.test(src)) declared.push(file.split("/").pop()!);
    }
    const wired = app.match(/onOpenChatWith=\{/g)?.length ?? 0;
    expect(wired, `${declared.join(", ")} declare it`).toBe(declared.length);
  });

  test("the hand-off keeps the directory the server checked out into", () => {
    const chats = read("mobile/MobileChats.tsx");
    // Falling back to the first repo would run the review against a tree that
    // is not the one the pull request was put in.
    expect(chats).toContain("preset.cwd");
    expect(chats).toContain("if (!preset.cwd && r.repos[0])");
  });
});

describe("the back gesture closes a screen, not the app", () => {
  test("the conversation and the composer are on the shared stack", () => {
    const chats = read("mobile/MobileChats.tsx");
    expect(chats).toContain("useBackClose");
    // Both, not one: New chat loses a typed prompt just as a conversation
    // loses a draft.
    expect(chats.match(/useBackClose\(/g)?.length).toBe(2);
  });

  test("every full-screen surface joins the stack", () => {
    /*
     * The rule, over the tree.
     *
     * `Screen` and `Sheet` call `useBackClose` for you, which is why the diff
     * and the sheets were fine and the two hand-rolled surfaces were not. A
     * screen drawn by hand — `<div className="mb-screen …">` — has to say so
     * itself, and the next one written that way must not silently reintroduce
     * "back quits the app".
     */
    const offenders: string[] = [];
    for (const file of walk(MOBILE)) {
      const src = readFileSync(file, "utf8");
      // Only the ones that DRAW a screen, not the module that defines it.
      if (file.endsWith("mobileUi.tsx")) continue;
      if (!/className=\{?["`][^"`]*mb-screen/.test(src)) continue;
      if (!/useBackClose/.test(src)) offenders.push(file.replace(SRC, ""));
    }
    expect(offenders, "a hand-rolled screen that the back gesture would quit past").toEqual([]);
  });
});
