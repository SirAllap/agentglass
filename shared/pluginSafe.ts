/**
 * What a catalogue entry or a plugin manifest may make the app do, as pure
 * decisions: which ref installs, which link opens, which picture loads.
 * The server's validator, the install paths and the web screens all ask
 * these, so the rule lives once and a test can aim a hostile string at it.
 */

/** A full commit id: the only ref that names bytes rather than a pointer somebody can move. */
export const PINNED_COMMIT = /^[0-9a-f]{40}$/;

/** The reason a catalogue entry's ref cannot be installed, or null when it is a full 40-hex commit. */
export function pinnedRefError(ref: unknown): string | null {
  return typeof ref === "string" && PINNED_COMMIT.test(ref) ? null : "a catalogue entry must pin a full 40-hex commit as its ref (no branch, tag or empty ref)";
}

/** The link if it is plain https and nothing else (no http:, javascript:, data:, credentials); undefined otherwise. */
export function httpsLink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return undefined; }
  return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined;
}

const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A picture's URL if it is https (not an .svg path, query and hash aside), or a base64 png/jpeg/webp data URI (never svg, never script); undefined otherwise. */
export function previewSrc(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (/^https:\/\/[^\s"'<>]{4,512}$/.test(s)) {
    const link = httpsLink(s);
    return link && !/\.svg$/i.test(new URL(link).pathname) ? s : undefined;
  }
  if (s.length <= 200_000 && DATA_IMAGE.test(s)) return s;
  return undefined;
}
