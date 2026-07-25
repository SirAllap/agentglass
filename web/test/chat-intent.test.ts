import { test, expect, afterEach } from "bun:test";
import { latchChatIntent, takeChatIntent, peekChatIntent, subscribeChatIntent } from "../src/lib/chatIntent.ts";

// The mailbox holds a control command until the chat panel exists to run it.
// Two things about it are load-bearing and easy to break by accident.
//
// It expires: /control broadcasts to every client, so a press also lands on tabs
// with the workspace shut, where nothing drains it and no unmount clears it.
// Without a limit that command fires the next time the chat view mounts for some
// unrelated reason, which is not what anyone pressed the button for.
//
// And peek must lapse on the same schedule as take. The seeding effect stands
// aside when it peeks a pending "new", trusting the drain to add the tab; a peek
// that outlived a take would have it defer to a command that never runs and open
// the panel on nothing at all.

const realNow = Date.now;
afterEach(() => { Date.now = realNow; takeChatIntent(); });

test("a latched command is there to be taken", () => {
  latchChatIntent("new");
  expect(takeChatIntent()).toBe("new");
});

test("taking clears the slot", () => {
  latchChatIntent("new");
  takeChatIntent();
  expect(takeChatIntent()).toBeNull();
});

test("peeking does not", () => {
  latchChatIntent("new");
  expect(peekChatIntent()).toBe("new");
  expect(peekChatIntent()).toBe("new");
  expect(takeChatIntent()).toBe("new");
});

test("one slot, not a queue — the newest press wins", () => {
  latchChatIntent("new");
  latchChatIntent("new");
  expect(takeChatIntent()).toBe("new");
  expect(takeChatIntent()).toBeNull();
});

test("a command nobody drained lapses, to both readers alike", () => {
  latchChatIntent("new");
  Date.now = () => realNow() + 30_001;
  expect(peekChatIntent()).toBeNull();
  expect(takeChatIntent()).toBeNull();
});

test("but survives the wait for a repo list", () => {
  latchChatIntent("new");
  Date.now = () => realNow() + 5_000;
  expect(peekChatIntent()).toBe("new");
  expect(takeChatIntent()).toBe("new");
});

test("subscribers hear every latch, and stop on unsubscribe", () => {
  let n = 0;
  const off = subscribeChatIntent(() => { n++; });
  latchChatIntent("new");
  latchChatIntent("new");
  off();
  latchChatIntent("new");
  expect(n).toBe(2);
});

test("one throwing listener does not rob the others", () => {
  let heard = false;
  const offBad = subscribeChatIntent(() => { throw new Error("boom"); });
  const offGood = subscribeChatIntent(() => { heard = true; });
  latchChatIntent("new");
  offBad(); offGood();
  expect(heard).toBe(true);
});
