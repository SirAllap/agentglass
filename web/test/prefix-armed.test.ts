/*
 * The tmux prefix, mirrored without a clock. It arms on the prefix chord and
 * stays armed until the very next key: a digit picks that window, `n` opens a
 * new one, anything else (Esc included) or a pointer press puts it down. No
 * timer, because tmux itself waits as long as you do and a mark that expires
 * on its own lies about the one thing it is for.
 */
import { describe, expect, test } from "bun:test";
import { prefixStep, prefixByte } from "../src/lib/prefixArmed.ts";

const PFX = ["C-f"];
const key = (data: string) => ({ type: "key", data }) as const;
const armed = prefixStep(false, key("\u0006"), PFX);

describe("arming", () => {
  test("the prefix chord arms and asks for nothing", () => {
    expect(armed).toEqual({ armed: true, action: null });
  });
  test("any prefix the session has can arm", () => {
    expect(prefixStep(false, key("\u0002"), ["C-b", "C-f"]).armed).toBe(true);
  });
  test("a key that is not the prefix does nothing while idle, digits included", () => {
    expect(prefixStep(false, key("3"), PFX)).toEqual({ armed: false, action: null });
    expect(prefixStep(false, key("n"), PFX)).toEqual({ armed: false, action: null });
  });
  test("a prefix tmux was not told about never arms", () => {
    expect(prefixStep(false, key("\u0006"), [])).toEqual({ armed: false, action: null });
    expect(prefixStep(false, key("\u0006"), ["F12"])).toEqual({ armed: false, action: null });
  });
  test("a meta prefix arms on escape plus the key", () => {
    expect(prefixStep(false, key("\u001ba"), ["M-a"]).armed).toBe(true);
  });
  test("a pasted run that merely contains the prefix byte does not arm", () => {
    expect(prefixStep(false, key("ab\u0006"), PFX).armed).toBe(false);
  });
});

describe("the next key", () => {
  test("a digit 1-9 selects that window and disarms", () => {
    for (let n = 1; n <= 9; n++) expect(prefixStep(true, key(String(n)), PFX)).toEqual({ armed: false, action: { type: "select", n } });
  });
  test("0 is not a window", () => {
    expect(prefixStep(true, key("0"), PFX)).toEqual({ armed: false, action: null });
  });
  test("c opens a new window; n stays tmux's next-window and just disarms", () => {
    expect(prefixStep(true, key("c"), PFX)).toEqual({ armed: false, action: { type: "new" } });
    expect(prefixStep(true, key("n"), PFX)).toEqual({ armed: false, action: null });
  });
  test("Esc disarms", () => {
    expect(prefixStep(true, key("\u001b"), PFX)).toEqual({ armed: false, action: null });
  });
  test("any other key disarms and asks for nothing", () => {
    for (const k of ["x", "N", "\r", "\u001b[A"]) expect(prefixStep(true, key(k), PFX)).toEqual({ armed: false, action: null });
  });
  test("the prefix chord again is the literal prefix sent through: disarm, no re-arm", () => {
    expect(prefixStep(true, key("\u0006"), PFX)).toEqual({ armed: false, action: null });
  });
  test("a pointer press disarms", () => {
    expect(prefixStep(true, { type: "pointer" }, PFX)).toEqual({ armed: false, action: null });
  });
  test("a pointer press while idle changes nothing", () => {
    expect(prefixStep(false, { type: "pointer" }, PFX)).toEqual({ armed: false, action: null });
  });
});

describe("prefixByte", () => {
  test("C-x is the control byte, M-x is escape plus x, anything else is null", () => {
    expect(prefixByte("C-f")).toBe("\u0006");
    expect(prefixByte("C-b")).toBe("\u0002");
    expect(prefixByte("M-a")).toBe("\u001ba");
    expect(prefixByte("F12")).toBeNull();
    expect(prefixByte("C-1")).toBeNull();
  });
});
