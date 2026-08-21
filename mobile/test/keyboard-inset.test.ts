/*
 * Nobody may hand KeyboardAvoidingView a behaviour that is nothing on Android.
 *
 * This is the bug that hid the chat input behind the keyboard on his own
 * phone. Two screens carried
 *
 *   behavior={Platform.OS === "ios" ? "padding" : undefined}
 *
 * which on Android means the view does not avoid the keyboard at all. It read
 * as harmless for as long as the system resized the window under
 * `adjustResize` — the window shrank, the input came with it, and the prop
 * never had to work. That stopped: Expo Go targets SDK 36, and from Android 15
 * a window that opted into edge-to-edge (app.json, `edgeToEdgeEnabled`) is not
 * resized for the IME. The prop was suddenly the only thing holding the input
 * up, and it was `undefined`.
 *
 * MEASURED on two emulators, same Expo Go 57.0.3, same bundle: on API 34 the
 * chat input rose above the keyboard, on API 36 it was drawn behind it. So the
 * ONE test a source file can carry is this: `padding`, on both platforms, with
 * the offset spelt out. The arithmetic that makes one expression right on both
 * — `frame.y + frame.height - keyboardTop`, which comes out zero when the
 * window already shrank and equals the overlap when it did not — is written
 * out in app/(tabs)/terminal.tsx, the screen that had it right first.
 *
 * A screenshot proves it for the screens that existed on the day. This proves
 * it for the next one somebody writes.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "web-shims") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Code only. Every one of these files explains the bug in prose, and the prose
 *  quotes the very expression this file is here to forbid — so a scan that read
 *  the comments would fail on the fix for the thing it is checking. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const root = join(import.meta.dir, "..");
const files = [...sources(join(root, "app")), ...sources(join(root, "src"))];
const using = files
  .map((path) => ({ path: path.slice(root.length + 1), source: code(readFileSync(path, "utf8")) }))
  .filter(({ source }) => /<KeyboardAvoidingView/.test(source));

describe("how a screen gets out of the keyboard's way", () => {
  test("there are screens doing it at all", () => {
    // If this ever reads zero the rest of the file is passing vacuously, which
    // is the way a lock like this dies quietly.
    //
    // Two, not three. The third was app/chat/[id].tsx — the screen the bug in
    // the header above was FOUND on — and it was deleted with the rest of the
    // conversation UI. The floor moved down with it rather than the count being
    // padded: what this guards is that the check has something to check, and
    // the pairing form and the terminal both still take typing.
    expect(using.length).toBeGreaterThanOrEqual(2);
  });

  test("none of them goes quiet on Android", () => {
    const offenders: string[] = [];
    for (const { path, source } of using) {
      // `behavior=` followed by anything mentioning Platform, or by an explicit
      // undefined: both are the same "does nothing here" on one of the two.
      for (const match of source.matchAll(/behavior=\{[^}]*\}/g)) {
        if (/Platform|undefined/.test(match[0])) {
          offenders.push(`${path}: ${match[0]}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("and every one of them pads", () => {
    const offenders: string[] = [];
    for (const { path, source } of using) {
      const count = (source.match(/<KeyboardAvoidingView/g) ?? []).length;
      const padding = (source.match(/behavior="padding"/g) ?? []).length;
      if (padding < count) offenders.push(`${path}: ${count} views, ${padding} with behavior="padding"`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("the tab bar and the keyboard", () => {
  /*
   * The third face of the same bug. The bar is a flex sibling of the scene, so
   * a window that resizes carries it up to sit mid-screen over the list (API
   * 34, which is what he photographed) and a window that does not leaves it
   * buried under the keys (API 36). React Navigation's own answer,
   * `tabBarHideOnKeyboard`, is read inside ITS BottomTabBar and this app draws
   * its own — so the option is a no-op here and the behaviour has to be in our
   * file. This test is what says so.
   */
  const bar = code(readFileSync(join(root, "src/nav/TabBar.tsx"), "utf8"));

  test("the bar stands down while somebody is typing", () => {
    expect(bar).toContain("useKeyboardShown");
    expect(bar).toMatch(/if \(keyboard\) return null;/);
  });
});
