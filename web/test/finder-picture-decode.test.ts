/*
 * The preview's picture decodes off the frame and is not re-rendered for nothing.
 *
 * What went wrong: a screenshot of 4774 by 1072 is about 20 MB of bitmap, and
 * the preview's <img> decoded it in step with the frame, so the pane and the
 * list beside it stood still for the length of the decode.
 */
import { describe, expect, test } from "bun:test";

const body = await Bun.file(new URL("../src/components/finder/machine/PreviewBody.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");
const at = body.indexOf("const Picture = memo(function Picture(");
const picture = code(body.slice(at, body.indexOf("\n});\n", at) + 4));

describe("the preview's picture", () => {
  test("is found, and is a memo", () => {
    expect(at).toBeGreaterThan(-1);
    expect(picture.endsWith("});")).toBe(true);
  });
  test("decodes off the frame", () => {
    const img = picture.match(/<img\b[^>]*>/);
    expect(img).not.toBeNull();
    expect(img![0]).toContain('decoding="async"');
    expect(img![0]).toContain("src={src}");
  });
  test("takes its address as a string, so the memo can tell the same file from the next", () => {
    expect(picture).toContain("{ src, facts }: { src: string; facts: FileFacts }");
    expect(code(body)).toContain("<Picture src={api.previewUrl(path)} facts={facts} />");
  });
});
