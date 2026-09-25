/*
 * The product is English. The finder's buttons were Spanish — "abrir", "copiar
 * ruta", "volver" — which is a fact about who wrote them and not about the
 * product.
 *
 * A rule about source is asserted against source: there is no renderer here.
 * Comments are stripped first, since a comment may name the old word to say
 * what it replaced.
 */
import { describe, expect, test } from "bun:test";

const code = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

const palette = code(await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text());
const preview = code(await Bun.file(new URL("../src/components/finder/Preview.tsx", import.meta.url)).text());

describe("the finder speaks English", () => {
  test("the three labels are Open, Copy path and Back", () => {
    expect(preview).toMatch(/^\s*Open$/m);
    expect(preview).toMatch(/^\s*Copy path$/m);
    expect(palette).toContain(">Back</IconLabel>");
  });

  test("none of the old Spanish is left in what it draws", () => {
    for (const word of ["abrir", "copiar ruta", "volver", "carpeta", "editar", "no se pudo", "elemento"]) {
      expect(preview.toLowerCase()).not.toContain(word);
      expect(palette.toLowerCase().replace(/hoy|ayer/g, "")).not.toContain(word);
    }
  });
});
