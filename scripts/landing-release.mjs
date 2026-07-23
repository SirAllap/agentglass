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
 *    JavaScript off;
 *  - and if it fails, it leaves the page alone. The markers ship with copy that
 *    is true without them ("Download the desktop app", pointing at
 *    releases/latest), so the worst case is a page that is vaguer than it could
 *    be, never one that names a version that does not exist.
 *
 * Usage: bun scripts/landing-release.mjs site/index.html
 */
const file = process.argv[2];
if (!file) {
  console.error("usage: landing-release.mjs <path-to-index.html>");
  process.exit(2);
}

const REPO = process.env.GITHUB_REPOSITORY || "SirAllap/agentglass";
const headers = { accept: "application/vnd.github+json", "user-agent": "agentglass-landing" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

/** The newest published release, or null if there isn't one we can read. */
async function latestRelease() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!r.ok) {
      console.warn(`landing: no release to stamp (${r.status}) — leaving the page as written`);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn(`landing: could not reach the releases API (${e}) — leaving the page as written`);
    return null;
  }
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
};

/** Bytes as something a human reads before clicking a 150 MB link. */
const human = (bytes) => (bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : `${Math.round(bytes / 1024 ** 2)} MB`);

function assetFor(assets, os) {
  for (const pattern of PICKS[os] ?? []) {
    const hit = assets.find((a) => pattern.test(a.name));
    if (hit) return hit;
  }
  return null;
}

const release = await latestRelease();
if (!release) process.exit(0);

const version = String(release.tag_name || "").trim();
const assets = Array.isArray(release.assets) ? release.assets : [];
let html = await Bun.file(file).text();
let stamped = 0;

if (version) {
  // `<span data-agx="version">whatever the page says by default</span>`
  html = html.replace(
    /(<span data-agx="version"[^>]*>)([^<]*)(<\/span>)/g,
    (_m, open, _old, close) => { stamped++; return `${open}${version}${close}`; },
  );
}

for (const slot of Object.keys(PICKS)) {
  const asset = assetFor(assets, slot);
  if (!asset?.browser_download_url) continue;
  html = html.replace(
    new RegExp(`(<a[^>]*data-dl="${slot}"[^>]*href=")([^"]*)(")`, "g"),
    (_m, open, _old, close) => { stamped++; return `${open}${asset.browser_download_url}${close}`; },
  );
  // The size label keeps whatever it shipped with when there is no asset, so a
  // missing build reads as ".dmg" rather than as "0 MB".
  if (asset.size) {
    html = html.replace(
      new RegExp(`(<span[^>]*data-size="${slot}"[^>]*>)([^<]*)(</span>)`, "g"),
      (_m, open, _old, close) => { stamped++; return `${open}${human(asset.size)}${close}`; },
    );
  }
}

if (!stamped) {
  console.warn("landing: nothing to stamp — the markers are missing, so the page is unchanged");
  process.exit(0);
}

await Bun.write(file, html);
console.log(`landing: stamped ${version || "(no tag)"} into ${stamped} place(s) · assets: ${assets.map((a) => a.name).join(", ") || "none"}`);
