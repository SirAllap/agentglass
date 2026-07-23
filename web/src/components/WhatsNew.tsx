import { useEffect, useState } from "react";
import { api, IS_DEMO } from "../lib/api.ts";
import { ReleaseNotesModal } from "./ReleaseNotesModal.tsx";
import { markSeen, releaseToAnnounce } from "../lib/whatsNew.ts";

/**
 * What changed, the first time the app runs a version it has not run before.
 *
 * Updating restarted the app and said nothing. The notes already exist — the
 * tag annotation is what the GitHub release is made from — so the app can show
 * them once instead of leaving you to go and find the release page, which
 * nobody does.
 *
 * Once. `releaseToAnnounce` decides, and it deliberately stays quiet on a fresh
 * install and on a downgrade; this component only decides *whether*, and hands
 * the rendering to ReleaseNotesModal. Dismissing marks the version seen, and so
 * does failing to load the notes: an empty modal on every launch would be worse
 * than no modal at all.
 *
 * Missing the interruption is no longer the same as missing the notes: Settings
 * › About opens them on demand, which is the one thing this cannot do — it
 * fires once, on a version boundary, and never again.
 */
export function WhatsNew() {
  const [tag, setTag] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (IS_DEMO) return;
    let live = true;
    // Deliberately after the first paint rather than racing it: the dashboard
    // connecting matters more than the notes, and the modal is not urgent.
    const t = setTimeout(() => {
      api.updateNotes()
        .then((r) => {
          if (!live || !r.tag) return;
          const announce = releaseToAnnounce(r.tag);
          if (!announce) return;
          if (!r.ok || !r.notes.trim()) { markSeen(r.tag); return; }
          setTag(announce);
          setNotes(r.notes);
        })
        .catch(() => { /* offline, or a browser tab the desktop gate refuses */ });
    }, 2500);
    return () => { live = false; clearTimeout(t); };
  }, []);

  const close = () => { if (tag) markSeen(tag); setTag(null); };

  return <ReleaseNotesModal open={!!tag} tag={tag ?? ""} notes={notes} onClose={close} />;
}
