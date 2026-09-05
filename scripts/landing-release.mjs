#!/usr/bin/env bun
/**
 * Stamp the current release into the landing page at deploy time.
 *
 * The page used to name a version in its own copy, which meant every release
 * quietly made the site wrong until someone remembered to edit it. Nobody ever
 * remembers, so the version and the per-OS download links are markers now and
 * this fills them in as the site is assembled.
 *
 * Deliberately a build step rather than a fetch in the page:
 *
 *  - the deploy already runs on every push to main and on a published release,
 *    so the answer is fresh without a request from every visitor;
 *  - no rate limit, no third-party call at render time, and it works with
 *    JavaScript off.
 *
 * What it does when something is missing is the whole point of the file:
 *
 *  - nothing published yet — the markers keep the copy they ship with
 *    ("Download the desktop app", pointing at releases/latest), which is true
 *    without a version. Not an error: a fork in that state is fine, and so is
 *    the repository the day before its first release.
 *  - a release, but no build for one platform — that slot is stamped as
 *    unavailable and offered the newest earlier release that does carry the
 *    file. It used to be skipped, which left the card with a live-looking
 *    button, its placeholder ".dmg" label and an href to releases/latest: the
 *    page advertised a download that does not exist. A visibly dead button is
 *    a disappointment; a live one that leads nowhere is a lie.
 *  - a marker this cannot answer — a slot nobody builds, a typo in a slot
 *    name, markup that moved out from under a regex — exits 1 and stops the
 *    deploy. Every one of those failed silently before, which is precisely how
 *    a page ships for weeks pointing at nothing.
 *
 * Offline, and how both branches above are tested: point
 * AGENTGLASS_RELEASES_JSON at a file holding the `/releases` payload (newest
 * first) and nothing is fetched.
 *
 * Usage: bun scripts/landing-release.mjs site/index.html
 */
const file = process.argv[2];
if (!file) {
  console.error("usage: landing-release.mjs <path-to-index.html>");
  process.exit(2);
}

const REPO = process.env.GITHUB_REPOSITORY || "SirAllap/agentglass";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const headers = { accept: "application/vnd.github+json", "user-agent": "agentglass-landing" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

/** Stop the deploy, and say which of the two things went wrong: the page or us. */
function die(why) {
  console.error(`landing: ${why} — refusing to publish a page that would be wrong`);
  process.exit(1);
}

/**
 * Three attempts at the releases API.
 *
 * A dropped connection is not a reason to publish last month's links, and it
 * is not a reason to fail a deploy on the first hiccup either. A 401 or a 404
 * is neither: those mean the repository name or the token is wrong, and no
 * amount of waiting fixes it.
 */
async function fetchReleases() {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
  for (let attempt = 1; ; attempt++) {
    let why;
    try {
      const r = await fetch(url, { headers });
      if (r.ok) return await r.json();
      why = `HTTP ${r.status}`;
      // An empty repository answers this endpoint with `[]`, so a 404 here is
      // the repository itself, not the absence of releases.
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        die(`cannot read the releases of ${REPO} (${why}) — check GITHUB_REPOSITORY and GITHUB_TOKEN`);
      }
    } catch (e) {
      why = String(e);
    }
    if (attempt === 3) die(`the releases API is unreadable after ${attempt} tries (${why})`);
    console.warn(`landing: ${why} from the releases API — retrying`);
    await new Promise((wake) => setTimeout(wake, attempt * 2000));
  }
}

/**
 * The published releases, newest first.
 *
 * One request rather than two: `releases/latest` answers only half the
 * question, and the other half — which release last carried a `.dmg` — needs
 * the history anyway. Drafts and prereleases are dropped here so the first
 * entry still means what `releases/latest` meant when this asked for it by
 * name.
 */
async function releases() {
  const offline = process.env.AGENTGLASS_RELEASES_JSON;
  let raw;
  if (offline) {
    try {
      raw = JSON.parse(await Bun.file(offline).text());
    } catch (e) {
      die(`AGENTGLASS_RELEASES_JSON points at ${offline}, which is not readable JSON (${e})`);
    }
  } else {
    raw = await fetchReleases();
  }
  if (!Array.isArray(raw)) die("the releases payload is not a list");
  return raw.filter((r) => r && !r.draft && !r.prerelease);
}

/**
 * Which asset answers to which slot on the page.
 *
 * Ordered, because more than one pattern can match and the first is the one
 * that slot should get. The coarse slots (`mac`, `linux`, `win`) are for the
 * one-button-per-OS rows; the specific ones back the download section, where
 * the whole point is that someone on an Intel Mac or a Debian box can take the
 * file they actually need instead of the one we guessed for them.
 */
