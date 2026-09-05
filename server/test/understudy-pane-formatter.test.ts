/*
 * The pane's formatter has to travel with the run.
 *
 * It was resolved with `import.meta.url` against `../../scripts/`, which is
 * correct in a checkout and wrong from the installed bundle — there that path
 * resolves to `/scripts/understudy-watch.py`, and the pane's first and only
 * line was python3 saying it could not open the file. Every test passed; the
 * tree the tests run in is the one place the path worked.
 *
 * So the script is embedded and written beside the brief. These hold the copy
 * in step with the file people actually read and edit.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
const onDisk = await Bun.file(new URL("../../scripts/understudy-watch.py", import.meta.url)).text();

describe("carried, not looked up", () => {
  test("nothing resolves the formatter against the source tree", () => {
    const fn = src.slice(src.indexOf("async function runAgentInPane("),
      src.indexOf("\nasync function runAgentIn("));
    /*
     * Code, not prose — for the fourth time today. The comment above the fix
     * names the path it stopped using, so an assertion over the whole function
     * fails on the paragraph explaining why it passes.
     */
    const code = fn.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code, "a path relative to the checkout is wrong once installed")
      .not.toContain("scripts/understudy-watch.py");
    expect(code).toContain("WATCH_PY");
  });

  test("the embedded copy is the file on disk, character for character", () => {
    /*
     * Two copies of anything drift. This one drifts silently: the pane would
     * keep formatting with whatever was embedded whenever somebody edited the
     * script, and the difference only shows as slightly wrong output nobody
     * can trace back.
     */
    const from = src.indexOf("const WATCH_PY = `") + "const WATCH_PY = `".length;
    const embedded = src.slice(from, src.indexOf("`;", from))
      .replaceAll("\\`", "`").replaceAll("\\${", "${").replaceAll("\\\\", "\\");
    expect(embedded).toBe(onDisk);
  });

  test("it reads the stream and prints as it goes", () => {
    // Buffered output would be a pane that fills up in one jump at the end,
    // which is the thing this whole path exists to stop.
    expect(onDisk).toContain("flush=True");
  });
});

describe("legible at a glance, which is the only thing it is for", () => {
  /*
   * The first working version read, fourteen rows deep:
   *
   *     Bash …ass-understudy-the-tracker-fence-does-no
   *     Bash …\(fail\)|^\s*[0-9]+ (pass|fail|skip)|Ran [0
   *
   * The tool's name and the middle of something. Two causes, and the font size
   * was the smaller one: a tmux window with no client attached is 80 columns,
   * so every line was cut there before it ever reached the panel.
   */
  test("the run's window is made wide, and only that window", () => {
    const fn = src.slice(src.indexOf("async function runAgentInPane("),
      src.indexOf("\nasync function runAgentIn("));
    const code = fn.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).toContain('"resize-window"');
    // `window-size` set on the SESSION pins every window in it, which has
    // already once shrunk seven of somebody's real ones. Per window id.
    expect(code).toContain('"set-window-option", "-t", win.windowId, "window-size"');
    expect(code).not.toContain('"set-option", "-t"');
  });

  test("a command is cut from the right and a path from the left", () => {
    /*
     * Opposite rules because they identify themselves at opposite ends. A file
     * is its last segment; a command is its first words. Cutting commands from
     * the left is what produced rows of directory-name middles.
     */
    expect(onDisk).toContain("def head(");
    expect(onDisk).toContain("def tail(");
    expect(onDisk).toContain('return cmd if len(cmd) <= keep else cmd[:keep - 1] + "…"');
  });
});
