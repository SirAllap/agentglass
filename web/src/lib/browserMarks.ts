/**
 * The overlay `shot --marks` draws, as a page script. Its own module because a
 * script that only needs strings (the bench, a test) should not have to load
 * the panel's driver to get one.
 */
import { PICK, STAMP } from "./browserObserve.ts";
import { jsLit } from "../../../shared/jsLit.ts";

/** What observe lists minus the headings: a label belongs on something a caller
 *  can act on, and a heading is context. Found the day the real page labelled its
 *  own title. */
const MARKED = PICK.replace(",h1,h2,h3", "");

export const MARKS_ID = "__agx_shot_marks__";

/** The most labels one picture carries — and so the most ids one mints. */
export const MARKS_MAX = 100;

/**
 * `shot --marks`: set-of-mark. A numbered label on every interactive thing in
 * view, carrying the SAME `eN` id observe gives it, so a model that looks at
 * the picture and a model that reads the tree are pointing at one thing — the
 * picture is for a canvas, an icon-only toolbar or a page whose names are
 * ambiguous, the id is what it then acts on. DOM overlay like `--highlight`,
 * for the same reason: every capture route photographs the same page. Only
 * what is on screen and not covered gets a label, capped, so a label is never
 * drawn on something another element hides.
 */
export const MARKS_SCRIPT = `(() => {
  const stamp = ${STAMP};
  const root = document.createElement("div");
  root.id = ${jsLit(MARKS_ID)};
  root.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
  let n = 0;
  const ids = [];
  for (const el of document.querySelectorAll(${jsLit(MARKED)})) {
    if (n >= ${MARKS_MAX}) break;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const x = Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2));
    const top = document.elementFromPoint(x, y);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
    const id = stamp(el);
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;left:" + (r.left + scrollX) + "px;top:" + (r.top + scrollY) + "px;width:" + r.width + "px;height:" + r.height
      + "px;border:1.5px solid #ff3b30;box-sizing:border-box;";
    const tag = document.createElement("div");
    tag.textContent = id;
    tag.style.cssText = "position:absolute;left:-1px;top:-14px;background:#ff3b30;color:#fff;font:700 11px/14px ui-monospace,monospace;padding:0 3px;white-space:nowrap;";
    if (r.top < 16) tag.style.top = "0";
    box.appendChild(tag);
    root.appendChild(box);
    ids.push(id);
    n++;
  }
  document.body.appendChild(root);
  return ids;
})()`;
