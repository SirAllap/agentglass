/*
 * Guide mode's eye inside the guest: where the pointed element is, and whether
 * the person pressed it.
 *
 * The panel cannot see inside a <webview>, and guide mode must not run code in
 * the page's own world or draw into the page. So the main process, which
 * already holds the guest's debugger, makes a CDP ISOLATED WORLD
 * (`Page.createIsolatedWorld`): same DOM, separate JavaScript, invisible to the
 * page's scripts. A binding (`Runtime.addBinding`, scoped to that world's name)
 * is the only way out. The script in that world watches ONLY the pointed node:
 * ResizeObserver and IntersectionObserver on it (and ResizeObserver on the
 * page, a MutationObserver for layout shifts), scroll (capture) and resize on
 * its window and visualViewport, and `pointerdown` on it. Each change is coalesced to one report
 * per animation frame. Nothing polls.
 *
 * `pointerdown`, not `click`: a click on a link unloads the document before a
 * `click` report could leave, and the guide has to know the person pressed it.
 *
 * A navigation throws the world away. On `Page.frameNavigated` (main frame)
 * the panel is told `navigated`, then the world is made again and the target
 * re-resolved by its stored selector, else by role + name. If it never comes
 * back, nothing more is said: the bubble says "The page changed".
 *
 * Requires nothing, so a fake CDP drives it in tests. `send(method, params)`
 * is the guest's `debugger.sendCommand`; `emit(ev)` hands the panel an
 * ActivityEvent `{kind:"guide", tab, phase, step?, say?, waitClick?, target?,
 * clicked?, navigated?}`; `onMessage(method, params)` is fed every debugger
 * event.
 */

"use strict";

const WORLD = "agxGuide";
const BINDING = "__agxGuideReport";

/** Whether any part of a rect `{x, y, w, h}` lies outside a `vw` x `vh`
 *  viewport: point scrolls such a target to the centre before it draws the
 *  ring, or the person sees the top of the page and nothing pointed. Pure:
 *  it is also put into the guest's script as source. */
function offView(r, vw, vh) {
  return r.y < 0 || r.x < 0 || r.y + r.h > vh || r.x + r.w > vw;
}

/** Why a found target cannot be shown, or "" when it can. `s` is what the
 *  page measured: {w, h, display, visibility, closedDetails, unrendered}.
 *  Pure, and put into the guest's script as source like offView. */
function hiddenWhy(s) {
  if (s.closedDetails) return "the target is inside a closed <details>";
  if (s.display === "none") return "the target is display:none";
  if (s.visibility === "hidden" || s.visibility === "collapse") return "the target is visibility:hidden";
  if (s.unrendered) return "a parent of the target hides it";
  if (!(s.w > 0) || !(s.h > 0)) return "the target has zero size";
  return "";
}

/** What a step's target found at the start gets, from hiddenWhy's answer: "watch"
 *  when it can be seen, else "wait" on a run's step and "refuse" (say why) on a
 *  single point. A run's target is often still hidden for a beat after the press
 *  that moved the plan on: a #hash link shows its section on hashchange, with no
 *  navigation to remake the world, so a refusal there left the step with no ring.
 *  Pure, and put into the guest's script as source like offView. */
function firstLook(why, run) {
  if (!why) return "watch";
  return run ? "wait" : "refuse";
}

/** Does an input event count as the person's typing for --wait-input? Only a
 *  trusted one. A page can set any attribute (data-agx-suggest included) and
 *  fire script-made input events, so no DOM marker is believed. The card's
 *  "Use suggestion" fill is the one script write that counts, and it is
 *  reported by the main process itself (insertGuideSuggestion), never through
 *  this guest. Pure, in the guest as source. */
function typingCounts(trusted) {
  return trusted === true;
}

/** How long after a hashchange/popstate the scroll settle may re-ring. A page's
 *  own scrolling later must not force a send on every scroll. */
const REARM_MS = 1500;
/** Is the settled re-ring still armed? `armedAt` is 0 until a hashchange/popstate. Pure, in the guest as source. */
function rearmOpen(now, armedAt, windowMs) {
  return armedAt > 0 && now - armedAt <= windowMs;
}