const PICKS = {
  mac: [/arm64.*\.dmg$/i, /\.dmg$/i],
  linux: [/\.AppImage$/i, /\.deb$/i],
  win: [/\.exe$/i, /\.msi$/i],
  "mac-arm": [/arm64.*\.dmg$/i],
  "mac-x64": [/(x64|x86_64|intel).*\.dmg$/i],
  "linux-appimage": [/\.AppImage$/i],
  "linux-deb": [/\.deb$/i],
  "win-exe": [/\.exe$/i, /\.msi$/i],
  android: [/\.apk$/i],
};

/**
 * What a slot is called in a sentence.
 *
 * The page cannot carry this copy itself: the only time it is needed is when a
 * build did not happen, and the page has no way of knowing that. Keep these in
 * step with the button labels in the download section.
 */
const NAMES = {
  mac: "macOS",
  linux: "Linux",
  win: "Windows",
  "mac-arm": "Apple silicon",
  "mac-x64": "Intel",
  "linux-appimage": "AppImage",
  "linux-deb": ".deb",
  "win-exe": "Windows installer",
  android: "the Android app",
};

/** Bytes as something a human reads before clicking a 150 MB link. */
const human = (bytes) => (bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : `${Math.round(bytes / 1024 ** 2)} MB`);

/** Tags and asset URLs come from the API, so they are escaped before they
 *  become markup. An href built by hand is exactly where this page has been
 *  bitten before. */
const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function assetFor(assets, os) {
  for (const pattern of PICKS[os] ?? []) {
    const hit = assets.find((a) => pattern.test(a.name));
    if (hit) return hit;
  }
  return null;
}

const published = await releases();
if (!published.length) {
  console.warn("landing: nothing published to stamp — the page keeps the copy it ships with");
  process.exit(0);
}

const release = published[0];
const version = String(release.tag_name || "").trim();
if (!version) die("the newest release has no tag name");
const assets = Array.isArray(release.assets) ? release.assets : [];

/** The newest release before this one that does carry the file, so a platform
 *  with no build still has somewhere honest to send people. Looked up rather
 *  than written down: the answer changes every time a build breaks. */
function fallbackFor(slot) {
  for (const older of published.slice(1)) {
    const asset = assetFor(Array.isArray(older.assets) ? older.assets : [], slot);
    if (asset?.browser_download_url) return { version: String(older.tag_name || "").trim(), asset };
  }
  return null;
}

let html = await Bun.file(file).text();

/**
 * What the page asked for.
 *
 * Read off the markup rather than assumed, and matched inside a tag so the
 * comment that documents the markers is not mistaken for one. A marker naming
 * a slot this script does not know is a typo that costs nothing at deploy time
 * and everything on the page, so it stops here.
 */
const markers = (tag, attr) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, "g"))].map((m) => m[1]);
const slots = [...new Set(markers("a", "data-dl"))];
const notes = new Set(markers("[a-z]+", "data-na"));
const unknown = [...new Set([...slots, ...notes, ...markers("span", "data-size")])]
  .filter((slot) => !(slot in PICKS));
if (unknown.length) die(`the page carries markers for slots nobody builds: ${unknown.join(", ")}`);
if (!slots.length) die("the page has no data-dl markers left — did the download section move?");

// `<span data-agx="version">whatever the page says by default</span>`
const versionMarkers = (html.match(/<span[^>]*\bdata-agx="version"/g) || []).length;
if (!versionMarkers) die("the page has no data-agx=\"version\" marker");
let versionStamps = 0;
html = html.replace(
  /(<span[^>]*\bdata-agx="version"[^>]*>)([^<]*)(<\/span>)/g,
  (_m, open, _old, close) => { versionStamps++; return `${open}${esc(version)}${close}`; },
);
if (versionStamps !== versionMarkers) {
  die(`only ${versionStamps} of ${versionMarkers} version markers could be filled in`);
}

/** Replace once and say whether it happened, because "the regex found nothing"
 *  is the failure this file exists to stop being silent. */
function swap(pattern, replacer) {
  let hits = 0;
  html = html.replace(pattern, (...args) => { hits++; return replacer(...args); });
  return hits;
}

const live = [];
const pending = [];

