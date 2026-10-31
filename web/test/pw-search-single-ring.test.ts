// The watch menu's check search drew two rings when focused: the box's own
// (:focus-within) and the global :focus-visible outline on the input inside it,
// which outranks `.pw-search input { outline: 0 }`.
import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

test("the check search's input gives up its own focus ring to the box around it", () => {
  expect(css).toContain(".pw-search:focus-within {");
  expect(css).toMatch(/\.pw-search input:focus-visible \{ outline: 0 !important; \}/);
});

// The same slip, anywhere: a bare field (no border of its own, so a parent
// frames it) whose stylesheet rule turns the outline off loses to the global
// `:focus-visible:not([tabindex])` rule, which is `!important`. It needs a
// `:focus-visible` twin with `outline: 0 !important`, or the field keeps a ring
// inside the box that already has one. A field that carries its own border is
// the frame itself, and its ring is the right one.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("every bare input rule that sets outline 0/none has a !important :focus-visible twin", () => {
  const rules = [...css.matchAll(/([^{}/]+)\{([^{}]*)\}/g)];
  const bare = rules
    .filter(([, sel, body]) => /\b(input|textarea|select)\b/.test(sel!) && /outline:\s*(0|none)\b/.test(body!)
      && /\bborder:\s*(0|none)\b/.test(body!) && !/:focus/.test(sel!))
    .map(([, sel]) => sel!.trim());
  expect(bare.length).toBeGreaterThan(0);
  for (const sel of bare) {
    const twin = sel.split(",").every((s) =>
      new RegExp(`${esc(s.trim())}:focus-visible\\s*\\{[^}]*outline:\\s*(0|none)\\s*!important`).test(css));
    expect(twin, `${sel} needs a :focus-visible twin`).toBe(true);
  }
});
