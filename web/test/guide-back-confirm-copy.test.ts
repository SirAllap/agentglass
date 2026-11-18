import { expect, test } from "bun:test";
import { GUIDE_LEAVE_ASK, GUIDE_LEAVE_YES } from "../src/lib/browserAgentActivity.ts";

const src = await Bun.file(new URL("../src/components/browser/AgentPresence.tsx", import.meta.url)).text();

// Back on a wait-click step asks first. "Leave" read as ending the whole guide,
// not as going back one step.
test("the Back confirmation says it goes back a step, not that it leaves", () => {
  expect(GUIDE_LEAVE_ASK).toMatch(/^Go back/);
  expect(GUIDE_LEAVE_YES).toBe("Go back");
  expect(src).toContain("{GUIDE_LEAVE_YES}</button>");
  expect(src).not.toContain(">Leave</button>");
});
