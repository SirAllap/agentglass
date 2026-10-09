/*
 * "Check on base" executes repository code on the person's machine, so the page
 * holds two rules a source test can pin: nothing starts without the Run button
 * on a command that was shown, and the result is counts, never a verdict word.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/CheckOnBase.tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** The text of `const name = async (...) => { ... };` up to its own closing line. */
function body(name: string): string {
  const at = code.indexOf(`const ${name} = async`);
  expect(at).toBeGreaterThan(-1);
  const end = code.indexOf("\n  };", at);
  return code.slice(at, end);
}

const prPanel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("the check on base card", () => {
  test("the PR panel mounts it in each failure row, with the PR's own number", () => {
    expect(prPanel).toContain("rowAction={(f) => <CheckOnBase root={root} pr={d.number} failure={f} />}");
  });

  test("a run starts only from run(), which only the Run button calls", () => {
    expect(code.match(/prCheckOnBaseStart/g)).toHaveLength(1);
    expect(body("run")).toContain("api.prCheckOnBaseStart(root, pr, command, plan, noBox)");
    expect(code.match(/void run\(plan\)/g)).toHaveLength(1);
    expect(code).toContain('onClick={() => void run(plan)}>Run</Button>');
  });

  test("opening the card only reads the plan: no effect starts anything", () => {
    expect(body("open")).toContain("prCheckOnBasePlan");
    expect(body("open")).not.toContain("prCheckOnBaseStart");
    const at = code.indexOf("usePoll(");
    const poll = code.slice(at, code.indexOf("}, POLL_MS)", at));
    expect(poll).toContain("prCheckOnBaseStatus");
    expect(poll).not.toContain("prCheckOnBaseStart");
    expect(code).not.toContain("useEffect(() => { void api.");
  });

  test("the command is shown, editable and remembered per repository", () => {
    expect(code).toContain("<textarea value={command}");
    expect(code).toContain("remember(root, command)");
    expect(code).toContain("agx.checkOnBase.command:${root}");
  });

  test("the sandbox the command runs in is stated before Run, both ways", () => {
    expect(code).toContain("It runs in a box with no network");
    expect(code).toContain("No sandbox is available on this machine");
  });

  test("with no sandbox the Run button waits for a tick that is reset every time the box opens", () => {
    expect(code).toContain('const needsSay = plan.sandbox === "none" && !noBox;');
    expect(code).toContain("disabled={!!blocked || !!problem || needsSay}");
    expect(body("open")).toContain("setNoBox(false)");
  });

  test("it states counts, never a verdict", () => {
    for (const w of [/not your/i, /your fault/i, /innocent/i, /guilty/i, /proves/i]) expect(code).not.toMatch(w);
  });
});
