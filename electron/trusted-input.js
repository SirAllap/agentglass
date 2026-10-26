"use strict";
/*
 * Input a page cannot tell from a person's: `webContents.sendInputEvent` on
 * the GUEST's own webContents, from this process.
 *
 * Why this door and not the other two, measured with a page that records
 * `event.isTrusted` while the app's own window holds an input with the focus:
 *
 * - A script's events (`dispatchEvent`, `click()`) arrive with isTrusted
 *   false, and a site that defends against bots ignores them. That is the
 *   whole reason this file exists.
 * - The guest's DevTools session (`Input.dispatchKeyEvent`, `insertText`)
 *   delivers keys to the widget that holds the focus, which is the APP's
 *   window: the page got nothing and the app's input got "keydown:Z".
 * - `sendInputEvent` here reaches the guest it is called on — keys, text,
 *   Ctrl+A and Backspace included — trusted, and the app's focused input
 *   kept the focus and saw nothing. Not on a pane that is not painting: in
 *   the app, with the browser view behind another, every event was dropped
 *   (measured), so the renderer lights the pane first — `paintOnDemand` in
 *   web/src/lib/panePainting.ts. This file's harness runs in a window that
 *   is never shown, where the drop does not happen.
 *
 * Mouse events do move the app's focus onto the <webview> element (a real
 * press focuses what it lands on); the renderer puts it back — see
 * `restoreHostFocus` in browserDrive.ts.
 *
 * Coordinates arrive in CSS pixels of the page's viewport and leave in DIPs:
 * sendInputEvent is in DIPs, so at a page zoom of 1.5 a click sent at the CSS
 * point landed at two thirds of it. Measured: (100,50) arrived as (66,33).
 * Ceiling: pinch-zoom (visualViewport) is not accounted for.
 */

const POINTER_OPS = new Set(["click", "dblclick", "hover"]);
/* Three synchronous sends per character, in the main process: at 100 000 the
   whole app froze for the length of it. Longer text takes the script path. */
const MAX_TEXT = 10_000;

/* DOM key names (what `press` takes) to Electron's keyCode names. */
const KEY_NAMES = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  " ": "Space", Esc: "Escape", Return: "Enter", Del: "Delete",
};
const MODIFIERS = { control: "control", ctrl: "control", shift: "shift", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta", super: "meta" };

/** "Control+Shift+a" -> the three events a keyboard sends, or an error. */
function keyEvents(spec) {
  const parts = String(spec).split("+");
  let name = parts.pop() || "";
  /* "Control++" names the plus key: split leaves an empty last part. */
  if (name === "" && parts.length && parts[parts.length - 1] === "") { parts.pop(); name = "+"; }
  if (!name) return { ok: false, error: "no key named" };
  const modifiers = [];
  for (const m of parts) {
    const mod = MODIFIERS[m.toLowerCase()];
    if (!mod) return { ok: false, error: `unknown modifier "${m}"` };
    modifiers.push(mod);
  }
  const keyCode = KEY_NAMES[name] || name;
  const one = [...keyCode].length === 1;
  const events = [{ type: "keyDown", keyCode, modifiers }];
  /* The char event is what inserts text; a shortcut (Ctrl/Meta held) and a
     named key (Enter excepted, which a field takes as a line) insert nothing. */
  if ((one || keyCode === "Enter" || keyCode === "Space") && !modifiers.includes("control") && !modifiers.includes("meta")) {
    events.push({ type: "char", keyCode: keyCode === "Space" ? " " : keyCode, modifiers });
  }
  events.push({ type: "keyUp", keyCode, modifiers });
  return { ok: true, events };
}

/** Text as typed: one key per character, an upper-case letter with Shift. */
function textEvents(text) {
  const s = String(text);
  if (s.length > MAX_TEXT) return { ok: false, error: `text longer than ${MAX_TEXT} characters` };
  const events = [];
  for (const ch of s) {
    if (ch === "\n" || ch === "\r") {
      events.push({ type: "keyDown", keyCode: "Enter" }, { type: "char", keyCode: "Enter" }, { type: "keyUp", keyCode: "Enter" });
      continue;
    }
    /* Outside printable ASCII there is no key to press: the char event alone
       inserts it, the way an input method does (measured: é, ñ, an emoji). */
    const ascii = ch.length === 1 && ch >= " " && ch <= "~";
    const modifiers = /[A-Z]/.test(ch) ? ["shift"] : [];
    if (ascii) events.push({ type: "keyDown", keyCode: ch, modifiers });
    events.push({ type: "char", keyCode: ch, modifiers });
    events.push({ type: "keyUp", keyCode: ch, modifiers });
  }
  return { ok: true, events };
}

/** A press, a double press or a move at (x, y) in CSS pixels. */
function pointerEvents(op, x, y, zoom) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "no point to act on" };
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const at = { x: Math.round(x * z), y: Math.round(y * z) };
  const events = [{ type: "mouseMove", ...at }];
  const press = (clickCount) => events.push(
    { type: "mouseDown", ...at, button: "left", clickCount },
    { type: "mouseUp", ...at, button: "left", clickCount },
  );
  if (op === "click") press(1);
  else if (op === "dblclick") { press(1); press(2); }
  return { ok: true, events };
}

/** What `ag:browserInput` sends for one request, before any of it is sent. */
function inputEvents(req, zoom) {
  const op = String((req && req.op) || "");
  if (POINTER_OPS.has(op)) return pointerEvents(op, Number(req.x), Number(req.y), zoom);
  if (op === "key") return keyEvents(req.key ?? "");
  if (op === "text") return textEvents(req.text ?? "");
  return { ok: false, error: `unknown input "${op}"` };
}

/*
 * The guests receiving an agent's keys at this moment. A key sent here goes
 * through the guest's `before-input-event` like a person's, and that handler
 * forwards Ctrl+W, Ctrl+T, Ctrl+L, Escape… to the app — so `press Control+w`
 * closed the person's front tab, and Ctrl+T/L/F pulled the app's focus.
 * `sendInputEvent` runs that handler before it returns (measured in
 * scripts/trusted-input.ts: the page saw the keydown, the handler saw the
 * mark), so a mark held around the loop is exact: no person's key can arrive
 * while this synchronous loop holds the main process.
 */
const agentInput = new WeakSet();

/** True while `guest` is receiving input sent by `sendInput`, not a person. */
function isAgentInput(guest) {
  return agentInput.has(guest);
}

/** Builds and sends, all or nothing: a bad request sends no event at all. */
function sendInput(guest, req) {
  const built = inputEvents(req, guest.getZoomFactor());
  if (!built.ok) return built;
  agentInput.add(guest);
  try {
    for (const ev of built.events) guest.sendInputEvent(ev);
  } finally {
    agentInput.delete(guest);
  }
  return { ok: true, sent: built.events.length };
}

module.exports = { inputEvents, sendInput, isAgentInput, keyEvents, textEvents };
