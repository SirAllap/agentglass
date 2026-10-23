// Audio and video in the Finder's preview: the browser's own player, an info
// line from ffprobe, a still frame before a video plays, and Strata's media
// chords while focus is inside the preview.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../lib/api.ts";
import { MEDIA_MAX_WIDTH, applyMedia, mediaAction, mediaLine, type Playable } from "../../../lib/finderMedia.ts";
import { schemeOfTheme } from "../../../lib/schemeOfTheme.ts";
import type { FileFacts, MediaFacts } from "../../../../../shared/types.ts";

export function MediaPreview({ path, facts, kind, autoplay }: { path: string; facts: FileFacts; kind: "audio" | "video"; autoplay: boolean }) {
  const [info, setInfo] = useState<MediaFacts | null>(null);
  const [noPoster, setNoPoster] = useState(false);
  const el = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // One probe per file shown, and only once the preview is open: never on hover.
  useEffect(() => {
    setInfo(null);
    setNoPoster(false);
    let live = true;
    void api.previewMedia(path).then((r) => { if (live) setInfo(r); }).catch(() => { if (live) setInfo({ ok: false }); });
    return () => { live = false; };
  }, [path]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const a = mediaAction(e);
    if (!a || !el.current) return;
    e.preventDefault();
    e.stopPropagation();
    applyMedia(el.current as Playable, a);
  };
  // The browser's own controls toggle on Space too, below this wrapper: caught
  // on the way down (capture) so a chord that is ours never reaches them, or the
  // two would cancel and Ctrl+Alt+Space would do nothing.
  const onKeyUp = (e: React.KeyboardEvent) => { if (mediaAction(e)) { e.preventDefault(); e.stopPropagation(); } };
  const line = mediaLine(info);
  const common = { src: api.previewUrl(path), controls: true, preload: "metadata" as const, autoPlay: autoplay, "aria-label": facts.name };
  return (
    <div onKeyDownCapture={onKeyDown} onKeyUpCapture={onKeyUp} className="w-full" style={{ maxWidth: MEDIA_MAX_WIDTH }}>
      {kind === "video"
        ? <video ref={el} {...common} poster={noPoster ? undefined : api.frameUrl(path)} onError={() => setNoPoster(true)} className="w-full" style={{ maxHeight: "60vh", borderRadius: 6 }} />
        : <audio ref={el} {...common} style={{ colorScheme: schemeOfTheme() }} className="w-full" />}
      {line && <p className="m-0 mt-2 text-[11px]" style={{ color: "var(--text3)" }}>{line}</p>}
      {info?.title && <p className="m-0 mt-1 text-[11px]" style={{ color: "var(--text2)" }}>{[info.title, info.artist, info.album].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}
