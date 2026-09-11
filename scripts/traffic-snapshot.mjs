#!/usr/bin/env bun
/**
 * Keep a permanent record of repository traffic.
 *
 * GitHub's traffic API only ever answers for the last 14 days, and it does not
 * roll anything up. Every day that passes silently drops a day off the back:
 * the launch week, the day a post landed, the shape of a spike — all of it is
 * gone two weeks later and cannot be recovered by anyone, including GitHub.
 *
 * So this reads the rolling window and merges it into CSVs that live on their
 * own branch. Run it daily and the window becomes a history.
 *
 * Two shapes of data, merged differently:
 *
 *  - views and clones are per-day buckets, so they upsert by date. Today's
 *    bucket is always partial, which is exactly why it must overwrite rather
 *    than append: tomorrow's run replaces it with the finished count.
 *  - referrers and paths are 14-day aggregates with no per-day breakdown, so
 *    the only honest thing to store is a dated snapshot of each run.
 *
 * Usage: bun scripts/traffic-snapshot.mjs <data-dir>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: traffic-snapshot.mjs <data-dir>");
  process.exit(2);
}

const REPO = process.env.GITHUB_REPOSITORY || "SirAllap/agentglass";
const TOKEN = process.env.TRAFFIC_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("traffic: no token — set TRAFFIC_TOKEN or GITHUB_TOKEN");
  process.exit(1);
}

/** The day a timestamp falls in. The API returns midnight UTC either way, but
 *  it has shipped both `2026-07-27T00:00:00Z` and an epoch in milliseconds. */
const dayOf = (t) =>
  typeof t === "number" ? new Date(t).toISOString().slice(0, 10) : String(t).slice(0, 10);

const today = new Date().toISOString().slice(0, 10);

async function get(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/traffic/${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "agentglass-traffic",
      authorization: `Bearer ${TOKEN}`,
    },
  });
  if (r.status === 401) {
    /*
     * A different fault from the one below, with a different fix, and the
     * number is the only thing that says which — so it says it in words.
     *
     * 401 is the credential itself: expired, revoked or regenerated. A
     * fine-grained PAT expires, and the default when you mint one is thirty
     * days, so this arrives about a month after somebody sets it up and works
     * perfectly in between. 403 is a token that IS valid and is not allowed to
     * read this, which is the case below.
     *
     * Worth spelling out because of what it costs. GitHub keeps fourteen days
     * of traffic and rolls nothing up; this job exists to turn that window
     * into a history. A run that fails is a day that cannot be recovered by
     * anybody, including GitHub, and a token nobody notices has expired takes
     * a fortnight of the record with it before the gap is visible.
     */
    console.error(
      `traffic: 401 on /${path}. The token is not valid — expired, revoked or replaced.\n` +
        "  A fine-grained PAT expires; thirty days is the default when you mint one.\n" +
        "  Fix: mint a new one with Administration: read on this repo, save it as\n" +
        "  the TRAFFIC_TOKEN secret, and re-run this workflow.\n" +
        "  Every day this stays broken is a day of traffic nobody can get back.",
    );
    process.exit(1);
  }
  if (r.status === 403 || r.status === 404) {
    // The one failure worth spelling out. Every traffic endpoint needs *push*
    // access, which the default Actions token does not always carry, and the
    // API answers 403 rather than saying so.
    console.error(
      `traffic: ${r.status} on /${path}. These endpoints need push access.\n` +
        "  Fix: create a fine-grained PAT with Administration: read on this repo,\n" +
        "  save it as the TRAFFIC_TOKEN secret, and re-run.",
    );
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`traffic: ${r.status} on /${path}`);
    process.exit(1);
  }
  return r.json();
}

/** Quote a CSV field only when it needs it, so the files stay readable. */
const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * Merge rows into a CSV, replacing any row whose key already exists.
 *
 * Reading the file back rather than appending blind is what makes the job
 * safe to re-run: a manual run an hour after the scheduled one updates today
 * instead of writing a second, contradictory row for it.
 */
function merge(name, header, keyOf, rows) {
  const path = join(dir, name);
  const kept = new Map();
  if (existsSync(path)) {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    for (const line of lines.slice(1)) {
      if (line.trim()) kept.set(keyOf(parseRow(line)), line);
    }
  }
  for (const row of rows) kept.set(keyOf(row), row.map(cell).join(","));

  const body = [...kept.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, l]) => l);
  writeFileSync(path, `${header.join(",")}\n${body.join("\n")}\n`);
  return body.length;
}

/** Split one CSV line back into fields, honouring the quoting `cell` applies. */
function parseRow(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

mkdirSync(dir, { recursive: true });

const [views, clones, referrers, paths] = await Promise.all([
  get("views"),
  get("clones"),
  get("popular/referrers"),
  get("popular/paths"),
]);

const days = merge(
  "views.csv",
  ["date", "views", "uniques"],
  (r) => r[0],
  (views.views ?? []).map((v) => [dayOf(v.timestamp), v.count, v.uniques]),
);
const cloneDays = merge(
  "clones.csv",
  ["date", "clones", "uniques"],
  (r) => r[0],
  (clones.clones ?? []).map((c) => [dayOf(c.timestamp), c.count, c.uniques]),
);
merge(
  "referrers.csv",
  ["snapshot", "referrer", "views", "uniques"],
  (r) => JSON.stringify([r[0], r[1]]),
  (referrers ?? []).map((r) => [today, r.referrer, r.count, r.uniques]),
);
merge(
  "paths.csv",
  ["snapshot", "path", "views", "uniques"],
  (r) => JSON.stringify([r[0], r[1]]),
  (paths ?? []).map((p) => [today, p.path, p.count, p.uniques]),
);

console.log(
  `traffic: ${days} days of views, ${cloneDays} of clones, ` +
    `${referrers?.length ?? 0} referrers and ${paths?.length ?? 0} paths as of ${today}`,
);
