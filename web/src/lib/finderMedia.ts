// Decisions of the Finder's audio and video preview, kept out of the component
// so they can be asserted without a renderer: the info line, the clock, and the
// media chords. Numbers and chords are Strata's (ui/keys/bindings/preview.rs).
import type { MediaFacts } from "../../../shared/types.ts";

/** Strata: Ctrl+Alt+Left/Right seek five seconds. */
export const SEEK_SECONDS = 5;
/** One press of Ctrl+Alt+Up/Down moves the volume a tenth. */
export const VOLUME_STEP = 0.1;
/** Strata caps media content at 1280 px wide (docs/preview-panel-layout.md). */
export const MEDIA_MAX_WIDTH = 1280;

export type MediaAction = "toggle" | "back" | "forward" | "louder" | "quieter" | "mute";

/** m:ss, or h:mm:ss from an hour. Not-a-number and negative are "0:00". */
export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(r)}` : `${m}:${two(r)}`;
}

/** "3:12 · H264 1280×720 · 30 fps · AAC stereo · 800 kbps", whatever of it is known. */
export function mediaLine(f: MediaFacts | null | undefined): string {
  if (!f || !f.ok) return "";
  const parts: string[] = [];
  if (f.duration) parts.push(clock(f.duration));
  if (f.video) {
    parts.push(`${f.video.codec.toUpperCase()}${f.video.width && f.video.height ? ` ${f.video.width}×${f.video.height}` : ""}`.trim());
    if (f.video.fps) parts.push(`${Math.round(f.video.fps)} fps`);
  }
  if (f.audio) {
    const ch = f.audio.channels === 1 ? "mono" : f.audio.channels === 2 ? "stereo" : f.audio.channels ? `${f.audio.channels} ch` : "";
    parts.push([f.audio.codec.toUpperCase(), ch].filter(Boolean).join(" "));
  }
  if (f.bitRate) parts.push(`${Math.round(f.bitRate / 1000)} kbps`);
  return parts.filter(Boolean).join(" · ");
}

/** The chord as a media action, or null when it is not one of Strata's. */
export function mediaAction(e: { ctrlKey: boolean; altKey: boolean; shiftKey?: boolean; metaKey?: boolean; key: string }): MediaAction | null {
  if (!e.ctrlKey || !e.altKey || e.metaKey) return null;
  switch (e.key) {
    case " ": return "toggle";
    case "ArrowLeft": return "back";
    case "ArrowRight": return "forward";
    case "ArrowUp": return "louder";
    case "ArrowDown": return "quieter";
    case "m": case "M": return "mute";
    default: return null;
  }
}

/** The slice of an HTMLMediaElement the chords touch, so a plain object tests it. */
export interface Playable { paused: boolean; currentTime: number; duration: number; volume: number; muted: boolean; play(): Promise<void> | void; pause(): void }

export function applyMedia(el: Playable, action: MediaAction): void {
  switch (action) {
    case "toggle": if (el.paused) void el.play(); else el.pause(); break;
    case "back": el.currentTime = Math.max(0, el.currentTime - SEEK_SECONDS); break;
    case "forward": el.currentTime = Number.isFinite(el.duration) ? Math.min(el.duration, el.currentTime + SEEK_SECONDS) : el.currentTime + SEEK_SECONDS; break;
    case "louder": el.volume = Math.min(1, Math.round((el.volume + VOLUME_STEP) * 10) / 10); break;
    case "quieter": el.volume = Math.max(0, Math.round((el.volume - VOLUME_STEP) * 10) / 10); break;
    case "mute": el.muted = !el.muted; break;
  }
}

/** Strata's placeholder wording (ui/preview.rs): a title and, under it, why. */
export interface PlaceholderText { title: string; why: string }

/** Which words stand where a preview cannot be drawn. `loading` while the facts
 *  are on their way, `failed` with the engine's own reason, `binary` for a file
 *  with nothing to draw (the facts still say what it is). */
export function placeholderText(state: "loading" | "failed" | "binary", reason?: string): PlaceholderText {
  switch (state) {
    case "loading": return { title: "Loading preview…", why: "" };
    case "failed": return { title: "Preview unavailable", why: reason ? `${reason.replace(/\.$/, "")}.` : "" };
    case "binary": return { title: "No visual preview", why: "Metadata is available for this file type." };
  }
}
