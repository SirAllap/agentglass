// Pasted images arrive as arbitrary base64 in a browser request body, so this
// is the boundary where a client's claims about them stop being taken on faith.
// Two things are pinned here: the limits (a turn cannot be used to make the
// server hold unbounded memory) and the stdin envelope (the one part of the
// feature that a typecheck cannot catch — a wrong shape fails only at runtime,
// inside a `claude` process that costs money to start).
import { describe, expect, test } from "bun:test";
import { chatImages, sniffMediaType, turnEnvelope } from "../src/chat.ts";

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

// Real signatures, padded out to the length each sniff needs.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];

const png = { mediaType: "image/png", data: b64(PNG) };

describe("sniffMediaType", () => {
  test("recognises each allowed format from its magic bytes", () => {
    expect(sniffMediaType(new Uint8Array(PNG))).toBe("image/png");
    expect(sniffMediaType(new Uint8Array(JPEG))).toBe("image/jpeg");
    expect(sniffMediaType(new Uint8Array(GIF))).toBe("image/gif");
    expect(sniffMediaType(new Uint8Array(WEBP))).toBe("image/webp");
  });

  test("returns null for anything else", () => {
    expect(sniffMediaType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffMediaType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBeNull(); // ELF
    expect(sniffMediaType(new Uint8Array([]))).toBeNull();
    // A RIFF container that is not WebP (e.g. a .wav) must not pass.
    expect(sniffMediaType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
  });
});

describe("chatImages", () => {
  test("absent or empty attachments are fine — this is the common case", () => {
    expect(chatImages(undefined)).toEqual([]);
    expect(chatImages(null)).toEqual([]);
    expect(chatImages([])).toEqual([]);
  });

  test("accepts well-formed images of every allowed type", () => {
    const ok = chatImages([png, { mediaType: "image/webp", data: b64(WEBP) }]);
    expect(ok).toHaveLength(2);
    expect(ok![0].mediaType).toBe("image/png");
  });

  test("rejects a media type outside the allowlist", () => {
    expect(chatImages([{ mediaType: "image/svg+xml", data: b64(PNG) }])).toBeNull();
    expect(chatImages([{ mediaType: "text/html", data: b64(PNG) }])).toBeNull();
    expect(chatImages([{ mediaType: "application/octet-stream", data: b64(PNG) }])).toBeNull();
  });

  test("rejects bytes that do not match the declared type", () => {
    // The whole point of sniffing: a truthful-looking label over other content.
    expect(chatImages([{ mediaType: "image/png", data: b64(JPEG) }])).toBeNull();
    expect(chatImages([{ mediaType: "image/png", data: b64([0x25, 0x50, 0x44, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]) }])).toBeNull();
  });

  test("rejects a malformed payload rather than coercing it", () => {
    expect(chatImages("not an array")).toBeNull();
    expect(chatImages([null])).toBeNull();
    expect(chatImages(["just a string"])).toBeNull();
    expect(chatImages([{ mediaType: "image/png" }])).toBeNull();
    expect(chatImages([{ mediaType: "image/png", data: "" }])).toBeNull();
    // Not base64 — `atob` is lenient about some of this, so the charset is
    // checked explicitly before decoding.
    expect(chatImages([{ mediaType: "image/png", data: "!!!!not base64!!!!" }])).toBeNull();
  });

  test("caps the number of images per message", () => {
    expect(chatImages([png, png, png, png])).toHaveLength(4);
    expect(chatImages([png, png, png, png, png])).toBeNull();
  });

  test("caps a single image's size", () => {
    // A valid PNG header followed by more than 5MB of payload.
    const big = new Uint8Array(5 * 1024 * 1024 + 1024);
    big.set(PNG.slice(0, 8));
    let s = "";
    for (let i = 0; i < big.length; i += 0x8000) s += String.fromCharCode(...big.subarray(i, i + 0x8000));
    expect(chatImages([{ mediaType: "image/png", data: btoa(s) }])).toBeNull();
  });

  test("caps the total across images even when each one is legal", () => {
    // Three images of 4MB each are individually fine but blow the 10MB budget.
    const four = new Uint8Array(4 * 1024 * 1024);
    four.set(PNG.slice(0, 8));
    let s = "";
    for (let i = 0; i < four.length; i += 0x8000) s += String.fromCharCode(...four.subarray(i, i + 0x8000));
    const img = { mediaType: "image/png", data: btoa(s) };
    expect(chatImages([img, img])).toHaveLength(2);
    expect(chatImages([img, img, img])).toBeNull();
  });
});

describe("turnEnvelope", () => {
  // This shape is what `claude` itself writes into its own structured-input
  // stream, and what its stdin reader validates coming back in. If any of these
  // change, the turn is silently rejected by a subprocess at runtime.
  test("is a single NDJSON line with the type and role claude checks for", () => {
    const line = turnEnvelope("hello", []);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd()).not.toContain("\n"); // exactly one line
    const o = JSON.parse(line);
    expect(o.type).toBe("user");
    expect(o.message.role).toBe("user");
    expect(o.session_id).toBe("");
    expect(o.parent_tool_use_id).toBeNull();
  });

  test("carries text and images as content blocks in the Anthropic shape", () => {
    const o = JSON.parse(turnEnvelope("look at this", [{ mediaType: "image/png", data: b64(PNG) }]));
    expect(o.message.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64(PNG) } },
    ]);
  });

  test("omits the text block entirely when the turn is images only", () => {
    // An empty text block is rejected by the API, so it must not be emitted.
    const o = JSON.parse(turnEnvelope("", [{ mediaType: "image/png", data: b64(PNG) }]));
    expect(o.message.content).toHaveLength(1);
    expect(o.message.content[0].type).toBe("image");
  });

  test("a newline in the message cannot break the line framing", () => {
    // The envelope is newline-delimited, so an embedded newline has to survive
    // as escaped JSON rather than terminating the line early.
    const line = turnEnvelope("one\ntwo", []);
    expect(line.trimEnd()).not.toContain("\n");
    expect(JSON.parse(line).message.content[0].text).toBe("one\ntwo");
  });
});
