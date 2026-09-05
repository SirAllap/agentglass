/*
 * The Plugins page, and the one thing it exists to make unmissable.
 *
 * A plugin whose manifest changed since it was approved must read as "this
 * is asking for something different now", never as an ordinary disabled
 * row — that is the whole trust model this page sits on top of. And the
 * `read` scope has to say plainly that it sees a session's live output, not
 * just the bare word "read": see server/src/index.ts's own description of
 * /stream carrying "the whole fleet's prompts, paths and errors".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const pane = readFileSync(new URL("../src/components/PluginsPane.tsx", import.meta.url), "utf8");

describe("re-consent reads as its own thing", () => {
  test("distinct from a plugin that has simply never been reviewed", () => {
    // hadApproval is what tells the two apart — see server/src/plugins.ts.
    expect(pane).toContain("plugin.approvedFingerprint !== plugin.fingerprint");
    expect(pane).toContain("needsReview && plugin.hadApproval");
    expect(pane).toMatch(/asking for something different now/);
    expect(pane).toMatch(/Not reviewed yet/);
  });

  test("its own warning colour, not the ordinary disabled styling", () => {
    expect(pane).toMatch(/reconsent && \(/);
    expect(pane).toContain('tone="warning"');
  });
});

describe("the scope sentence is honest about `read`", () => {
  test("says a plugin can see a session's live output, not just \"read\"", () => {
    expect(pane).toMatch(/every session's live output as it streams/);
    expect(pane).toMatch(/the same prompts and replies you watch on screen/);
  });

  test("and says what it cannot do", () => {
    expect(pane).toMatch(/Cannot approve a gate, send a reply, or write anything/);
  });
});

describe("a switch on with nothing running is the failure this page catches", () => {
  test("the dot and the running line are driven by the PROCESS, not the enabled flag", () => {
    expect(pane).toContain("const running = plugin.running;");
    /* The sentence is shorter than it was — it is a chip on a card now rather
       than a clause in a line of prose — so this matches the two words that
       carry the meaning instead of the whole phrase. What it is guarding has
       not changed: the page must be able to say "you switched it on and
       nothing is running", which is the failure a plugin screen exists to
       show and the one an `enabled` flag alone cannot. */
    expect(pane).toMatch(/enabled, not running/);
    expect(pane).toContain("pid ${plugin.pid}");
  });
});

describe("what every row shows", () => {
  test("name, publisher, description, source, and the scope word", () => {
    expect(pane).toContain("{plugin.name}");
    expect(pane).toContain("by {plugin.publisher}");
    expect(pane).toContain("{plugin.description}");
    expect(pane).toContain("From <span className=\"t-mono\">{formatSource(plugin.source)}</span>");
    expect(pane).toContain("SCOPE_WORD[plugin.scope]");
  });
});

describe("the master switch actually stops things", () => {
  test("turning it off is described as stopping every enabled plugin immediately", () => {
    expect(pane).toMatch(/Turning this off stops every one of them immediately/);
  });
});

describe("install takes a local path or a git URL, and cannot enable an unreviewed plugin", () => {
  test("one field, not a toggle between two modes", () => {
    expect(pane).toMatch(/A local folder's absolute path, or a git URL/);
  });

  test("the enable switch is disabled while review is outstanding or the master switch is off", () => {
    expect(pane).toContain("!plugin.enabled && (needsReview || !masterOn)");
  });
});
