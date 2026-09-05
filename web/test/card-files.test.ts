/*
 * The files on a card.
 *
 * Two rules, and both are about not claiming things:
 *
 *   an unknown size is drawn as nothing, never as "0 B" — which is a claim about a
 *   file the workspace declined to measure;
 *   what counts as an image is whether ClickUp made a thumbnail, not a list of
 *   extensions this app would have to keep in step with theirs.
 */
import { describe, expect, it } from "bun:test";
import type { CardAttachment } from "../../shared/providers.ts";
import { fileSize, isImage } from "../src/components/CardFiles.tsx";

const file = (over: Partial<CardAttachment>): CardAttachment =>
  ({ id: "a", title: "shot.png", ext: "png", size: 0, url: "https://files.example/a", ...over });

describe("fileSize", () => {
  it("reads as a person reads it", () => {
    expect(fileSize(900)).toBe("900 B");
    expect(fileSize(67473)).toBe("66 KB");
    expect(fileSize(545046)).toBe("532 KB");
    expect(fileSize(3_500_000)).toBe("3.3 MB");
  });

  it("says nothing about a size nobody gave", () => {
    expect(fileSize(0)).toBe("");
    expect(fileSize(NaN)).toBe("");
  });
});

describe("what can be shown", () => {
  it("is whatever ClickUp made a thumbnail for", () => {
    expect(isImage(file({ thumb: "https://files.example/t" }))).toBe(true);
    expect(isImage(file({ ext: "pdf" }))).toBe(false);
    // A .png with no thumbnail is one ClickUp could not render either — listed, not
    // drawn as a broken tile.
    expect(isImage(file({ ext: "png" }))).toBe(false);
  });
});
