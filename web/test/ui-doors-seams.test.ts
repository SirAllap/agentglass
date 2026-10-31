/*
 * The seams behind the second batch of doors, held as source.
 *
 * A dialog that opens "when asked" is a component that listens, and a listener
 * nobody wired is a door that answers ok and shows nothing, which is worse than
 * a 400. There is no renderer in this project, so each wiring is asserted
 * against the code that owns it: the view drains the mailbox, and the on-demand
 * release notes never mark a version as seen.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(import.meta.dir, "..", "src", p), "utf8");
const body = (text: string, from: string, upTo: string) => {
  const a = text.indexOf(from);
  expect(a, `${from} moved`).toBeGreaterThan(-1);
  const b = text.indexOf(upTo, a + from.length);
  expect(b, `${upTo} moved`).toBeGreaterThan(a);
  return text.slice(a, b);
};

describe("the views drain what a door latched", () => {
  it("the Git view opens the rebase editor and the palette from the mailbox", () => {
    const git = src("components/GitPanel.tsx");
    const drain = body(git, "const m = takeGitModal();", "return subscribeGitModal(run);");
    expect(drain).toContain('m.which === "rebase") setRebaseBase(m.base)');
    expect(drain).toContain('m.which === "palette") setPaletteOpen(true)');
  });

  it("the Agents screen opens its schedule dialog and its Change dialog, and does nothing else with the latch", () => {
    const agents = src("components/agents/AgentsView.tsx");
    const drain = body(agents, 'takeViewModal("lantern.schedule")', "subscribeViewModal(run)");
    expect(drain).toContain("setScheduling(true)");
    expect(drain).toContain('takeViewModal("agents.change")');
    expect(drain).toContain("setChange(");
  });

  it("the + menu hosts the Resume list and takes its request; the strip takes the sessions dialog's", () => {
    const plus = src("components/terminal/PlusButton.tsx");
    expect(body(plus, 'takeViewModal("terminal.resume")', "subscribeViewModal(run)")).toContain("setResume(true)");
    const strip = src("components/terminal/TermStrip.tsx");
    expect(body(strip, 'takeViewModal("terminal.sessions")', "subscribeViewModal(run)")).toContain("setManageOpen(true)");
  });
});

describe("release notes on demand", () => {
  const whatsNew = src("components/WhatsNew.tsx");
  it("closing them marks a version seen only when they were the announcement", () => {
    const close = body(whatsNew, "const close = () => {", "return (");
    expect(close).toContain("if (tag && !demand) markSeen(tag)");
  });
  it("asking for them never marks anything", () => {
    const ask = body(whatsNew, "onShowWhatsNew(() => {", "}), []);");
    expect(ask).not.toContain("markSeen");
    expect(ask).not.toContain("releaseToAnnounce");
  });
});
