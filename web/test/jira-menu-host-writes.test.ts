/* A rule about source: every new write row in the host goes through `attempt`, so Changes off and a throw each say something in the footer. */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/jira/list/menus/JiraMenuHost.tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !l.trim().startsWith("/*") && !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
const attempt = code.slice(code.indexOf("const attempt ="), code.indexOf("const pickCard ="));

describe("the card menu's writes", () => {
  test("attempt refuses with the Changes-off reason and turns a rejection into a note", () => {
    expect(attempt).toContain("WRITES_OFF_WHY");
    expect(attempt).toContain("() => onNote?.({ ok: false");
  });
  test("pickCard wraps its work so a throw is a note", () => {
    const pick = code.slice(code.indexOf("const pickCard ="), code.indexOf("const pickCardNow ="));
    expect(pick).toContain("try {");
    expect(pick).toContain("catch (e)");
  });
  test("clone, next sprint, backlog and epic all go through attempt", () => {
    const now = code.slice(code.indexOf("const pickCardNow ="), code.indexOf("const assignTo ="));
    for (const id of ['case "clone"', 'case "sprint:next"', 'case "sprint:backlog"', 'id.startsWith("epic:")']) {
      const at = now.indexOf(id);
      expect(at).toBeGreaterThan(0);
      expect(now.slice(at, at + 400)).toContain("attempt(");
    }
  });
  test("the current sprint row goes through attempt too, so the board is read back after the move", () => {
    const at = code.indexOf('case "sprint": {');
    expect(at).toBeGreaterThan(0);
    const row = code.slice(at, code.indexOf('case "copyKey"', at));
    expect(row).toContain("attempt(");
    expect(row).not.toContain("void source.moveToSprint");
  });
});
