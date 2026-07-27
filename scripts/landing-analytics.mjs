#!/usr/bin/env bun
/**
 * Fill in the landing page's counter at deploy time.
 *
 * The site had no measurement of any kind, so "did the post work?" had no
 * answer beyond stars. This adds one to the *page*, and nowhere else.
 *
 * The line agentglass does not cross: the product is localhost-only and never
 * phones home, and that is a promise the README makes in as many words. A
 * marketing page counting its own visits is an ordinary thing that costs the
 * reader nothing; telemetry inside the cockpit would be a different thing
 * wearing the same word. So this touches `landing/` and only `landing/`.
 *
 * Both supported counters are cookieless and store no cross-site identifier,
 * which is what keeps the page free of a consent banner nobody wants to click.
 *
 * Configured by repository variable, not by editing the page:
 *
 *   GOATCOUNTER_CODE            your goatcounter subdomain, e.g. "agentglass"
 *   CLOUDFLARE_ANALYTICS_TOKEN  the beacon token from Cloudflare Web Analytics
 *
 * With neither set the markers are left exactly as they are and the page ships
 * without a counter, which is the correct behaviour for a fork, a preview, or
 * anyone building this repository who is not you.
 *
 * Usage: bun scripts/landing-analytics.mjs site/index.html
 */
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: landing-analytics.mjs <path-to-index.html>");
  process.exit(2);
}

const START = "<!-- analytics:start -->";
const END = "<!-- analytics:end -->";

const goat = (process.env.GOATCOUNTER_CODE || "").trim();
const cf = (process.env.CLOUDFLARE_ANALYTICS_TOKEN || "").trim();

/** Refuse anything that isn't the plain identifier each vendor issues, so a
 *  mis-set variable can never become markup on the page. */
const safe = (v, re) => re.test(v);

let snippet = "";
if (goat && cf) {
  console.warn("analytics: both counters configured — using goatcounter, ignoring cloudflare");
}
if (goat) {
  if (!safe(goat, /^[a-z0-9-]{1,63}$/i)) {
    console.warn(`analytics: GOATCOUNTER_CODE ${JSON.stringify(goat)} is not a bare subdomain — skipping`);
  } else {
    snippet =
      `<script data-goatcounter="https://${goat}.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>`;
  }
} else if (cf) {
  if (!safe(cf, /^[a-f0-9]{16,64}$/i)) {
    console.warn("analytics: CLOUDFLARE_ANALYTICS_TOKEN is not a hex token — skipping");
  } else {
    snippet =
      `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" ` +
      `data-cf-beacon='{"token":"${cf}"}'></script>`;
  }
}

// Said as a workflow annotation, not just a log line. A deploy that quietly
// ships no counter looks identical to one that ships a working counter nobody
// is visiting, and telling those apart by reading the log means scrolling past
// every asset the demo build lists. This puts the answer on the run itself.
const say = (level, text) => console.log(`::${level}::${text}`);

if (!snippet) {
  say(
    "warning",
    "analytics: no counter configured, the page ships without one. " +
      "Set GOATCOUNTER_CODE or CLOUDFLARE_ANALYTICS_TOKEN as a repository " +
      "*variable* (Settings > Secrets and variables > Actions > Variables). " +
      "A value set as a secret, or on the account rather than the repository, " +
      "does not reach this step.",
  );
  process.exit(0);
}

const html = readFileSync(file, "utf8");
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  // Never fatal. A page that lost its markers is a page that still works.
  console.warn("analytics: markers not found — leaving the page as written");
  process.exit(0);
}

writeFileSync(file, html.slice(0, from + START.length) + snippet + html.slice(to));
say(
  "notice",
  `analytics: ${goat ? `goatcounter (${goat})` : "cloudflare"} counter stamped into ${file}. ` +
    "If the counter still reports nothing after this deploy, the page has the " +
    "tag and something between the visitor and the counter is dropping it, " +
    "which for these vendors is usually an ad blocker or a filtering resolver.",
);