for (const slot of slots) {
  const asset = assetFor(assets, slot);

  if (asset?.browser_download_url) {
    const hits = swap(
      new RegExp(`(<a[^>]*data-dl="${slot}"[^>]*href=")([^"]*)(")`, "g"),
      (_m, open, _old, close) => `${open}${esc(asset.browser_download_url)}${close}`,
    );
    if (!hits) die(`data-dl="${slot}" is on the page but its <a href> did not match`);
    if (asset.size) {
      swap(
        new RegExp(`(<span[^>]*data-size="${slot}"[^>]*>)([^<]*)(</span>)`, "g"),
        (_m, open, _old, close) => `${open}${human(asset.size)}${close}`,
      );
    }
    live.push(slot);
    continue;
  }

  // No build for this platform in this release. Two states, and the difference
  // matters to whoever is standing in front of the card: `old` still hands over
  // a file — the last version that had one, named so nobody thinks it is this
  // one — while `na` has no href at all, which is what makes it unclickable and
  // untabbable rather than merely grey.
  const back = fallbackFor(slot);
  const state = back ? "old" : "na";
  const tags = swap(new RegExp(`<a\\b[^>]*\\bdata-dl="${slot}"[^>]*>`, "g"), (tag) => {
    const classed = tag.replace(/\sclass="([^"]*)"/, ` class="$1 ${state}"`);
    return back
      ? classed.replace(/\shref="[^"]*"/, () => ` href="${esc(back.asset.browser_download_url)}"`)  // function replacer: a `$` in the URL is data, not a backreference
      : classed.replace(/\shref="[^"]*"/, "").replace(/^<a\b/, '<a aria-disabled="true"');
  });
  if (!tags) die(`data-dl="${slot}" is on the page but its <a> tag did not match`);

  swap(
    new RegExp(`(<span[^>]*data-size="${slot}"[^>]*>)([^<]*)(</span>)`, "g"),
    (_m, open, _old, close) => `${open}${back ? esc(back.version) : "pending"}${close}`,
  );

  // The sentence goes under the button where there is room for one, and into
  // the button's own label where there is not — that is what tells the two
  // apart, not a list of slot names kept in step by hand.
  const sentence = back
    ? `<b>${NAMES[slot]} build pending for ${esc(version)}</b> — `
      + `<a target="_blank" rel="noopener" href="${esc(back.asset.browser_download_url)}">get ${esc(back.version)}</a>`
      + `${back.asset.size ? ` (${human(back.asset.size)})` : ""}.`
    : `<b>${NAMES[slot]} build pending for ${esc(version)}</b> — no earlier release carries one either. `
      + `<a target="_blank" rel="noopener" href="${RELEASES_PAGE}">Every release is here</a>.`;
  if (notes.has(slot)) {
    // The note ships empty and `hidden`, so a page assembled without this
    // script says nothing rather than something untrue. Dropping the attribute
    // is what puts it on screen.
    const written = swap(
      new RegExp(`<([a-z]+)([^>]*\\bdata-na="${slot}"[^>]*)>([^]*?)</\\1>`, "g"),
      (_m, tag, attrs, _old) => `<${tag}${attrs.replace(/\shidden\b/, "")}>${sentence}</${tag}>`,
    );
    if (!written) die(`data-na="${slot}" is on the page but its element did not match`);
  } else {
    const labelled = swap(
      new RegExp(`(<a[^>]*data-dl="${slot}"[^>]*>)([^<]*)(</a>)`, "g"),
      (_m, open, label, close) =>
        `${open}${label.trim()} ${back ? esc(back.version) : "pending"}${close}`,
    );
    if (!labelled) die(`data-dl="${slot}" has neither a data-na note nor a plain text label to correct`);
  }

  // When a whole platform is missing, the card around it reads as dead too,
  // not just the buttons inside it. The coarse slot and the card it belongs to
  // share a name, so this needs no second table — and the specific slots match
  // no card, which is the right answer for one architecture of two.
  swap(
    new RegExp(`<article\\b[^>]*\\bdata-os="${slot}"[^>]*>`, "g"),
    (tag) => tag.replace(/\sclass="([^"]*)"/, ' class="$1 na"'),
  );

  pending.push(`${slot}${back ? ` → ${back.version}` : " (nothing to offer)"}`);
}

await Bun.write(file, html);
if (pending.length) {
  console.warn(`landing: no ${release.tag_name} build for ${pending.join(", ")} — stamped as pending`);
}
console.log(`landing: stamped ${version} · live: ${live.join(", ") || "none"} · pending: ${pending.length}`
  + ` · assets: ${assets.map((a) => a.name).join(", ") || "none"}`);
