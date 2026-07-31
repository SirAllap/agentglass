/*
 * The two controls this adds, and the properties that make them safe to use.
 *
 * Both are about several hundred megabytes each and an agent that might be
 * mid-work, so the interesting assertions are the negative ones: what the panel
 * refuses to offer, and what the pin deliberately does not survive.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const panel = read("src/components/RunningPanes.tsx");
const store = read("src/lib/chatStore.ts");
const chat = read("src/components/ChatPanel.tsx");

describe("the list of what is running", () => {
  test("never offers to end a pane that is mid-turn", () => {
    // The one action here that loses something. A confirm would not be enough:
    // it appears under the thumb that just tapped, and the agent is working.
    expect(panel).toContain("{!p.running && (");
  });

  test("and asks twice before ending one that is not", () => {
    expect(panel).toContain("setConfirming(p.name)");
    expect(panel).toMatch(/confirming === p\.name/);
  });

  test("says out loud when nothing will ever be reclaimed", () => {
    // Somebody who has set AGENTGLASS_TMUX_IDLE_MINUTES=0 is looking at a list
    // that never shrinks on its own, and that is the single most useful thing
    // this panel can tell them.
    expect(panel).toContain("Idle eviction is off");
    expect(panel).toMatch(/evictMs > 0/);
  });

  test("names an orphan rather than leaving it to be inferred", () => {
    expect(panel).toContain("no chat");
    expect(panel).toMatch(/p\.orphan/);
  });

  test("ends a pane through the route that already kills panes", () => {
    // A second kill route would be one more thing able to stop an agent, for no
    // capability that did not already exist.
    expect(panel).toContain("api.chatPaneClose(p.name)");
  });

  test("and tells the truth about what ending one costs", () => {
    // Nothing, except one slower turn — which is worth saying, because "End"
    // beside a running agent reads like it might lose the conversation.
    expect(panel).toMatch(/resumes in a fresh CLI/);
  });

  test("sends the chats this window has open, so they are not called abandoned", () => {
    // The server knows which turns are in flight and nothing about which tabs
    // exist. Both halves are needed or every pane in a second window is an
    // orphan.
    expect(panel).toContain("listChats()");
    expect(panel).toContain("api.chatPanes(ids)");
  });
});

describe("the pin", () => {
  test("is offered only where there is a pane to pin", () => {
    // `claude -p` leaves nothing running between turns, so a pin on it would be
    // a switch with nothing behind it.
    const pin = chat.slice(chat.indexOf("Keep this one, however long you are away"), chat.indexOf("Resuming this session"));
    expect(pin).toContain('engineFor(active) === "tmux"');
    expect(pin).toContain("active.sessionId");
  });

  test("says what it costs, where it is switched on", () => {
    const pin = chat.slice(chat.indexOf("Keep this one, however long you are away"), chat.indexOf("Resuming this session"));
    expect(pin).toMatch(/hundred megabytes/);
    // And that closing still releases it, so nobody reads the pin as "forever".
    expect(pin).toMatch(/Closing the chat still releases it/);
  });

  test("is not persisted with the chat", () => {
    // It is a statement about a process running now. Restored for a pane that
    // no longer exists, it is a switch that is on and does nothing — and the
    // pane it claims to protect was reclaimed hours ago.
    const pack = read("src/lib/chatPersist.ts");
    expect(pack).not.toContain("panePinned");
    expect(store).toContain("panePinned");
  });

  test("is read back from the server instead, when the panel opens", () => {
    // Which follows from not persisting it: without this read, a reloaded
    // window shows "not pinned" over a pinned pane, which is the same lie as
    // the reverse.
    expect(store).toContain("export async function hydratePanePins");
    expect(chat).toContain("void hydratePanePins();");
  });

  test("puts itself back if the server would not take it", () => {
    // Optimistic, because the toggle has to move under the thumb — but a pin
    // that failed and still reads as on is how a chat gets reclaimed at lunch.
    const fn = store.slice(store.indexOf("export async function setPanePinned"), store.indexOf("export async function hydratePanePins"));
    expect(fn).toMatch(/if \(!r\?\.ok\)/);
    expect(fn).toContain("c.panePinned = !pinned");
  });
});
