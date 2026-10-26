/**
 * What a picture off the wire is allowed to be, decided from the bytes and
 * nothing the client said about them.
 *
 * `/terminal/image` used to trust the client's own filename for the
 * extension it wrote to disk — `name: "x.png"` bought a `.png` regardless of
 * what was inside, and the fallback for a name it did not recognise was
 * `.png` as well. A file that claims to be a picture and is not one is not a
 * client bug worth tolerating: the bytes go into a directory the terminal's
 * pane treats as safe to open, so the classification has to come from the
 * bytes, not the label glued to them.
 *
 * A strict base64 check comes first because `Buffer.from(str, "base64")`
 * never throws — it drops whatever it cannot decode and returns what is
 * left, so garbage input silently becomes a short, valid-looking buffer
 * instead of an error.
 */

/** Sniff the real media type from the leading bytes.
 *
 *  The client's declared type is a label, not evidence — a `image/png` claim
 *  over a payload that is something else entirely would still be forwarded
 *  verbatim to the model. These signatures are a few bytes each, so checking is
 *  cheap enough to do unconditionally, and it is what makes the declared type
 *  trustworthy rather than merely allowlisted. */
export function sniffMediaType(b: Uint8Array): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const at = (i: number) => b[i];
  if (b.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47
    && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) return "image/png";
  if (b.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  // "GIF87a" / "GIF89a" — the version digit differs, the rest does not.
  if (b.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  // WebP is a RIFF container: "RIFF" <4-byte size> "WEBP".
  if (b.length >= 12 && at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return null;
}

// A flat character class, not a repeated group: `(?:[A-Za-z0-9+/]{4})*`
// against an 11-million-character string (the base64 of an 8MB image) hits
// the engine's own limits and quietly returns false, which a naive regex
// swap would have turned into every large, VALID image being refused as
// "not base64" — length is checked separately instead.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

export type ImageUploadResult =
  | { ok: true; bytes: Buffer; ext: string }
  | { ok: false; status: number; error: string };

const MAX_BYTES = 8 * 1024 * 1024;

/** Extension for each type `sniffMediaType` can name. */
const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/**
 * Decode and classify a base64 picture. Never looks at a client-supplied
 * name — the extension in a successful result is read out of the bytes
 * themselves, so there is nothing here for a crafted `name` to influence.
 */
export function decodeImage(data: string): ImageUploadResult {
  if (!data) return { ok: false, status: 400, error: "no image" };
  // The regex alone rules out stray characters and short padding, but
  // `Buffer.from` also drops trailing bytes it cannot group into a quartet —
  // re-encoding and comparing back to the input is what catches that, since
  // it is the one check that fails whenever a byte was silently discarded.
  if (data.length % 4 !== 0 || !BASE64_CHARS.test(data)) return { ok: false, status: 400, error: "not base64" };
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return { ok: false, status: 400, error: "not base64" };
  if (!bytes.length) return { ok: false, status: 400, error: "empty image" };
  if (bytes.length > MAX_BYTES) return { ok: false, status: 413, error: "that image is over 8MB" };
  const type = sniffMediaType(bytes);
  if (type) return { ok: true, bytes, ext: EXT[type]! };
  return { ok: false, status: 415, error: "only PNG, JPEG, GIF or WebP pictures" };
}
