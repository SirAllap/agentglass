import { describe, expect, test } from "bun:test";

const src = (f: string) => Bun.file(new URL(`../src/components/${f}`, import.meta.url)).text();
const select = await src("Select.tsx");
const chrome = await src("workspace/Chrome.tsx");
const row = await src("SettingRow.tsx");

/* The Review prompts editor is a <form> that saves on submit. Opening its Group select (a <button> with no
   type, so a submit button) saved the prompt before anything was chosen. Measured: "<title> saved" appeared
   on a click that only opened the list. A button is type="button" unless a caller says submit. */
describe("a control inside a settings form does not submit it", () => {
  test("the Select trigger and its options are type=button", () => {
    const trigger = select.slice(select.indexOf('role="combobox"') - 260, select.indexOf('role="combobox"'));
    expect(trigger).toContain('type="button"');
    expect(select).toContain('<button type="button" key={o.value}');
  });
  test("Button defaults to type=button and lets a caller pass submit", () => {
    const at = chrome.indexOf("{...rest}\n      disabled={disabled || pending}");
    expect(at).toBeGreaterThan(0);
    expect(chrome.slice(at - 40, at)).toContain('type="button"');
  });
  test("a row that is a button is type=button", () => {
    expect(row).toContain('<button type="button" onClick={onClick} disabled={disabled} role={role}');
  });
});
