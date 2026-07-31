/**
 * Run a real shell under a real pty with the integration installed, type a few
 * commands, and print what the parser made of them.
 *
 * The only test that can fail for the right reason. Everything else about this
 * feature is a state machine fed strings a test wrote — which proves the parser
 * and proves nothing about whether `trap DEBUG` and `PROMPT_COMMAND` actually
 * emit those strings from a shell that has just sourced somebody's `.bashrc`.
 *
 * A child process because it spawns a login shell and points HOME at a scratch
 * directory, and neither belongs anywhere near the shared `bun test` process.
 *
 * Argv: <shell path> <scratch home>
 */
export {};

import { mkdirSync, writeFileSync } from "node:fs";
import { install } from "../../src/shellmark.ts";
import { ShellMarkers, type ShellCommand } from "../../src/shellparse.ts";

const shell = process.argv[2]!;
const home = process.argv[3]!;

mkdirSync(home, { recursive: true });
/*
 * A user's own rc, with the two things most likely to collide:
 *
 *  - a PROMPT_COMMAND of their own, which an integration that *assigns* to it
 *    silently eats. This file's marker is what proves it was chained.
 *  - a custom PS1, which is the whole reason prompt scraping was rejected.
 */
writeFileSync(`${home}/.bashrc`, [
  `export AGX_USER_RC_RAN=1`,
  `PROMPT_COMMAND='AGX_THEIR_PROMPT_RAN=$((\${AGX_THEIR_PROMPT_RAN:-0}+1))'`,
  `PS1='\\[\\e[32m\\]weird-prompt>\\[\\e[0m\\] '`,
].join("\n") + "\n");
writeFileSync(`${home}/.bash_profile`, `export AGX_LOGIN_RAN=1\n[ -f ~/.bashrc ] && . ~/.bashrc\n`);

const wired = install(shell);
if (!wired) { console.log(JSON.stringify({ error: "install() declined" })); process.exit(2); }

const got: ShellCommand[] = [];
const markers = new ShellMarkers((c) => got.push(c));

const proc = Bun.spawn(wired.argv(shell), {
  cwd: home,
  // Named, and HOME pointed at the scratch tree: this sources rc files, and it
  // must never be the developer's.
  env: { PATH: process.env.PATH ?? "", HOME: home, TERM: "xterm-256color", ...wired.env },
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});

let raw = "";
const pump = async (s: ReadableStream<Uint8Array> | null) => {
  if (!s) return;
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    if (value?.length) { markers.feed(value); raw += new TextDecoder().decode(value); }
  }
};
const pumping = Promise.all([pump(proc.stdout as any), pump(proc.stderr as any)]);

const w = proc.stdin as any;
const send = async (s: string) => { w.write(s); w.flush?.(); await Bun.sleep(400); };

await Bun.sleep(600);
await send("echo hello\n");
await send("false\n");
await send("mkdir -p sub && cd sub\n");
await send("pwd\n");
await send("\n");                       // an empty line: must not become a command
// Proof their PROMPT_COMMAND still runs — a *printed* fact, not a variable
// nobody reads. An earlier version of this check looked for the variable name
// in the output, where it never appears, and so passed no matter what.
await send("echo theirs=$AGX_THEIR_PROMPT_RAN\n");
await send("exit\n");
w.end?.();
await Promise.race([pumping, Bun.sleep(3000)]);
try { proc.kill(); } catch { /* gone */ }
wired.dispose();

console.log(JSON.stringify({
  family: wired.family,
  commands: got,
  directory: markers.directory,
  // Proof the user's own configuration survived being shimmed.
  // Their PS1 reached the screen, and their PROMPT_COMMAND has been running.
  theirPs1: /weird-prompt/.test(raw),
  theirPromptCommandRuns: /theirs=[1-9]/.test(raw),
  raw: raw.slice(-4000),
}));
