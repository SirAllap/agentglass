/**
 * `vitals` and `a11y`: measurement answered as data, not as a screenshot of
 * DevTools. Both are page scripts (strings, like the rest of this driver) so
 * they can be run against a stand-in in a test and against a real page in the
 * bench. No dependency: the web-vitals logic that matters here is small.
 *
 * (No backticks in the comments inside these templates: one would end the
 * template literal that builds the script.)
 */
import { ACC_NAME, STAMP } from "./browserObserve.ts";

/** web.dev's thresholds: [good up to, poor from]. */
export const VITAL_LIMITS = {
  lcpMs: [2500, 4000],
  cls: [0.1, 0.25],
  inpMs: [200, 500],
  ttfbMs: [800, 1800],
  fcpMs: [1800, 3000],
} as const;

export type VitalName = keyof typeof VITAL_LIMITS;

/** good / needs-improvement / poor for one value, by the thresholds above. */
export function rate(name: VitalName, v: number): "good" | "needs-improvement" | "poor" {
  const [good, poor] = VITAL_LIMITS[name];
  return v <= good ? "good" : v > poor ? "poor" : "needs-improvement";
}

export const VITALS_SCRIPT = `(async () => {
  const buffered = (type, opts) => new Promise((resolve) => {
    let got = [];
    let po = null;
    try {
      po = new PerformanceObserver((list) => { got = got.concat(list.getEntries()); });
      po.observe(Object.assign({ type, buffered: true }, opts || {}));
    } catch (err) { resolve(null); return; }
    setTimeout(() => {
      try { got = got.concat(po.takeRecords ? po.takeRecords() : []); po.disconnect(); } catch (err) {}
      resolve(got);
    }, 0);
  });
  const out = { url: location.href, title: document.title };
  const [lcp, shifts, events, paints] = await Promise.all([
    buffered("largest-contentful-paint"), buffered("layout-shift"),
    buffered("event", { durationThreshold: 16 }), buffered("paint"),
  ]);
  const v = {};
  if (lcp && lcp.length) v.lcpMs = Math.round(lcp[lcp.length - 1].startTime);
  if (shifts) {
    /* Session windows, as web.dev defines CLS: shifts less than 1 s apart and
       inside 5 s of the window's first belong together; the worst window is the
       number. A plain sum over-reports a page that shifts a little all day. */
    let worst = 0, cur = 0, first = 0, last = 0;
    for (const s of shifts) {
      if (s.hadRecentInput) continue;
      if (cur && s.startTime - last < 1000 && s.startTime - first < 5000) cur += s.value || 0;
      else { cur = s.value || 0; first = s.startTime; }
      last = s.startTime;
      if (cur > worst) worst = cur;
    }
    v.cls = Math.round(worst * 1000) / 1000;
  }
  if (events && events.length) {
    /* INP: the slowest interaction (the 98th percentile once there are 50+,
       which the worst of a handful stands in for). An interaction is every
       event entry sharing an interactionId; its latency is the longest. */
    const byId = {};
    for (const e of events) if (e.interactionId) byId[e.interactionId] = Math.max(byId[e.interactionId] || 0, e.duration);
    const lat = Object.keys(byId).map((k) => byId[k]).sort((a, b) => b - a);
    if (lat.length) v.inpMs = Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length / 50))]);
  }
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav && nav.responseStart) v.ttfbMs = Math.round(nav.responseStart);
  } catch (err) {}
  const fcp = paints && paints.filter((p) => p.name === "first-contentful-paint")[0];
  if (fcp) v.fcpMs = Math.round(fcp.startTime);
  out.vitals = v;
  return out;
})()`;

/** Whether the page can be scanned for what a screen reader would miss. */
export const A11Y_SCRIPT = `(() => {
  const name = ${ACC_NAME};
  const stamp = ${STAMP};
  const NAMED_BY_VALUE = { submit: 1, button: 1, reset: 1, image: 1 };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  };
  const sample = (list) => list.slice(0, 10).map((el) => stamp(el) + " " + el.tagName.toLowerCase());
  const unlabelled = [];
  for (const el of document.querySelectorAll('input,select,textarea,button,[role="button"],a[href]')) {
    const t = el.tagName === "INPUT" ? String(el.type || "text").toLowerCase() : "";
    if (t === "hidden") continue;
    if (NAMED_BY_VALUE[t] && (el.value || el.getAttribute("alt"))) continue;
    if (!shown(el) || name(el)) continue;
    unlabelled.push(el);
  }
  const imgs = [...document.querySelectorAll("img")].filter((el) => !el.hasAttribute("alt") && shown(el));
  /* A heading level that jumps (h1 then h3) breaks the outline a screen reader
     navigates by. Only a jump DOWN the outline counts; going back up is fine. */
  const skips = [];
  let prev = 0;
  for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    if (!shown(h)) continue;
    const lvl = Number(h.tagName[1]);
    if (prev && lvl > prev + 1) skips.push(h);
    prev = lvl;
  }
  const problems = {};
  if (unlabelled.length) problems.unlabelled = { n: unlabelled.length, samples: sample(unlabelled) };
  if (imgs.length) problems.imgNoAlt = { n: imgs.length, samples: sample(imgs) };
  if (skips.length) problems.headingSkips = { n: skips.length, samples: sample(skips) };
  if (!document.documentElement.getAttribute("lang")) problems.noLang = true;
  if (!document.title) problems.noTitle = true;
  const n = (unlabelled.length ? 1 : 0) + (imgs.length ? 1 : 0) + (skips.length ? 1 : 0) + (problems.noLang ? 1 : 0) + (problems.noTitle ? 1 : 0);
  return { url: location.href, title: document.title, verdict: n ? n + " kinds of problem" : "ok", problems };
})()`;
