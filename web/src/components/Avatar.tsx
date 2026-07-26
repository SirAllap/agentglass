import { useState } from "react";
import { api } from "../lib/api.ts";

/**
 * GitHub's avatar for a login, through the server's allowlisted proxy.
 *
 * Its own module because both the pull request panel and the facet menus want
 * it, and importing it from the panel would close a cycle: the panel imports
 * the filter bar, which imports the menus. The name is always beside it — the
 * picture is recognition, not identification — and a login that has no picture
 * (or whose picture will not load) falls back to its initials rather than an
 * empty hole.
 */
export function Avatar({ login, size = 18 }: { login: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initials = (login || "?").replace(/\[bot\]$/, "").slice(0, 2).toUpperCase();
  if (failed || !login) {
    return (
      <span className="shrink-0 rounded-full inline-flex items-center justify-center"
        style={{ width: size, height: size, background: "var(--primary)", color: "var(--bg)", fontSize: size * 0.42 }}>{initials}</span>
    );
  }
  return (
    <img src={api.prAssetUrl(`https://avatars.githubusercontent.com/${encodeURIComponent(login.replace(/\[bot\]$/, ""))}?size=48`)}
      alt="" aria-hidden width={size} height={size} onError={() => setFailed(true)}
      className="shrink-0 rounded-full" style={{ width: size, height: size, objectFit: "cover" }} />
  );
}
