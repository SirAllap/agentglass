// Installing must not eat somebody's own status line.
//
// `statusLine` is a single slot, so taking it means owning it, and the
// installer chains whatever was there so both still run. Recognising "whatever
// was there" is the whole game, and it was being done with
// `"statusline.sh" in cmd` — a substring test that a user's own
// `mi-statusline.sh`, `custom-statusline.sh` or the widely used
// `ccstatusline.sh` all satisfy. The installer read those as its own, tried to
// unwrap a command that had never been wrapped, found no third argument, and
// wrote none. Their status line was gone, with no error and no mention.
//
// Nothing here touches the real ~/.claude: every case installs into a throwaway
// project directory, which is what `--project` is for.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER = join(import.meta.dir, "..", "..", "hooks", "install_hooks.py");
const has = !!Bun.which("python3");
let boxes: string[] = [];

afterEach(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); boxes = []; });

function project(settings: unknown): string {
  const box = mkdtempSync(join(tmpdir(), "agx-hooks-"));
  boxes.push(box);
  mkdirSync(join(box, ".claude"), { recursive: true });
  writeFileSync(join(box, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  return box;
}
const run = (box: string, ...extra: string[]) =>
  Bun.spawnSync(["python3", INSTALLER, "--project", box, ...extra], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
const read = (box: string) => JSON.parse(readFileSync(join(box, ".claude", "settings.json"), "utf8"));
const line = (box: string): string | undefined => read(box)?.statusLine?.command;

describe.if(has)("the status line slot is borrowed, not taken", () => {
  // The first is the report that found this; the rest are the names a real
  // person's status line actually has. Every one of them contains the string
  // the old check looked for.
  for (const cmd of [
    "~/bin/mi-statusline.sh --fancy",
    "~/.local/bin/ccstatusline.sh",
    "npx ccstatusline@latest",
    "/usr/bin/starship prompt",
  ]) {
    test(`survives install and comes back exactly: ${cmd}`, () => {
      const box = project({ statusLine: { type: "command", command: cmd } });
      expect(run(box).exitCode).toBe(0);
      // Still ours while installed — and carrying theirs as its argument.
      expect(line(box)).toMatch(/^sh "/);
      expect(line(box)).toContain("statusline.sh");
      expect(run(box, "--uninstall").exitCode).toBe(0);
      expect(line(box)).toBe(cmd);
    });
  }

  test("a slot that was empty is left empty", () => {
    const box = project({});
    run(box);
    run(box, "--uninstall");
    expect("statusLine" in read(box)).toBe(false);
  });

  test("installing twice does not wrap the wrapper", () => {
    // Re-installing re-points the script path; it must not end up chaining its
    // own previous command and running the user's line twice.
    const box = project({ statusLine: { type: "command", command: "~/bin/mine.sh" } });
    run(box);
    const once = line(box);
    run(box);
    expect(line(box)).toBe(once!);
    run(box, "--uninstall");
    expect(line(box)).toBe("~/bin/mine.sh");
  });

  test("hooks somebody else installed are left alone", () => {
    const guard = { matcher: "Bash", hooks: [{ type: "command", command: "~/bin/my-guard.sh" }] };
    const box = project({ hooks: { PreToolUse: [guard] }, miAjuste: true });
    run(box);
    run(box, "--uninstall");
    const back = read(box);
    expect(back.hooks.PreToolUse).toEqual([guard]);
    expect(back.miAjuste).toBe(true);
  });
});
