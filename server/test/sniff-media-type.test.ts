import { describe, expect, test } from "bun:test";
import { sniffMediaType } from "../src/imageUpload.ts";

// Real signatures, padded out to the length each sniff needs.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];

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
