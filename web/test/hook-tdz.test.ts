// A component may not read its own state above the line that creates it.
//
// This exists because that shipped, twice, to a desktop install:
//
//   const here = repos.find((r) => r.root === root) ?? null;
//   const [root, setRoot] = useState(...);
//
// `root` is a const, so the lookup ran inside its temporal dead zone and threw
// `ReferenceError: Cannot access 'root' before initialization` on the panel's
// first render — which React reports as a crash of the whole tree, so the
// window came up empty rather than one panel short.
//
// Nothing already here could catch it. tsc cannot: the read is inside the
// `find` callback, where it looks deferred, and TS2448 only fires on a direct
// use. No suite mounts that panel, so all of them passed. The build was clean.
// It was found by reading a stack trace in a devtools console, twice, by the
// person whose window had gone black.
//
// So the check is on the source. It looks only at initialisers that run
// SYNCHRONOUSLY during render — `const x = <expr>` at the top level of a
// component body — because those are the ones that can hit the dead zone. A
// `useEffect(() => … root …)` above the declaration is fine: the callback runs
// after the render that defined it, and flagging it would be noise.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Deferred: the callback is stored and run later, so a name from below is not
 *  in its dead zone by the time it is read. `useMemo` is NOT here — it runs its
 *  callback during render, which is exactly when the dead zone is open. */
const DEFERRED = /\buse(Effect|LayoutEffect|Callback|ImperativeHandle)\s*\(/;

export type Hit = { file: string; name: string; usedAt: number; declaredAt: number; line: string };

/** Where the block containing this declaration begins: the nearest line above
 *  it, less indented, that opens a body. Without this the search runs off the
 *  top of the file and compares one component's locals against another's state,
 *  which is 84 findings and no signal. */
function bodyStart(lines: string[], declLine: number, indent: number): number {
  for (let i = declLine - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const ind = l.length - l.trimStart().length;
    if (ind < indent && /\{\s*$/.test(l)) return i + 1;
  }
  return 0;
}

/** Quoted text and comments are not reads. `scopeSessions(s, "live")` is not a
 *  use of a variable called `live`. */
const code = (l: string) => l
  .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""')
  .replace(/\/\/.*$/, "")
  // A regular expression is not code that reads names: `/^(?:(\d{1,2}))$/`
  // contains a `d`, and that was enough to accuse a `const d` of being read.
  // The branches do not overlap on purpose: `[` can only be matched by the
  // character-class branch, never by the "anything else" one. With both able to
  // consume it the engine has two ways to reach the same position, which is the
  // shape a scanner reads as backtracking that can be made to explode — fairly,
  // even though the only input here is this repository's own source.
  .replace(/\/(?![*/])(?:\\.|\[[^\]\n]*\]|[^/\\\n[])+\/[gimsuy]*/g, "//")
  // `s.done`, `tree?.branch`, `m.at` — a property that happens to share a name
  // with a local is not a read of it, and this file is full of them.
  .replace(/\??\.\s*\w+/g, ".")
  // `{ key: string; rows: PrSummary[] }` — a type's field, same story.
  .replace(/\b\w+\s*:/g, ":");

/** Exported so the test below can prove it catches the real thing. */
export function findTdzReads(source: string, file = "<src>"): Hit[] {
  const lines = source.split("\n");
  const hits: Hit[] = [];
  const decls: { name: string; line: number; indent: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)const \[\s*(\w+)\s*,[^\]]*\]\s*=\s*(?:React\.)?use(?:State|Reducer)\s*[(<]/.exec(l);
    if (m) { decls.push({ name: m[2]!, line: i, indent: m[1]!.length }); return; }
    /*
     * And a plain `const x = …` in the same body, which is the shape that got
     * through: `const railActive = …lit…` five hundred lines above
     * `const lit = wanted ?? data?.view?.id`. A derived value is as dead in its
     * dead zone as a hook's, and the panel threw on first render — a blank
     * window, every open, found in a devtools console again.
     *
     * A function declared with `const f = () => …` is excluded: it is only a
     * problem if it RUNS during render, and where it does, the call itself
     * shows up as a read on that line anyway.
     */
    const c = /^(\s*)const (\w+)\s*(?::[^=]+)?=\s*(.*)$/.exec(l);
    if (c && !/^\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/.test(c[3]!) && !/^\s*function\b/.test(c[3]!)) {
      decls.push({ name: c[2]!, line: i, indent: c[1]!.length });
    }
  });

  for (const d of decls) {
    const from = bodyStart(lines, d.line, d.indent);
    /* A parameter of the function this body belongs to is not the same name:
       `function slug(name: string)` shadows any `const name` further down, and
       reading it above that const is correct. */
    const sig = lines.slice(Math.max(0, from - 3), from).join(" ");
    if (new RegExp(`[(,]\\s*${d.name}\\s*[:,)=]`).test(sig)) continue;
    for (let i = from; i < d.line; i++) {
      const raw = lines[i]!;
      const t = raw.trim();
      if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      // Only a synchronous initialiser at the same nesting level as the
      // declaration: `const x = …` in the same component body.
      if (!new RegExp(`^\\s{${d.indent}}const\\s`).test(raw)) continue;
      const l = code(raw);
      if (DEFERRED.test(l)) continue;
      if (!new RegExp(`\\b${d.name}\\b`).test(l)) continue;
      // A binding of the same name is a different variable, not a read of this
      // one: `const [root` above, or `(root: string) =>` as a parameter.
      if (new RegExp(`const \\[\\s*${d.name}\\b`).test(l)) continue;
      if (new RegExp(`[(,]\\s*${d.name}\\s*[:,)]`).test(l)) continue;
      hits.push({ file, name: d.name, usedAt: i + 1, declaredAt: d.line + 1, line: t.slice(0, 100) });
      break;
    }
  }
  return hits;
}

