// Serve the built dashboard (web/dist) from the API port, when a build exists.
//
// This is what lets a headless install run ONE process: `bun run build` once,
// then the server owns both the API and the UI on a single port — no vite
// preview alongside it, no second unit to keep alive. The desktop shell already
// proved the arrangement (it hosts web/dist over loopback HTTP itself); this
// gives the same thing to server-only deploys. When web/dist is absent —
// dev, or a hooks-only install that never built the UI — every route behaves
// exactly as before.
//
// Two rules keep it from treading on the API:
//   * exact files only, resolved traversal-safe under web/dist — an API path
//     matches no file there, so it falls through to the routes untouched;
//   * the SPA fallback runs LAST, after every API route has declined, and only
//     for a GET that asks for html — curl on a bad path still gets the JSON 404.
//
// index.html is served with a planted marker (see injectSameOrigin) telling the
// bundle it came from the API's own origin, so the web app can point its calls
// at location.origin instead of assuming :4000 — that is the whole contract
// between this file and web/src/lib/api.ts.

import { resolve, sep } from "node:path";
import { readFileSync, statSync } from "node:fs";

/** Does `root` hold a real build (index.html present)? */
function hasBuild(root: string): boolean {
  try {
    return statSync(resolve(root, "index.html")).isFile();
  } catch {
    return false;
  }
}

/**
 * Where the built UI lives: AGENTGLASS_WEB_DIR when set, else web/dist beside
 * the source.
 *
 * The override exists because the relative path cannot work in the packaged
 * desktop app. `import.meta.dir` inside a `bun build --compile` binary is
 * `/$bunfs/root`, a virtual filesystem holding the bundled script and nothing
 * else, so `../../web/dist` resolves to a path that has never existed and the
 * sidecar reports no UI however the app was installed. The bundle *is* there —
 * electron-builder copies web/dist to `resources/web` — and the shell knows
 * exactly where, so it passes the path in. That is what lets the desktop app
 * hand a phone on the LAN a dashboard instead of a JSON API.
 *
 * An override naming a directory with no index.html is ignored rather than
 * fatal: a wrong path should cost the UI, not the server behind it.
 */
export function resolveDist(
  webDir: string | undefined = process.env.AGENTGLASS_WEB_DIR,
  fallback: string = resolve(import.meta.dir, "../../web/dist")
): string | null {
  const asked = webDir?.trim();
  if (asked) {
    const abs = resolve(asked);
    if (hasBuild(abs)) return abs;
  }
  return hasBuild(fallback) ? fallback : null;
}

const DIST: string | null = resolveDist();

export const WEB_UI_ENABLED = DIST !== null;

/** The single-port marker. The bundle checks for it before falling back to the
 *  conventional :4000 — see SERVER in web/src/lib/api.ts. */
const MARKER = "<script>window.__AGENTGLASS_SAME_ORIGIN__=true</script>";

/** Plant the marker in index.html on its way out. Injected at serve time, not
 *  build time, so the SAME build still works under vite preview or the desktop
 *  shell's static server — pages those serve never carry the marker. */
export function injectSameOrigin(html: string): string {
  const head = html.indexOf("</head>");
  return head >= 0 ? html.slice(0, head) + MARKER + html.slice(head) : MARKER + html;
}

/** Map a request path to a real file under dist, or null. Clamped the same way
 *  git.ts clamps translated paths: resolve first, then require the result to
 *  still live under the root — `..`, encoded or not, walks out and gets null. */
export function resolveAsset(pathname: string, dist: string | null = DIST): string | null {
  if (!dist) return null;
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null; // malformed %-escape
  }
  if (p.includes("\0")) return null;
  if (p === "/") p = "/index.html";
  const abs = resolve(dist, "." + p);
  if (abs !== dist && !abs.startsWith(dist + sep)) return null;
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** index.html, marker planted. Never cached: it's the one file whose content
 *  names the (hashed) assets, so a stale copy pins a whole stale UI. */
function indexResponse(dist: string, cors: Record<string, string>): Response {
  const html = injectSameOrigin(readFileSync(resolve(dist, "index.html"), "utf8"));
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...cors },
  });
}

/** Serve `pathname` as a static UI file, or null when it maps to none (an API
 *  route, a WS upgrade — anything that isn't a real file under web/dist). */
export function serveWeb(pathname: string, cors: Record<string, string>): Response | null {
  if (!DIST) return null;
  const abs = resolveAsset(pathname);
  if (!abs) return null;
  if (abs === resolve(DIST, "index.html")) return indexResponse(DIST, cors);
  // Bun.file knows the MIME from the extension. Vite content-hashes everything
  // under assets/, which is what makes the far-future cache safe; the rest
  // (favicon and friends) revalidates.
  const cache = pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return new Response(Bun.file(abs), { headers: { "cache-control": cache, ...cors } });
}

/** The SPA fallback: index.html for a UI deep-link. The caller has already let
 *  every API route decline, and only calls this for a GET that accepts html. */
export function serveIndex(cors: Record<string, string>): Response | null {
  if (!DIST) return null;
  return indexResponse(DIST, cors);
}
