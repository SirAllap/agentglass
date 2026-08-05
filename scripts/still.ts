/**
 * Finish a captured still: resize to the width it is displayed at, and reduce
 * it to a palette.
 *
 * CDP hands back 3840px of truecolour — about 2 MB for the dashboard alone,
 * and a dozen of those would put more weight in .github/assets than there is
 * in the source. The README never renders them wider than its column, so each
 * is resized to the width it is actually shown at and quantised to 256
 * colours, which a flat dark UI takes without visible loss.
 *
 * Two passes, a palette built from the whole image and then applied with
 * dithering, for the same reason the hero GIF does it: one-pass quantisation
 * bands the gradients.
 *
 * This lives here because both capture scripts need it. It used to be done by
 * hand afterwards, which is why the committed assets were 1760px palette PNGs
 * while the scripts produced 3840px truecolour ones — re-running either of
 * them silently multiplied the repository's weight.
 */
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** The width the README shows a full-bleed shot at. */
export const STILL_W = 1760;
/** Half, for the three theme shots that share a 3-column table. */
export const THEME_W = 880;

export function finishStill(file: string, width: number = STILL_W) {
  // Via a scratch directory: ffmpeg cannot read and write the same path in one
  // invocation, and it must not leave a half-written asset behind if it fails.
  // Kept beside the target rather than in the system tmp: when they land on
  // different filesystems (tmp is often a tmpfs) the closing rename fails with
  // EXDEV, and same-directory keeps that rename atomic as well as cross-device.
  const work = mkdtempSync(join(dirname(file), ".agx-still-"));
  try {
    const pal = join(work, "palette.png");
    const out = join(work, "out.png");
    const run = (args: string[]) =>
      Bun.spawnSync(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", ...args]);
    run(["-i", file, "-vf", `scale=${width}:-1:flags=lanczos,palettegen=max_colors=256`, pal]);
    run(["-i", file, "-i", pal, "-lavfi",
      `scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a`,
      "-compression_level", "100", out]);
    if (existsSync(out)) renameSync(out, file);
    else console.warn(`  ! could not finish ${file} — is ffmpeg installed? left as captured`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
