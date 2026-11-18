// The `issue` command opens a tmux window for a button. It used to `return`
// without a word when the folder was out of scope or gone, and the button had
// already written "Claude is on it". Every path out must answer.
import { expect, test } from "bun:test";
import { issueTabName } from "../src/terminal.ts";

const src = await Bun.file(new URL("../src/terminal.ts", import.meta.url)).text();
const at = src.indexOf('if (msg.cmd === "issue") {');
const block = src.slice(at, src.indexOf('if (msg.cmd === "resume") {', at));
const code = block.split("\n").filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");

test("the issue handler is found", () => { expect(at).toBeGreaterThan(0); });

test("the credential names the card, not only its display label", () => {
  /* A ClickUp space and a Jira site can both spell a card `DEV-1042`; two tabs
     that fold to one browser container see each other's pages. The card's own
     id is what tells them apart, and it is in hand when the button opens. */
  expect(issueTabName("DEV-1042", "86abc")).not.toBe(issueTabName("DEV-1042", "DEV-1042"));
  expect(issueTabName("DEV-1042", "86abc")).toBe("DEV-1042-86abc");
  // A caller that names no card gets no tab: the label alone is what two boards share.
  expect(issueTabName("DEV-1042", undefined)).toBeNull();
});

test("the handler hands the card id to the name it mints for", () => {
  expect(code).toContain("issueTabName(name, msg.cardId, msg.subject)");
  /* No card id, no tab: a client that sends none is answered rather than given
     the bare label, which two boards can share. */
  expect(code).toMatch(/if \(!tab\) \{ answer\(false, "[^"]*card[^"]*"\); return; \}/);
});

test("a refused folder is answered with the reason, never dropped", () => {
  expect(code).not.toMatch(/inScope\(cwd\)[^\n]*\)\s*return;/);
  for (const why of ["not an absolute path", "no longer exists", "outside the open project"]) expect(code).toContain(why);
});

test("both window openings answer with what the engine did", () => {
  /* One row per opening, each with the `answer(w.ok, …)` the button reads: the
     agent branch's and the shell fallback's. Split on the calls rather than on
     a line, because the agent's answer now mints and revokes around it. */
  const rows = code.split("engineWindowOutcome(").slice(1);
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(row).toContain(".then((w) => {");
    expect(row).toContain("answer(w.ok");
  }
});

test("a machine item names the tab when no card does", () => {
  /* The disk report, a failed check and a person-waiting item are not cards:
     the ask door takes a subject that is either. */
  expect(issueTabName("ask-Disk-cleanup", undefined, "machine:disk-report")).toBe("ask-Disk-cleanup-machine-disk-report");
  expect(issueTabName("ask-Disk-cleanup", "", "")).toBeNull();
});

test("the refusal never tells a person to update", () => {
  expect(code).toContain("issueTabName(name, msg.cardId, msg.subject)");
  expect(code).not.toMatch(/answer\(false, "[^"]*update agentglass/);
});