describe("a component cannot read its own state before it exists", () => {
  it("catches the shape that actually shipped", () => {
    // The check is worth nothing unless it fails on the real bug, so here it is
    // verbatim, and the fixed order beside it.
    const broken = `
export function TerminalPanel() {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const here = repos.find((r) => r.root === root) ?? null;
  const [root, setRoot] = useState<string>(() => "");
}`;
    const fixed = `
export function TerminalPanel() {
  const [repos, setRepos] = useState<GitRepoRef[]>([]);
  const [root, setRoot] = useState<string>(() => "");
  const here = repos.find((r) => r.root === root) ?? null;
}`;
    const hit = findTdzReads(broken);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.name).toBe("root");
    expect(findTdzReads(fixed)).toEqual([]);
  });

  it("catches a derived const too, which is how the second one shipped", () => {
    /* `const railActive = …lit…` five hundred lines above `const lit = …`.
       Same dead zone, same blank window, and the first version of this check
       only looked at useState — so it passed. */
    const broken = `
export function TasksView() {
  const [boards, setBoards] = useState(null);
  const railActive = (boards?.views ?? []).find((x) => x.id === lit)?.name ?? "";
  const lit = wanted ?? data?.view?.id;
}`;
    const hit = findTdzReads(broken);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.name).toBe("lit");
  });

  it("leaves deferred callbacks alone", () => {
    // These read a name from below and are correct: the callback runs after the
    // render that defined it. A check that flagged them would be turned off.
    const fine = `
export function P() {
  const cb = useCallback(() => go(root), [root]);
  const [root, setRoot] = useState("");
}`;
    expect(findTdzReads(fine)).toEqual([]);
  });

  it("no component in the app does it", () => {
    const hits = walk(SRC).flatMap((f) => findTdzReads(readFileSync(f, "utf8"), f.slice(SRC.length + 1)));
    const report = hits.map((h) => `  ${h.file}: '${h.name}' read at line ${h.usedAt}, created at ${h.declaredAt}\n    ${h.line}`).join("\n");
    expect(report).toBe("");
  });
});
