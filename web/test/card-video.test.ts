/*
 * A VIDEO IS NOT AN IMAGE, and the thumbnail is why it looked like one.
 *
 * `isImage` was "the workspace made a thumbnail for it", which is true of a
 * screen recording too. A 20 MB .mov went into the picture grid, opened in the
 * viewer, and rendered as a broken-image icon with its filename beside it. The
 * file was fine; nothing had ever asked it to play.
 */
import { describe, expect, test } from "bun:test";
import { isImage, isVideo, isViewable } from "../src/components/CardFiles.tsx";
import type { CardAttachment } from "../../shared/providers.ts";

const file = (over: Partial<CardAttachment>): CardAttachment =>
  ({ id: "1", title: "f", ext: "", size: 0, url: "u", ...over } as CardAttachment);

describe("what the viewer can show", () => {
  test("a recording with a thumbnail is a video, not an image", () => {
    const mov = file({ ext: "mov", thumb: "t" });
    expect(isVideo(mov)).toBe(true);
    expect(isImage(mov)).toBe(false);
    expect(isViewable(mov)).toBe(true);
  });

  test("a picture is still a picture", () => {
    const png = file({ ext: "png", thumb: "t" });
    expect(isImage(png)).toBe(true);
    expect(isVideo(png)).toBe(false);
  });

  test("a video with no thumbnail is still viewable", () => {
    /* Some formats get no still from the workspace. A grey tile with a play
       mark on it is a better answer than filing the recording under "other
       files", where nobody opens it. */
    expect(isViewable(file({ ext: "mp4" }))).toBe(true);
  });

  test("only formats a browser will actually play", () => {
    /* A .wmv dropped into a <video> is a black rectangle with controls. Named
       and downloadable is the honest outcome for those. */
    for (const ext of ["mp4", "webm", "ogg", "ogv", "mov", "m4v"]) {
      expect(isVideo(file({ ext }))).toBe(true);
    }
    for (const ext of ["wmv", "avi", "mkv", "flv"]) {
      expect(isVideo(file({ ext }))).toBe(false);
    }
  });

  test("the extension is compared without case", () => {
    expect(isVideo(file({ ext: "MOV" }))).toBe(true);
  });

  test("a pdf is neither", () => {
    const pdf = file({ ext: "pdf" });
    expect(isViewable(pdf)).toBe(false);
  });
});
