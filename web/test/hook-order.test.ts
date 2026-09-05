import { describe, expect, it } from "bun:test";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
/*
 * EVERY component, not one file.
 *
 * This guard used to name a single path, and a guard that names one file
 * protects one file. The fourth blank screen came from a `useRef` written под
 * `if (!data) return <Empty/>` in a completely different panel, which this test
 * was in no position to see — it was passing at the time, on TasksPanel.tsx.
 *
 * A rule that holds everywhere has to be checked everywhere, so it walks the
 * tree. On the run that widened it: 139 files, and every one of the fifteen
 * initial hits was a false positive of the scanner rather than a real defect —
 * which is the other half of why the scan is here, because "it looked fine" is
 * not a measurement.
 */
function* components(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) yield* components(f);
    else if (f.endsWith(".tsx")) yield f;
  }
}

/** A component's body, split at its first early return of JSX. */
function scan(src: string): { fn: string; hook: string; line: number }[] {
  const bad: { fn: string; hook: string; line: number }[] = [];
  const lines = src.split("\n");
  let fn = "";
  let returned = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    /*
     * ANY top-level function ends the previous one — including a lower-case
     * custom hook, and that was the bug in the scanner itself.
     *
     * It only recognised `function Capitalised(`, so a `function useThing(` —
     * or a generic `function useSearch<T>(`, whose name is followed by an angle
     * bracket rather than a paren —
     * declared after a component never reset the state. Every hook inside that
     * custom hook was then reported as sitting under the previous component's
     * early return, and all four "findings" on the first wide run were this.
     * A guard that cries wolf is a guard people learn to skip.
     */
    const any = /^(?:export )?(?:async )?function (\w+)\s*[<(]/.exec(l);
    if (any) { fn = /^[A-Z]/.test(any[1]!) ? any[1]! : ""; returned = 0; continue; }
    // A module-level `const Thing = (...) =>` is a component too, and it ends
    // whatever came before it just as firmly as a `function` does.
    const arrow = /^(?:export )?const (\w+)\s*[:=]/.exec(l);
    if (arrow) { fn = /^[A-Z]/.test(arrow[1]!) ? arrow[1]! : ""; returned = 0; continue; }
    if (!fn) continue;
    // Two spaces exactly: the function's own body, not a callback inside it.
    // `return null` breaks the hook count exactly as `return <JSX/>` does, and
    // it is the more common shape for "this panel is not showing".
    if (/^ {2}if .*\breturn (<\w|null)/.test(l) || /^ {2}return (<\w|null)/.test(l)) { if (!returned) returned = i + 1; continue; }
    if (!returned) continue;
    const hook = /^ {2}(?:const|let)?\s*.*\b(use[A-Z]\w*)\(/.exec(l);
    if (hook) bad.push({ fn, hook: hook[1]!, line: i + 1 });
  }
  return bad;
}

describe("hooks and early returns", () => {
  it("has no hook below an early return, in any component", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const found: string[] = [];
    let files = 0;
    for (const f of components(root)) {
      files++;
      for (const b of scan(readFileSync(f, "utf8"))) {
        found.push(`${f.slice(root.length + 1)}:${b.line}  ${b.fn} calls ${b.hook}`);
      }
    }
    // A guard that walks nothing passes trivially, so assert it walked.
    expect(files, "the component tree should not be empty").toBeGreaterThan(50);
    expect(found.length, `a hook runs conditionally, which renders a blank screen:\n${found.join("\n")}`).toBe(0);
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

  it("catches the exact shape that took the Teach panel down", () => {
    // Verbatim: a `useRef` written below `if (!data) return <Empty/>`, which
    // rendered fine while the fetch was in flight and threw React #310 the
    // instant the data arrived and the hook count changed.
    const teach = [
      "function Teach() {",
      "  const [data, setData] = useState(null);",
      "  if (!active) return null;",
      "  if (!data) return <Empty what=\"…\" />;",
      "  const receipt = useRef(null);",
      "  return <div />;",
      "}",
    ].join("\n");
    expect(scan(teach).map((b) => b.hook)).toEqual(["useRef"]);
  });

  it("is not fooled by a custom hook or a generic declared after a component", () => {
    // Every one of the fifteen hits on the first wide run was this: the scanner
    // did not treat `function useThing(` as the end of the component above it,
    // so the component's early return leaked into the hook's body. A guard that
    // reports fifteen phantoms is a guard nobody reads.
    const src = [
      "function Panel() {",
      "  if (!ok) return null;",
      "  return <div />;",
      "}",
      "",
      "function useSearch<T>(run: () => Promise<T>) {",
      "  const [state, setState] = useState(null);",
      "  const seq = useRef(0);",
      "  return state;",
      "}",
    ].join("\n");
    expect(scan(src)).toEqual([]);
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
