// "v1.0 is here", on the row that answers what this build is. A note, not a
// verdict — and once dismissed it stays gone, because a badge that returns
// after a restart is a nag.
import { useState } from "react";
import { versionAtLeast } from "../../../shared/semverLite.ts";
import { HIT, ICON } from "../lib/iconSize.ts";
import { CloseIcon } from "./CloseButton.tsx";

const DISMISSED_KEY = "agentglass-v1-badge-dismissed";

/** Read once, at mount. Private mode refuses the read and the note simply stays. */
function dismissedAlready(): boolean {
  try { return localStorage.getItem(DISMISSED_KEY) === "1"; } catch { return false; }
}

/** The whole decision, apart from the pixels: 1.0 or newer, and nobody has put it away. */
export function showsV1Badge(version: string | null | undefined, dismissed: boolean): boolean {
  return !dismissed && !!version && versionAtLeast(version, "1.0.0");
}

export function V1Badge({ version }: { version: string | null | undefined }) {
  const [dismissed, setDismissed] = useState(dismissedAlready);
  if (!showsV1Badge(version, dismissed)) return null;
  return (
    <button
      type="button"
      className="agx-badge"
      data-tone="off"
      style={{ height: HIT }}
      data-tip="Hide this note. It stays hidden."
      aria-label="Hide the v1.0 note"
      onClick={() => {
        // A refused write shows it again next launch, which is the honest
        // fallback; the click still closes it now.
        try { localStorage.setItem(DISMISSED_KEY, "1"); } catch { /* private mode */ }
        setDismissed(true);
      }}
    >
      v1.0 is here
      <CloseIcon size={ICON.xs} />
    </button>
  );
}
