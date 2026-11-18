// Every background job the server schedules names itself to the loop watch.
//
// An earlier measurement found most stalls unlabelled, so nobody could say what
// blocked the loop. This is the guard that keeps it from drifting back: each
// setInterval/setTimeout in server/src, and each synchronous spawn, must run
// under a label — waitedFor(...), setTimeoutAs/setIntervalAs/spawnSyncAs — or
// carry a `loop-ok: <reason>` comment, or be one of the cheap shapes below.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "src");
// Subfolders too (agents/, relay/ ...): a bare sync spawn in agents/ blocked the loop unnamed.
const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
  // Own processes (no loop watch there): the broker and the terminal relay's child.
  && f !== "broker/brokerMain.ts" && f !== "relay/termrelay.ts");

/** Index just past the `)` that closes the call whose `(` is at `open`. Strings skipped. */
export function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < s.length && s[i] !== c; i++) if (s[i] === "\\") i++;
    } else if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; }
    else if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i + 2); if (i < 0) return s.length; i++; }
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return s.length;
}

/** A callback that only ends something: kill a child, abort a fetch, settle a promise. */
const CHEAP = /^\(?\s*(?:\w+(?:,\s*\w+)*)?\s*\)?\s*(?:=>)?\s*\{?\s*(?:try\s*\{\s*)?(?:timedOut\s*=\s*true;\s*)?(?:[\w.?]+\.(?:kill|abort|destroy)\(|process\.kill\(|(?:r|r2|res|rej|no|ok|done|resolve|reject|release|settle|finish|kill|stop|mine\.kill|ctl\.abort)\(?\b)/;

function sites(src: string, name: RegExp) {
  const out: { at: number; line: number; text: string }[] = [];
  for (const m of src.matchAll(name)) {
    const at = m.index!;
    const lineStart = src.lastIndexOf("\n", at) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, at + 1))) continue; // comment
    if (/^\s*import /.test(src.slice(lineStart, src.indexOf("\n", at)))) continue;
    const open = at + m[0].length - 1;
    out.push({ at, line: src.slice(0, at).split("\n").length, text: src.slice(open + 1, closeOf(src, open) - 1) });
  }
  return out;
}

function offenders(): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    if (f === "loopwatch.ts") continue; // the helpers and the watchdog's own heartbeat
    const spans = sites(src, /\bwaitedFor\(/g).map((s) => [s.at, s.at + s.text.length + 12] as const);
    const covered = (at: number) => spans.some(([a, b]) => at > a && at < b);
    const lines = src.split("\n");
    const waived = (line: number) => /loop-ok:/.test(lines[line - 1] + (lines[line - 2] ?? "") + (lines[line - 3] ?? ""));
    for (const s of sites(src, /(?<![\w.])(?:globalThis\.)?set(?:Interval|Timeout)\(/g)) {
      if (covered(s.at) || waived(s.line) || /\bwaitedFor\(/.test(s.text)) continue;
      if (CHEAP.test(s.text.trim())) continue;
      bad.push(`${f}:${s.line} timer: ${s.text.trim().slice(0, 60).replace(/\s+/g, " ")}`);
    }
    for (const s of sites(src, /(?<![\w])(?:Bun\.spawnSync|spawnSync|execFileSync|execSync)\(/g)) {
      if (covered(s.at) || waived(s.line)) continue;
      bad.push(`${f}:${s.line} sync spawn: ${s.text.trim().slice(0, 60).replace(/\s+/g, " ")}`);
    }
  }
  return bad;
}

describe("background jobs name themselves to the loop watch", () => {
  it("every timer callback and sync spawn is labelled or allow-listed", () => {
    expect(offenders()).toEqual([]);
  });
  it("the guard sees a bare timer", () => {
    const [s] = sites("setInterval(() => sweep(), 5)", /(?<![\w.])setInterval\(/g);
    expect(CHEAP.test(s!.text.trim())).toBe(false);
  });
  it("the guard lets a kill timer through", () => {
    const [s] = sites("setTimeout(() => { try { proc.kill(); } catch {} }, 5)", /(?<![\w.])setTimeout\(/g);
    expect(CHEAP.test(s!.text.trim())).toBe(true);
  });
});