/** Should a measured rect go to the panel? Normally only when it moved; after a
 *  hashchange/popstate (the document stays, the page scrolls to the fragment,
 *  so no navigation remade anything) the panel's ring may be stale, so the
 *  first measure is sent whether it moved or not. Pure, in the guest as source. */
function shouldSend(hasExtra, key, sent, force) {
  return !!hasExtra || !!force || key !== sent;
}

/** The name a node goes by, the same way FIND names it for role=… (ACC_NAME in
 *  web/src/lib/browserObserve.ts, then alt): innerText before anything that
 *  reads hidden text, so a TOC link holding a CSS-hidden number span
 *  ("1" + "History") is "History", as point and interactive call it. Pure, and
 *  put into the guest's script as source; a test holds it to FIND's. */
function nameOf(el) {
  const acc = (el.getAttribute("aria-label") ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    String(el.innerText || "").trim().slice(0, 80) || "").trim().slice(0, 80);
  return String(acc || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim();
}

/** Whether a node has `role`, as FIND (web/src/lib/browserLocator.ts) decides
 *  it: its own role attribute's first word, else its tag or implicit role (an
 *  <a> only with href is a link; a multiple <select> is a listbox). Pure, and
 *  put into the guest's script as source. */
function hasRole(el, role) {
  const own = String(el.getAttribute("role") || "").replace(/\s+/g, " ").trim().split(" ")[0];
  if (own) return own === role;
  const t = String(el.tagName).toLowerCase();
  let imp = "";
  if (t === "a") imp = el.hasAttribute("href") ? "link" : "";
  else if (t === "button") imp = "button";
  else if (t === "select") imp = el.multiple || el.size > 1 ? "listbox" : "combobox";
  else if (t === "textarea") imp = "textbox";
  else if (/^h[1-6]$/.test(t)) imp = "heading";
  else if (t === "input") {
    imp = ({ button: "button", submit: "button", reset: "button", image: "button",
      checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
      text: "textbox", email: "textbox", tel: "textbox", url: "textbox", password: "textbox",
    })[String(el.type || "text").toLowerCase()] || "";
  } else {
    imp = ({ dialog: "dialog", img: "img", nav: "navigation", main: "main", li: "listitem",
      ul: "list", ol: "list", table: "table", article: "article", form: "form", aside: "complementary" })[t] || "";
  }
  return t === role || imp === role;
}

/** Whether a node's name fits a role locator's name, as FIND compares it:
 *  exact (the `s` flag) is equal, otherwise contains, ignoring case. */
function nameFits(got, want, exact) {
  const norm = (x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim();
  return exact ? norm(got) === norm(want) : norm(got).toLowerCase().includes(norm(want).toLowerCase());
}

/** How well a node fits a role locator's name, best first: 0 the whole name
 *  and on screen, 1 holds the name and on screen, 2 and 3 the same hidden; -1
 *  no fit. So "History" picks the Contents link before "View history", and a
 *  node on screen before a hidden one, as FIND (on-screen only) would. Pure,
 *  and put into the guest's script as source. */
function matchRank(got, want, exact, hidden) {
  if (want && !nameFits(got, want, exact)) return -1;
  const whole = !want || nameFits(String(got).toLowerCase(), String(want).toLowerCase(), true);
  return (hidden ? 2 : 0) + (whole ? 0 : 1);
}

/** The script run in the isolated world. `spec` is JSON: {selector, role, name}.
 *  It answers true (watching), false (not on the page yet: it waits for it) or
 *  a string, the reason the target is there but cannot be seen. */
function observerSource(spec) {
  return `(() => {
  const spec = ${JSON.stringify(spec)};
  ${offView.toString()}
  ${hiddenWhy.toString()}
  ${firstLook.toString()}
  ${typingCounts.toString()}
  ${rearmOpen.toString()}
  const REARM_MS = ${REARM_MS};
  ${shouldSend.toString()}
  ${nameOf.toString()}
  ${hasRole.toString()}
  ${nameFits.toString()}
  ${matchRank.toString()}
  const hiddenOf = (node) => {
    /* A frame's node is styled by its own window. */
    const view = node.ownerDocument && node.ownerDocument.defaultView;
    const r = node.getBoundingClientRect(), cs = view && view !== window && view.getComputedStyle ? view.getComputedStyle(node) : getComputedStyle(node);
    /* The parent's <details>, not the node's own: a closed <details> that is
       itself the target still shows its summary. */
    const d = node.parentElement ? node.parentElement.closest("details") : null, sum = node.closest("summary");
    return hiddenWhy({
      w: r.width, h: r.height, display: cs.display, visibility: cs.visibility,
      closedDetails: !!(d && !d.open && !(sum && sum.parentElement === d)),
      unrendered: typeof node.checkVisibility === "function" ? !node.checkVisibility() : false,
    });
  };
  /* Into view first, then measured: a target below the fold is brought to the
     middle, at once when the person asked for less motion. The scroll's own
     events move the ring as it goes. */
  const reveal = (node) => {
    const r = boxOf(node);
    if (!offView({ x: r.x, y: r.y, w: r.width, h: r.height }, innerWidth, innerHeight)) return;
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ block: "center", inline: "nearest", behavior: calm ? "instant" : "smooth" });
  };
  const report = (m) => { try { ${BINDING}(JSON.stringify(m)); } catch (_) {} };
  if (window.__agxGuideStop) window.__agxGuideStop();
  /* A run's step: the label (--text) that picks one of several matches, compared folded. */
  const want = spec.text ? String(spec.text).toLowerCase().replace(/\\s+/g, " ") : "";
  const holds = (el) => !want || nameOf(el).toLowerCase().includes(want);
  /* The document, then its open shadow roots and same-origin frames, as
     pointMatch searched them: a field it tagged may sit in either. */
  const roots = () => {
    const found = [document];
    /* At most 64 roots, counted as each is added: one root with hundreds of
       shadow hosts jumped past a check made only between roots. */
    for (let i = 0; i < found.length && found.length < 64; i++) {
      let all = [];
      try { all = found[i].querySelectorAll("*"); } catch (_) {}
      for (const n of all) {
        if (found.length >= 64) break;
        if (n.shadowRoot) found.push(n.shadowRoot);
        if (found.length < 64 && (n.tagName === "IFRAME" || n.tagName === "FRAME")) { let d = null; try { d = n.contentDocument; } catch (_) { d = null; } if (d) found.push(d); }
      }
    }
    return found;
  };
  const every = (sel) => {
    const top = [...document.querySelectorAll(sel)];
    if (top.length) return top;
    return roots().slice(1).flatMap((r) => [...r.querySelectorAll(sel)]);
  };
  /* A node in a same-origin frame measures from the frame's corner: add each frame's offset. */
  const boxOf = (node) => {
    const r = node.getBoundingClientRect();
    let x = r.x, y = r.y;
    let w = node.ownerDocument && node.ownerDocument.defaultView;
    while (w && w !== window && w.frameElement) {
      const f = w.frameElement.getBoundingClientRect();
      x += f.x + (w.frameElement.clientLeft || 0); y += f.y + (w.frameElement.clientTop || 0);
      w = w.parent;
    }
    return { x, y, width: r.width, height: r.height };
  };
  const pick = (s) => {
    if (s.selector) {
      try {
        for (const el of every(s.selector)) if (holds(el)) return el;
        /* every() stops at the top page when it has any match; a --text that
           none of those hold may name one in a shadow root or frame. */
        /* Capped: this runs every look, so a heavy page must not cost a full scan each time. */
        if (want) { let n = 0; for (const r of roots().slice(1)) for (const el of r.querySelectorAll(s.selector)) { if (++n > 500) break; if (holds(el)) return el; } }
      } catch (_) {}
    }
    if (s.role) {
      /* Best first, as a person would mean it: a name that is the whole name
         before one that only holds it ("History" before "View history"), and
         a node on screen before a hidden one (FIND counts on-screen nodes only).
         A hidden match is still returned last, so the wait can watch it appear. */
      let best = null, rank = 5;
      for (const el of document.querySelectorAll("*")) {
        if (!hasRole(el, s.role)) continue;
        if (!holds(el)) continue;
        const r = matchRank(nameOf(el), s.name, s.exact, !!hiddenOf(el));
        if (r < 0) continue;
        if (r === 0) return el;
        if (r < rank) { best = el; rank = r; }
      }
      return best;
    }
    return null;
  };
  /* The tag pointMatch put on the node is gone after a navigation: \`again\` is the plan's own selector. */
  const find = () => {
    if (spec.selector) { try { const el = document.querySelector(spec.selector) || every(spec.selector)[0]; if (el) return el; } catch (_) {} }
    if (spec.role) { const el = pick({ role: spec.role, name: spec.name }); if (el) return el; }
    return spec.again ? pick(spec.again) : null;
  };
  let el = null, frame = 0, mo = null, ro = null, io = null, lo = null, sent = "";
  /* The same-origin frame's window the target lives in, or null on the top page. */
  let fw = null;
  /* A run's step: lost after 2 s with no match, typing idle for 1.5 s, the person's submit. */
  let lostTimer = 0, lostSent = false, typeTimer = 0;
  /* The wait: one look per frame at most, and the hidden candidate it found. */
  let waitFrame = 0, cand = null, cro = null;
  const vv = typeof visualViewport !== "undefined" ? visualViewport : null;
  const send = (extra) => {
    if (!el || !el.isConnected) return;
    const r = boxOf(el);
    /* vw, vh: the page's own viewport in its CSS px. The panel scales by paneWidth / vw, so a
       zoomed page or a pane narrower than the page still gets the ring on its element, and
       vh tells it when the element is scrolled out of view. */
    const rect = { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
    const key = JSON.stringify(rect);
    /* A layout change that did not move the element says nothing; a press always does. */
    if (!shouldSend(!!extra, key, sent, force)) return;
    force = false;
    sent = key;
    report(Object.assign({ rect }, extra || {}));
  };
  /* One report per frame, and a timer beside it: a guest that is not painting
     (a hidden or occluded window, a pane mid-resize) runs no animation frame
     and no Resize/IntersectionObserver callback, so a page scroll or a resize
     said nothing until the next wheel input. Scroll and resize events still
     fire; the timer makes them report. Whichever comes first sends. */
  let tick = 0, force = false, settle = 0;
  const flush = () => { if (frame) cancelAnimationFrame(frame); if (tick) clearTimeout(tick); frame = 0; tick = 0; send(); };
  const soon = () => { if (frame || tick) return; frame = requestAnimationFrame(flush); tick = setTimeout(flush, 120); };
  /* A same-document navigation (a #hash link, history back): the page scrolls to the
     fragment with no frameNavigated, so say where the target is now, and again once
     the scroll has settled (scrollend, or 150 ms with no scroll event). */
  let armedAt = 0;
  const rering = () => { if (!rearmOpen(Date.now(), armedAt, REARM_MS)) return; force = true; soon(); };
  const settled = () => {
    if (!rearmOpen(Date.now(), armedAt, REARM_MS)) return; // only just after a hashchange/popstate
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => { settle = 0; force = true; soon(); }, 150);
  };
  const hashed = () => { armedAt = Date.now(); force = true; soon(); settled(); };
  /* The person's own press, with the main button: a right-click (a menu) or a
     middle-click (a new tab) on the target is not the click a step waits for. */
  const down = (e) => { if (e.isTrusted && !(e.button > 0)) send({ clicked: true }); };
  /* The same press from the keyboard: Enter on a link, Space on a button. The
     browser fires a trusted click with detail 0 and no pointerdown, so a nav
     step opened that way would never end. A pointer click (detail >= 1) was
     already told by its pointerdown. */
  /* One press, one report: the click that follows Enter's keydown on a link is the same press. */
  let linkKeyAt = 0;
  const keyPress = (e) => { if (e.isTrusted && e.detail === 0 && Date.now() - linkKeyAt > 1000) send({ clicked: true }); };
  /* Enter on a link: told at keydown too. The click that follows starts the
     navigation, and a report sent from it can be lost as the page unloads
     (why pointerdown is used above). A button does not unload the page, and
     a form it sends is the submit listener's. */
  const keyLink = (e) => {
    if (!e.isTrusted || e.repeat || e.key !== "Enter") return;
    /* Ctrl/Meta/Shift/Alt+Enter opens a new tab or window: this page did not navigate. */
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (t && typeof t.closest === "function" && t.closest("a[href]")) { linkKeyAt = Date.now(); send({ clicked: true }); }
  };
  /* --wait-input: the field holds text and the person stopped typing for 1.5 s. Their own keys only. */
  const typed = (e) => {
    if (!typingCounts(e.isTrusted)) return;
    if (typeTimer) clearTimeout(typeTimer);
    typeTimer = setTimeout(() => {
      typeTimer = 0;
      const v = el ? (typeof el.value === "string" ? el.value : el.textContent || "") : "";
      if (v.trim()) report({ input: true });
    }, 1500);
  };
  /* The card folds to a dot while the person types in the target, and opens on blur: their own keys only, one report per 400 ms. */
  let keyedAt = 0;
  const keyed = (e) => {
    if (!e.isTrusted) return;
    const t = Date.now();
    if (t - keyedAt < 400) return;
    keyedAt = t;
    report({ typing: true });
  };
  const leftField = (e) => { if (!e.isTrusted) return; keyedAt = 0; report({ typing: false }); };
  /* --wait-submit: the person sent the form the target is in (or is). */
  const sentForm = (e) => {
    if (!e.isTrusted || !el) return;
    const f = e.target;
    if (f === el || (f && typeof f.contains === "function" && f.contains(el))) report({ submitted: true });
  };
  const watch = (node) => {
    const why = hiddenOf(node);
    if (why) return why;
    reveal(node);
    el = node;
    /* The element's own size, and the page's: content growing above it moves it without resizing it. */
    ro = new ResizeObserver(soon); ro.observe(el);
    if (document.documentElement) ro.observe(document.documentElement);
    if (document.body) ro.observe(document.body);
    io = new IntersectionObserver(soon, { threshold: [0, 0.5, 1] }); io.observe(el);
    /* Any other layout shift (a banner, a class, a style) is a DOM change: one report per frame, only if it moved. */
    /* The node itself removed (the page re-rendered it): look for it again, and say lost if it never comes back. */
    lo = new MutationObserver(() => { if (el && !el.isConnected) { unwatch(); beginWait(); return; } soon(); });
    lo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true });
    /* Scroll in any scroller (capture); resize covers the pane and the zoom factor, which changes innerWidth. */
    addEventListener("scroll", soon, { capture: true, passive: true });
    addEventListener("resize", soon, { passive: true });
    if (vv) { vv.addEventListener("resize", soon, { passive: true }); vv.addEventListener("scroll", soon, { passive: true }); }
    addEventListener("hashchange", hashed); addEventListener("popstate", hashed);
    addEventListener("scrollend", rering, { capture: true });
    addEventListener("scroll", settled, { capture: true, passive: true });
    el.addEventListener("pointerdown", down, { capture: true });
    el.addEventListener("click", keyPress, { capture: true });
    el.addEventListener("keydown", keyLink, { capture: true });
    el.addEventListener("input", keyed, { capture: true });
    el.addEventListener("focusout", leftField, { capture: true });
    if (spec.wait === "input") el.addEventListener("input", typed, { capture: true });
    if (spec.wait === "submit" || spec.wait === "nav") addEventListener("submit", sentForm, { capture: true });
    /* A target in a same-origin frame: the frame's own scroll, DOM and form
       submit happen in its document, which the top window never hears. */
    const od = el.ownerDocument;
    fw = od && od !== document && od.defaultView && od.defaultView !== window ? od.defaultView : null;
    if (fw) {
      try {
        lo.observe(od.documentElement || od, { childList: true, subtree: true, attributes: true, characterData: true });
        fw.addEventListener("scroll", soon, { capture: true, passive: true });
        if (spec.wait === "submit" || spec.wait === "nav") fw.addEventListener("submit", sentForm, { capture: true });
      } catch (_) {}
    }
    if (lostSent) { lostSent = false; report({ back: true }); }
    send();
    return true;
  };
  function unwatch() {
    if (frame) cancelAnimationFrame(frame);
    if (tick) clearTimeout(tick);
    if (typeTimer) clearTimeout(typeTimer);
    frame = 0; tick = 0; typeTimer = 0; sent = "";
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    if (lo) lo.disconnect();
    ro = null; io = null; lo = null;
    removeEventListener("scroll", soon, { capture: true });
    removeEventListener("resize", soon);
    removeEventListener("hashchange", hashed); removeEventListener("popstate", hashed);
    removeEventListener("scrollend", rering, { capture: true });
    removeEventListener("scroll", settled, { capture: true });
    if (settle) clearTimeout(settle);
    settle = 0; force = false;
    removeEventListener("submit", sentForm, { capture: true });
    if (vv) { vv.removeEventListener("resize", soon); vv.removeEventListener("scroll", soon); }
    if (fw) {
      try { fw.removeEventListener("scroll", soon, { capture: true }); fw.removeEventListener("submit", sentForm, { capture: true }); } catch (_) {}
      fw = null;
    }
    if (el) {
      el.removeEventListener("pointerdown", down, { capture: true }); el.removeEventListener("click", keyPress, { capture: true }); el.removeEventListener("keydown", keyLink, { capture: true });
      el.removeEventListener("input", typed, { capture: true });
      el.removeEventListener("input", keyed, { capture: true }); el.removeEventListener("focusout", leftField, { capture: true });
    }
    el = null;
  }
  const endWait = () => {
    if (waitFrame) cancelAnimationFrame(waitFrame);
    if (lostTimer) clearTimeout(lostTimer);
    waitFrame = 0; lostTimer = 0;
    if (mo) mo.disconnect();
    if (cro) cro.disconnect();
    mo = null; cro = null; cand = null;
    removeEventListener("resize", lookSoon);
    removeEventListener("hashchange", lookSoon);
  };
  /* One find() per frame, however many mutation batches came in it. */
  const look = () => {
    waitFrame = 0;
    const n = find();
    if (n && !hiddenOf(n)) { endWait(); watch(n); return; }
    if (n === cand) return;
    /* A hidden candidate can show with no DOM change at all: an <img> that is
       0x0 until it loads, a web font, a media query. Its own size and the
       viewport's are watched for that. */
    if (cro) cro.disconnect();
    cand = n; cro = null;
    if (n) { cro = new ResizeObserver(lookSoon); cro.observe(n); }
  };
  function lookSoon() { if (!waitFrame) waitFrame = requestAnimationFrame(look); }
  /* Which mutation batches can change the answer. A JS-animated page writes
     \`style\` every frame: with no candidate yet, a style write cannot make an
     element match; with one, a write to it or above it can show it. A class,
     hidden or open write anywhere else can too (\`.toggle.open + .menu\` shows a
     sibling that keeps its size, so no ResizeObserver fires): for those the
     candidate is measured again, which is cheap, and only a change is a look. */
  const matters = (records) => !records || records.some((r) => {
    if (r.type !== "attributes") return true;
    if (!cand) return r.attributeName !== "style";
    if (r.target === cand || (typeof r.target.contains === "function" && r.target.contains(cand))) return true;
    return r.attributeName !== "style" && !hiddenOf(cand);
  });
  window.__agxGuideStop = () => {
    endWait();
    unwatch();
    delete window.__agxGuideStop;
  };
  function beginWait() {
    /* Not there yet (a page still building after a navigation): wait for the DOM to change, never poll. */
    mo = new MutationObserver((records) => { if (matters(records)) lookSoon(); });
    /* Attributes too: a target added hidden is shown by a style, class, hidden or
       open change, not by a new child. Until then, or until the step ends, it waits. */
    mo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });
    addEventListener("resize", lookSoon, { passive: true });
    /* A hash can show the target by CSS alone (\`:target { visibility: visible }\`):
       no DOM write and no size change, so nothing above hears it. */
    addEventListener("hashchange", lookSoon);
    /* A run's step whose target is still not here 2 s on is lost: one timer, not a poll. */
    if (spec.watchLost && !lostSent) {
      lostTimer = setTimeout(() => { lostTimer = 0; lostSent = true; report({ gone: { url: location.href } }); }, 2000);
    }
  }
  /* A run's nav step with no target: nothing to find or lose. The world is
     there for the navigation alone, which the main process reports. */
  if (!spec.selector && !spec.role && !spec.again) return false;
  const now = find();
  const go = now ? firstLook(hiddenOf(now), !!spec.watchLost) : "wait";
  if (go === "watch") return watch(now);
  if (go === "refuse") return hiddenOf(now);
  beginWait();
  /* Found hidden on a run: it is the candidate from the start, so the write that shows it is heard. */
  if (now) look();
  return false;
})()`;
}

function createGuideObserver({ send, emit }) {
  let spec = null; // {tab, selector, role, name, waitClick, step, say}
  let contextId = null;
  let mainFrame = null;
  let making = null;
  let gen = 0;
  /* A main-frame load that has started and not yet committed. Page events
     carry no loaderId before the commit, so the observer keeps this flag. */
  let loading = false;
  /* The load in flight when this step started belongs to the step before:
     its frameNavigated still remakes the world, but answers nothing. */
  let staleNav = false;

  const phase = () => (spec && spec.waitClick ? "wait" : "point");
  const base = () => ({
    kind: "guide", tab: spec.tab, phase: phase(),
    ...(spec.step ? { step: spec.step } : {}),
    /* The panel's id of the `point` this report belongs to: it drops any other. */
    ...(spec.stepId !== undefined ? { stepId: spec.stepId } : {}),
    /* No `say`: a report only moves the rect or tells of a press. The relay's
       `point` is the one event that starts a step (shared GuideActivity). */
    waitClick: !!spec.waitClick,
  });

  async function make() {
    const mine = ++gen;
    await send("Page.enable", {});
    await send("Runtime.enable", {});
    const tree = await send("Page.getFrameTree", {});
    mainFrame = tree && tree.frameTree && tree.frameTree.frame ? tree.frameTree.frame.id : null;
    if (!mainFrame) throw new Error("the page has no main frame");
    await send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
    const w = await send("Page.createIsolatedWorld", { frameId: mainFrame, worldName: WORLD, grantUniveralAccess: false });
    if (mine !== gen || !spec) return false; // stopped, or a newer target, while this was in flight
    contextId = w && w.executionContextId;
    if (!contextId) throw new Error("the isolated world was not made");
    const r = await send("Runtime.evaluate", {
      expression: observerSource({
        selector: spec.selector || "", role: spec.role || "", name: spec.name || "",
        ...(spec.text ? { text: spec.text } : {}), ...(spec.again ? { again: spec.again } : {}),
        ...(spec.wait ? { wait: spec.wait } : {}), ...(spec.watchLost ? { watchLost: true } : {}),
      }),
      contextId, returnByValue: true,
    });
    const v = r && r.result ? r.result.value : false;
    return typeof v === "string" ? v : !!v;
  }

  let last = Promise.resolve(true);
  function remake() {
    contextId = null;
    const p = make().catch(() => false).finally(() => { if (making === p) making = null; });
    making = p; last = p;
    return p;
  }

  return {
    /** Point at a new target (replaces the previous one). Resolves {ok, found, reason?} or {ok:false, error}. */
    async start(next) {
      /* The previous target's watchers live in the world made for it: take
         them down there first, or they keep reporting after the step moved on. */
      const old = contextId;
      /* Off while the old world stops: with no spec, onMessage drops every
         report and navigation, so the old step cannot speak for the new one. */
      contextId = null; spec = null;
      const mine = ++gen;
      staleNav = loading;
      if (old) { try { await send("Runtime.evaluate", { expression: "window.__agxGuideStop && window.__agxGuideStop()", contextId: old }); } catch { /* document gone */ } }
      /* End guide (or a newer point) came while the old world stopped: stay off. */
      if (gen !== mine) return { ok: true, found: false };
      spec = { ...next };
      /* In flight as `making`: the first attach's Runtime.enable replays the
         page's default context as executionContextCreated, and with nothing in
         flight onMessage remade the world, which bumped gen and made this
         make answer false. The first point of a page said followed:false. */
      const p = make();
      making = p;
      try {
        const v = await p;
        /* There but not visible: nothing is watched, and the agent hears why. */
        if (typeof v === "string") return { ok: true, found: false, reason: v };
        return { ok: true, found: v };
      } catch (e) {
        spec = null; contextId = null;
        return { ok: false, error: String(e && e.message ? e.message : e) };
      } finally {
        if (making === p) making = null;
      }
    },
    /** Guide end, tab close, agent detach: take the world's watchers down. Never throws. */
    async stop() {
      const ctx = contextId;
      spec = null; contextId = null; gen++;
      if (ctx) { try { await send("Runtime.evaluate", { expression: "window.__agxGuideStop && window.__agxGuideStop()", contextId: ctx }); } catch { /* page gone */ } }
      try { await send("Runtime.removeBinding", { name: BINDING }); } catch { /* never added, or guest gone */ }
    },
    get live() { return !!spec; },
    /** Every debugger event of this guest goes through here. */
    onMessage(method, params) {
      const main = params && (!mainFrame || params.frameId === mainFrame);
      if ((method === "Page.frameStartedLoading" || method === "Page.frameRequestedNavigation") && main) {
        loading = true;
        /* A navigation asked for after this step started is this step's own. */
        if (method === "Page.frameRequestedNavigation") staleNav = false;
      } else if (method === "Page.frameStoppedLoading" && main) {
        loading = false; staleNav = false;
      }
      if (method === "Page.frameNavigated" && params && params.frame && !params.frame.parentId) loading = false;
      if (!spec) return;
      if (method === "Runtime.bindingCalled" && params && params.name === BINDING) {
        if (contextId && params.executionContextId !== contextId) return;
        let m;
        try { m = JSON.parse(params.payload); } catch { return; }
        if (!m) return;
        /* A run's reports: lost (and found again), typing done, the form sent. */
        if (m.gone) { emit({ ...base(), gone: { url: String(m.gone.url || "") } }); return; }
        if (m.back) emit({ ...base(), back: true });
        if (typeof m.typing === "boolean") { emit({ ...base(), typing: m.typing }); return; }
        if (m.input) { emit({ ...base(), input: true }); return; }
        if (m.submitted) { emit({ ...base(), submitted: true }); return; }
        if (!m.rect) return;
        const r = m.rect;
        const vw = +r.vw, vh = +r.vh;
        emit({ ...base(), target: { rect: { x: +r.x || 0, y: +r.y || 0, w: +r.w || 0, h: +r.h || 0, ...(vw > 0 ? { vw } : {}), ...(vh > 0 ? { vh } : {}) } }, ...(m.clicked ? { clicked: true } : {}) });
        return;
      }
      if (method === "Page.frameNavigated" && params && params.frame && !params.frame.parentId) {
        if (staleNav) staleNav = false;
        else emit({ ...base(), navigated: { url: String(params.frame.url || "") } });
        remake();
        return;
      }
      /* A default context in the main frame after ours went away (a reload that skipped frameNavigated's order): make it again. */
      if (method === "Runtime.executionContextCreated" && params && params.context && !contextId && !making) {
        const aux = params.context.auxData || {};
        if (aux.isDefault && (!mainFrame || aux.frameId === mainFrame)) remake();
        return;
      }
      if (method === "Runtime.executionContextDestroyed" && params && params.executionContextId === contextId) {
        contextId = null;
      }
    },
    /** Tests: the remake still running, so a fake can await it. */
    settle() { return last; },
  };
}

module.exports = { createGuideObserver, observerSource, offView, hiddenWhy, firstLook, typingCounts, rearmOpen, REARM_MS, shouldSend, nameOf, hasRole, nameFits, matchRank, WORLD, BINDING };
