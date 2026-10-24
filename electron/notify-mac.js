"use strict";

/*
 * A notification with action buttons, raised from the main process.
 *
 * The renderer's `Notification` cannot carry buttons on macOS; Electron's own
 * main-process `Notification` can (`actions`, and the `action` event with the
 * index pressed). This file is the part of that which is decidable without a
 * Mac: what a renderer may ask for, and which button an event stands for. The
 * `Notification` class is handed in so a test can drive it.
 *
 * UNTESTED ON A REAL MAC: written against Electron's documented API on a Linux
 * machine. Nothing here has drawn a button.
 *
 * Ceiling: the renderer sends labels only, never a target. A press travels back
 * as an INDEX into the list the renderer itself kept, so a press can do exactly
 * what the renderer's own click does for that entry and nothing it did not
 * offer.
 */

const MAX_ACTIONS = 2;
const MAX_TEXT = 200;
const MAX_CLOSE_MS = 120_000;

const text = (v) => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");

/** What a renderer asked for, cut down to what is safe to hand to the OS; null when there is nothing to show. */
function sanitize(req) {
  if (!req || typeof req !== "object") return null;
  const title = text(req.title);
  if (!title) return null;
  const labels = (Array.isArray(req.labels) ? req.labels : []).map(text).filter(Boolean).slice(0, MAX_ACTIONS);
  if (!labels.length) return null;
  const ms = Number(req.closeAfterMs);
  return {
    title,
    body: text(req.body),
    urgent: req.urgent === true,
    tag: text(req.tag),
    labels,
    closeAfterMs: Number.isFinite(ms) && ms > 0 ? (ms > MAX_CLOSE_MS ? MAX_CLOSE_MS : ms) : 0,
  };
}

/**
 * Which entry a press stands for. The body of the notification is the primary
 * action (index 0), exactly as a click is on Linux; a button is its own index.
 * Anything out of range is no press at all.
 */
function indexOf(count, ev) {
  if (!ev || typeof ev !== "object") return null;
  const i = ev.kind === "click" ? 0 : ev.kind === "action" ? ev.index : NaN;
  return Number.isInteger(i) && i >= 0 && i < count ? i : null;
}

/**
 * Raise it. `onPress(index)` is called once, with the entry that was pressed.
 * Returns the notification so the caller can close it.
 */
function raise(Notification, req, onPress) {
  const clean = sanitize(req);
  if (!clean) return null;
  const n = new Notification({
    title: clean.title,
    body: clean.body,
    urgency: clean.urgent ? "critical" : "normal",
    actions: clean.labels.map((l) => ({ type: "button", text: l })),
  });
  let pressed = false;
  const press = (ev) => {
    const i = indexOf(clean.labels.length, ev);
    if (i === null || pressed) return;
    pressed = true;
    onPress(i);
  };
  n.on("click", () => press({ kind: "click" }));
  n.on("action", (_e, index) => press({ kind: "action", index }));
  // Same promise the renderer path makes: a popup never outlives its welcome.
  let timer = null;
  if (clean.closeAfterMs) {
    timer = setTimeout(() => { try { n.close(); } catch { /* already gone */ } }, clean.closeAfterMs);
    n.on("close", () => clearTimeout(timer));
  }
  n.show();
  return n;
}

module.exports = { sanitize, indexOf, raise, MAX_ACTIONS };
