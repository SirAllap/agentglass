/*
 * The two ways "tap to type" fails silently.
 *
 * Both were paid for once already — Orca's mobile client carries the same two
 * workarounds — and both share a shape that makes them expensive to find: the
 * tap does nothing, no error is raised, and the only symptom is somebody
 * pressing the bar again. So they are pulled out of the screen and checked
 * here, where a plain object can stand in for a TextInput and the disagreement
 * that causes each one can be stated directly.
 */
import { describe, expect, mock, test } from "bun:test";
import {
  clearFocusTimer, focusCapture, liveDetail, scheduleFocus,
  type FocusTarget, type FocusTimer,
} from "../src/terminal/liveFocus.ts";

function target(over: Partial<FocusTarget> & { focused?: boolean } = {}): FocusTarget & {
  focus: ReturnType<typeof mock>; blur: ReturnType<typeof mock>;
} {
  let focused = over.focused ?? false;
  return {
    focus: mock(() => { focused = true; }),
    blur: mock(() => { focused = false; }),
    isFocused: () => focused,
  } as never;
}

const timer = (): FocusTimer => ({ current: null });

describe("scheduling a focus past the WebView", () => {
  test("does not focus in the same tick the tap arrives in", async () => {
    /* The whole point. The WebView still owns the keyboard while it is telling
       us the touch ended, so focusing there is a no-op and the tap silently
       does nothing. */
    const t = timer();
    const focus = mock(() => {});
    scheduleFocus(t, focus, 5);
    expect(focus).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test("a second tap replaces the first rather than focusing twice", async () => {
    // Queueing would focus a field that a route change may have unmounted
    // between the two taps.
    const t = timer();
    const first = mock(() => {});
    const second = mock(() => {});
    scheduleFocus(t, first, 5);
    scheduleFocus(t, second, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("clearing stops a pending one, which is what unmount does", async () => {
    const t = timer();
    const focus = mock(() => {});
    scheduleFocus(t, focus, 5);
    clearFocusTimer(t);
    await new Promise((r) => setTimeout(r, 20));
    expect(focus).not.toHaveBeenCalled();
    expect(t.current).toBe(null);
  });

  test("clearing nothing is not an error", () => {
    const t = timer();
    expect(() => clearFocusTimer(t)).not.toThrow();
  });

  test("the box is emptied once it has fired, so a later clear is a no-op", async () => {
    const t = timer();
    scheduleFocus(t, () => {}, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.current).toBe(null);
  });
});

describe("asking Android twice", () => {
  test("an ordinary focus is just a focus", () => {
    const el = target({ focused: false });
    const retry = mock(() => {});
    focusCapture(el, { keyboardShown: false, retry });
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(el.blur).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  test("keyboard down but the field says focused: blur first, then retry", () => {
    /* Android's state after the back gesture dismisses the IME. focus() on an
       already-focused field does nothing, so without this the keyboard never
       comes back and leaving the screen is the only way out. */
    const el = target({ focused: true });
    const retry = mock(() => {});
    focusCapture(el, { keyboardShown: false, retry });
    expect(el.blur).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(el.focus).not.toHaveBeenCalled();
  });

  test("keyboard already up needs no such trick", () => {
    // The two do not disagree here, so blurring would close a keyboard
    // somebody is using.
    const el = target({ focused: true });
    const retry = mock(() => {});
    focusCapture(el, { keyboardShown: true, retry });
    expect(el.focus).toHaveBeenCalledTimes(1);
    expect(el.blur).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  test("no field yet is nothing rather than a crash", () => {
    // The ref is null for the first render and after unmount, and a tap can
    // land in both.
    expect(() => focusCapture(null, { keyboardShown: false, retry: () => {} })).not.toThrow();
    expect(() => focusCapture(undefined, { keyboardShown: true, retry: () => {} })).not.toThrow();
  });

  test("a target that cannot answer isFocused is focused rather than skipped", () => {
    // isFocused is optional on the platform. Unknown is not "already focused".
    const el = { focus: mock(() => {}), blur: mock(() => {}) };
    focusCapture(el, { keyboardShown: false, retry: () => {} });
    expect(el.focus).toHaveBeenCalledTimes(1);
  });
});

describe("what the bar says", () => {
  test("the captured line when there is one", () => {
    expect(liveDetail("git status")).toBe("git status");
  });

  test("and an instruction when there is not", () => {
    // The bar is a button. A button with nothing written on it is furniture.
    expect(liveDetail("")).toBe("Tap to show keyboard");
  });

  test("a line of spaces is a line — it is what was typed", () => {
    expect(liveDetail(" ")).toBe(" ");
  });
});
