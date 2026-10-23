// The sidebar's pinned places: GTK's bookmarks file on the machine (shared with
// every other GTK file manager), not this browser's storage. Pins from before
// that, kept in this browser, are moved into the file once the desktop app is
// allowed to write it, and only then forgotten.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api.ts";
import { PIN_KEY, readPins } from "../../../lib/finderPins.ts";
import type { PinnedPlace } from "../../../../../shared/types.ts";

const stored = (): string[] => { try { return readPins(localStorage.getItem(PIN_KEY)); } catch { return []; } };

export function useBookmarks(say: (note: string) => void) {
  const [places, setPlaces] = useState<PinnedPlace[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      let list = (await api.bookmarks()).bookmarks;
      if (live) setPlaces(list);
      const old = stored().filter((p) => !list.some((b) => b.path === p));
      for (const p of old) {
        const r = await api.bookmarkToggle(p);
        if (!r.ok || !r.bookmarks) return; // not the desktop app: keep them where they are
        list = r.bookmarks;
      }
      if (old.length || stored().length) { try { localStorage.removeItem(PIN_KEY); } catch { /* nothing kept */ } }
      if (live) setPlaces(list);
    })();
    return () => { live = false; };
  }, []);
  const toggle = useCallback((path: string) => {
    void api.bookmarkToggle(path).then((r) => { if (r.ok && r.bookmarks) setPlaces(r.bookmarks); else say(r.error || "Could not change the pinned places"); });
  }, [say]);
  return { places, pins: places.flatMap((b) => (b.path ? [b.path] : [])), toggle };
}
