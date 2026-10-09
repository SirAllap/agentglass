import { expect, test } from "bun:test";
import { Glob } from "bun";

// bun runs every web test in one process, and the keybindings module keeps its
// bindings and chords in module-level caches that the localStorage stub of a
// test file does not clear. A file that imports the SHARED module (no `?query`
// copy) and rebinds something has to hand the defaults back in an afterAll, or
// the next file starts with a customised keyboard: pane-state's "flag only what
// was changed" read appChords as customised under `bun test --seed 5`, because
// the file before it ended on a rebound palette chord.
//
// Its ceiling: a line-level read of the source. It checks the afterAll names the
// matching reset on one line; a reset that exists but never runs is not caught.
const PAIRS: [call: RegExp, reset: string][] = [
  [/\.rebindAppChord\(/, "resetAppChords"],
  [/\.(rebindChord|clearChord)\(/, "resetChords"],
  [/\.rebind\(/, "resetBindings"],
];

test("a test that rebinds on the shared keybindings module gives the defaults back in afterAll", async () => {
  const dir = import.meta.dir;
  const files = [...new Glob("*.test.ts").scanSync({ cwd: dir })].filter((f) => f !== "keybindings-leak-guard.test.ts");
  const offenders: string[] = [];
  for (const f of files) {
    const src = (await Bun.file(`${dir}/${f}`).text()).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    if (!/(?<!typeof )import\(\s*["']\.\.\/src\/lib\/keybindings\.ts["']\s*\)/.test(src)) continue;
    const afterAlls = (src.match(/afterAll\([^\n]*/g) ?? []).join("\n");
    for (const [call, reset] of PAIRS) {
      if (call.test(src) && !afterAlls.includes(`${reset}(`)) offenders.push(`${f}: ${call.source} without ${reset}() in an afterAll`);
    }
  }
  expect(offenders).toEqual([]);
});
