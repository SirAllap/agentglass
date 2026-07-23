// Says out loud when the reason the panels are empty is that git isn't here.
//
// git is the one external tool the workspace was built assuming — the source
// control, diff and pull-request panels all shell out to it, and the terminal
// validates its working directory with `git rev-parse`. When it is missing,
// `Bun.spawn` throws, the server catches it, and the symptom is the same blank
// screen a broken origin gives: empty panels, "no repos found", no error. This
// is the git counterpart to ServerBanner, and to the in-panel guidance the PR
// panel already shows for a missing `gh`.
//
// Asked once. A binary does not get installed mid-session, and unlike the
// server-origin check there is nothing to poll back to health.
import { useEffect, useState } from "react";
import { api, IS_DEMO } from "../lib/api.ts";
import type { GitCapability } from "../../../shared/types.ts";

export default function GitMissingBanner() {
  const [cap, setCap] = useState<GitCapability | null>(null);

  useEffect(() => {
    if (IS_DEMO) return;
    let live = true;
    api.gitCapability().then((c) => { if (live) setCap(c); }).catch(() => { /* origin gate, offline — ServerBanner owns that story */ });
    return () => { live = false; };
  }, []);

  if (!cap || cap.available) return null;

  return (
    <div
      role="alert"
      className="shrink-0 px-4 py-2 text-[11px] flex items-center gap-2 flex-wrap border-b"
      style={{
        background: "color-mix(in srgb, var(--warning) 12%, transparent)",
        borderColor: "color-mix(in srgb, var(--warning) 30%, transparent)",
        color: "var(--text)",
      }}
    >
      <span className="font-semibold" style={{ color: "var(--warning)" }}>git not found</span>
      <span>
        {cap.reason || "git is not installed"}. The source-control, diff and pull-request panels stay empty, and the
        terminal cannot open, until it is on your <code>PATH</code>.
      </span>
      <span style={{ color: "var(--text3)" }}>
        Install it from <code>git-scm.com/downloads</code> (or your package manager: <code>apt install git</code>,{" "}
        <code>brew install git</code>), then reopen.
      </span>
    </div>
  );
}
