// The picker, as it runs INSIDE the page.
//
// The guest deliberately has no preload and no Node — that is the boundary
// which makes `webviewTag` safe at all — so there is no channel to send a
// message on. Everything here is injected with `executeJavaScript`, leaves its
// answer on a global, and the panel polls for it. Ugly, and the only shape
// available that does not weaken the guest.
//
// Kept as a string in its own module for two reasons: it is the one piece of
// code in this app that runs in somebody else's page, so it should be readable
// in one place; and a template literal buried in a component is a template
// literal nobody proof-reads.

/** Where the answer is left, and the flag the page checks to know it is on.
 *  Prefixed because this shares a global namespace with whatever the site has
 *  already put there. */
export const PICK_GLOBAL = "__agxPick";

/**
 * Install the picker.
 *
 * Outlines whatever is under the pointer, and waits for a decision: `c` copies
 * the element, `s` shoots it, Enter or a click selects it, Escape gives up. The
 * outline is drawn with an overlay div rather than by styling the element,
 * because changing a page's own styles to look at it can change its layout —
 * which is the one thing a tool for inspecting layout must not do.
 *
 * Every listener is capturing and swallows the event: while this is up, the
 * page must not also receive the click. That is the difference between picking
 * a "Delete" button and pressing it.
 */
/** What the picker is for this time: inspecting, or handing an element to an
 *  agent. The screenshot tool used to be a third mode here and is its own
 *  overlay now — see Shooter.tsx. */
export type PickMode = "pick" | "feedback";

export const installPick = (mode: PickMode): string => `(() => {
  const G = ${JSON.stringify(PICK_GLOBAL)};
  if (window[G] && window[G].on) return "already";
  const box = document.createElement("div");
  box.setAttribute("data-agx-pick", "1");
  box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4a9eff;background:rgba(74,158,255,.14);border-radius:2px;transition:all .04s linear;display:none";
  const tag = document.createElement("div");
  tag.setAttribute("data-agx-pick", "1");
  tag.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;font:11px ui-monospace,monospace;background:#4a9eff;color:#04121f;padding:2px 6px;border-radius:3px;white-space:nowrap;display:none";
  const hint = document.createElement("div");
  hint.setAttribute("data-agx-pick", "1");
  hint.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;left:50%;transform:translateX(-50%);bottom:16px;font:12px ui-sans-serif,system-ui,sans-serif;background:rgba(12,14,18,.94);color:#dfe3ea;padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 24px rgba(0,0,0,.5)";
  hint.textContent = ${JSON.stringify(
    mode === "feedback" ? "Click an element to tell an agent about it · Esc to stop"
    : "Hover an element, then C to copy it or S to screenshot it · Esc to stop",
  )};
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tag);
  document.documentElement.appendChild(hint);

  /* A selector that will still find this element tomorrow.
     An id when the page gave it one and it is unique; otherwise the position
     among siblings of the same tag, which survives re-rendering far better than
     a class list does — framework classes are generated and change on build. */
  const cssPath = (elm) => {
    if (!elm || elm.nodeType !== 1) return "";
    const bits = [];
    let node = elm;
    while (node && node.nodeType === 1 && bits.length < 8) {
      if (node.id && document.querySelectorAll("#" + CSS.escape(node.id)).length === 1) {
        bits.unshift("#" + CSS.escape(node.id));
        break;
      }
      const name = node.tagName.toLowerCase();
      if (name === "html" || name === "body") { bits.unshift(name); break; }
      const parent = node.parentElement;
      if (!parent) { bits.unshift(name); break; }
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      bits.unshift(sameTag.length > 1 ? name + ":nth-of-type(" + (sameTag.indexOf(node) + 1) + ")" : name);
      node = parent;
    }
    return bits.join(" > ");
  };

  const describe = (elm) => {
    const r = elm.getBoundingClientRect();
    const html = (elm.outerHTML || "").slice(0, 2400);
    return {
      selector: cssPath(elm),
      tag: elm.tagName.toLowerCase(),
      id: elm.id || "",
      classes: (elm.getAttribute("class") || "").slice(0, 200),
      text: (elm.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 400),
      html: html,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    };
  };

  let hot = null;
  const paint = () => {
    if (!hot || !hot.isConnected) { box.style.display = "none"; tag.style.display = "none"; return; }
    const r = hot.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
    tag.style.display = "block";
    // Above the box, unless that is off the top of the window.
    tag.style.left = Math.max(2, r.left) + "px";
    tag.style.top = (r.top > 22 ? r.top - 20 : r.bottom + 4) + "px";
    tag.textContent = hot.tagName.toLowerCase() + (hot.id ? "#" + hot.id : "") +
      "  " + Math.round(r.width) + "×" + Math.round(r.height);
  };

  const over = (e) => {
    const t = e.target;
    if (!t || t.nodeType !== 1 || t.getAttribute("data-agx-pick")) return;
    hot = t; paint();
  };
  const answer = (action) => {
    if (!hot) return;
    window[G] = Object.assign({ on: true, action: action, at: Date.now() }, describe(hot));
  };
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); window[G] = { on: true, action: "cancel", at: Date.now() }; return; }
    const k = (e.key || "").toLowerCase();
    if (k === "c" || k === "s" || e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      answer(e.key === "Enter" ? "select" : k === "c" ? "copy" : "shoot");
    }
  };
  // Capturing and swallowed: while the picker is up the page must not also get
  // the click. That is the difference between picking a "Delete" button and
  // pressing it.
  const swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  const click = (e) => { swallow(e); answer("select"); };

  document.addEventListener("mousemove", over, true);
  document.addEventListener("mouseover", over, true);
  document.addEventListener("click", click, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("scroll", paint, true);
  window.addEventListener("resize", paint, true);

  window[G] = { on: true, action: "", at: 0 };
  window[G + "_off"] = () => {
    document.removeEventListener("mousemove", over, true);
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("scroll", paint, true);
    window.removeEventListener("resize", paint, true);
    box.remove(); tag.remove(); hint.remove();
    delete window[G]; delete window[G + "_off"];
  };
  // The page's own focus is what makes the key handler fire at all — a guest
  // nobody clicked into never sees a keystroke.
  try { window.focus(); } catch (_) {}
  return "on";
})()`;

/** Read and clear the answer, so the same decision is not acted on twice. */
export const readPick = `(() => {
  const G = ${JSON.stringify(PICK_GLOBAL)};
  const v = window[G];
  if (!v || !v.action) return "";
  window[G] = { on: true, action: "", at: 0 };
  return JSON.stringify(v);
})()`;

/** Take the outline away for a moment, so it is not in the screenshot of the
 *  thing it is outlining. */
export const hidePickChrome = `(() => {
  document.querySelectorAll("[data-agx-pick]").forEach((n) => { n.style.visibility = "hidden"; });
  return 1;
})()`;

export const showPickChrome = `(() => {
  document.querySelectorAll("[data-agx-pick]").forEach((n) => { n.style.visibility = "visible"; });
  return 1;
})()`;

export const removePick = `(() => {
  const off = window[${JSON.stringify(PICK_GLOBAL)} + "_off"];
  if (off) off();
  return 1;
})()`;
