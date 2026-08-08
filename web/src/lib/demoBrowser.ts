/**
 * The pages the demo's built-in browser is showing, for the demo build only.
 *
 * The browser view was dropped from the rail entirely outside the desktop shell
 * (`workspace/views.ts`), because a `<webview>` does not exist in a browser tab
 * and an entry that opens an empty pane is worse than no entry. True on a
 * phone; wrong for the demo the landing page links to, where the effect was
 * that the feature simply did not exist for anybody evaluating the app.
 *
 * A demo cannot embed a live page — there is no guest to attach — so these are
 * drawn as ordinary DOM by `components/browser/DemoPage.tsx`. Everything around
 * them is the real panel: the strip, the address bar with its suggestions, the
 * find bar, the profile menu.
 *
 * The addresses are the demo's own machine, and they agree with the rest of it:
 * the ports panel lists vite on 5173 in `shop-web` and bun on 3000 in
 * `shop-api`, and the cart below adds up the way the checkout test in
 * `demoTerm.ts` says it should. Nothing here names a real company or borrows a
 * real site's interface — a fabricated page wearing somebody's brand is a
 * forgery, however small, and this one only has to look like a page.
 */

export interface DemoTabSeed {
  url: string;
  title: string;
}

/** What the strip opens with. Three, because one tab hides the strip. */
export const DEMO_BROWSER_TABS: DemoTabSeed[] = [
  { url: "http://localhost:5173/", title: "Harbour Goods — dev" },
  { url: "http://localhost:3000/health", title: "shop-api · health" },
  { url: "http://localhost:5173/checkout", title: "Checkout — Harbour Goods" },
];

export interface DemoLine {
  name: string;
  qty: number;
  /** Pence, so the arithmetic on screen is the arithmetic in the test. */
  each: number;
}

/** The basket the checkout test is about: two of one line, and a discount that
 *  applies once rather than per unit. */
export const DEMO_BASKET: DemoLine[] = [
  { name: "Deck brush, stiff", qty: 2, each: 1_150 },
  { name: "Cotton rope, 8mm — 10m", qty: 1, each: 2_400 },
  { name: "Brass cleat", qty: 4, each: 890 },
];

export const DEMO_DISCOUNT = 500;
export const DEMO_SHIPPING = 450;

export const subtotal = (lines: DemoLine[] = DEMO_BASKET) =>
  lines.reduce((n, l) => n + l.qty * l.each, 0);

/** Shipping is not discounted — the third passing assertion in the canned test
 *  run, and the reason this is a function rather than a written-down number. */
export const total = (lines: DemoLine[] = DEMO_BASKET) =>
  subtotal(lines) - DEMO_DISCOUNT + DEMO_SHIPPING;

export const money = (pence: number) =>
  `£${(pence / 100).toFixed(2)}`;

/** The JSON the api tab is showing. A real `/health` answer, shaped like the
 *  server's own. */
export const DEMO_HEALTH = {
  ok: true,
  service: "shop-api",
  version: "2.4.1",
  uptime_s: 5_412,
  checks: { db: "ok", cache: "ok", queue: "ok" },
};
