import { describe, expect, it } from "bun:test";

/*
 * No hook below an early return. Ever.
 *
 * This is the third blank screen in this file from the same cause, and the
 * third is what makes it a test rather than a comment — the second one already
 * had a comment on the very line, and the comment did not stop the next hook
 * from being written directly underneath it.
 *
 * The failure has no symptom worth debugging: React counts hooks per render, so
 * a `useCallback` under `if (list.length === 0) return <Empty/>` renders a
 * different number depending on whether the list is empty. React answers with
 * error #310 and an empty document, which looks exactly like a broken build.
 *
 * Source-level and deliberately blunt. It cannot be fooled by a hook inside a
 * nested closure, so it counts a `return <JSX` at the function's own
 * indentation as the boundary and nothing else — that is the shape that breaks.
 */
const FILES = ["../src/components/TasksPanel.tsx"];

/** A component's body, split at its first early return of JSX. */
function scan(src: string): { fn: string; hook: string; line: number }[] {
  const bad: { fn: string; hook: string; line: number }[] = [];
  const lines = src.split("\n");
  let fn = "";
  let returned = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const decl = /^(?:export )?function ([A-Z]\w*)\s*\(/.exec(l);
    if (decl) { fn = decl[1]!; returned = 0; continue; }
    if (!fn) continue;
    // Two spaces exactly: the function's own body, not a callback inside it.
    if (/^ {2}if .*\breturn <\w/.test(l) || /^ {2}return <\w/.test(l)) { if (!returned) returned = i + 1; continue; }
    if (!returned) continue;
    const hook = /^ {2}(?:const|let)?\s*.*\b(use[A-Z]\w*)\(/.exec(l);
    if (hook) bad.push({ fn, hook: hook[1]!, line: i + 1 });
  }
  return bad;
}

describe("hooks and early returns", () => {
  it("has no hook below an early return, in any component", async () => {
    for (const rel of FILES) {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      const bad = scan(src);
      const where = bad.map((b) => `${b.fn}: ${b.hook} at line ${b.line}`).join("\n");
      expect(bad.length, `a hook runs conditionally, which renders a blank screen:\n${where}`).toBe(0);
    }
  });

  it("catches the shape it is meant to catch", () => {
    // The check earning its keep: this is exactly what was written three times.
    const broken = [
      "function Thing() {",
      "  const [a, setA] = useState(0);",
      "  if (!a) return <Empty />;",
      "  const b = useCallback(() => a, [a]);",
      "  return <div />;",
      "}",
    ].join("\n");
    expect(scan(broken).map((b) => b.hook)).toEqual(["useCallback"]);
  });

  it("does not object to a hook inside a callback below the return", () => {
    const fine = [
      "function Thing() {",
      "  const [a] = useState(0);",
      "  if (!a) return <Empty />;",
      "  return <div onClick={() => { const x = useless(1); }} />;",
      "}",
    ].join("\n");
    expect(scan(fine)).toEqual([]);
  });
});
