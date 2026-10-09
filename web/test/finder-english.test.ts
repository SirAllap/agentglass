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
const reveal = code(await Bun.file(new URL("../src/components/finder/RevealButton.tsx", import.meta.url)).text());
const folder = code(await Bun.file(new URL("../src/lib/finderFolder.ts", import.meta.url)).text());
const preview = code(await Bun.file(new URL("../src/components/finder/InfoRail.tsx", import.meta.url)).text())
  + code(await Bun.file(new URL("../src/components/finder/FileView.tsx", import.meta.url)).text());

describe("the finder speaks English", () => {
  test("the labels are Edit in nvim, Terminal here, Copy path and Show in folder", () => {
    expect(preview).toContain("primary.label");
    expect(folder).toContain('"Edit in nvim"');
    expect(folder).toContain('"Terminal here"');
    expect(preview).toContain('copyLabel("Copy path"');
    expect(preview).toContain('label="Show in folder"');
    expect(reveal).toContain("Open in Files");
    expect(palette).not.toContain(">Back</IconLabel>");
  });

  test("none of the old Spanish is left in what it draws", () => {
    for (const word of ["abrir", "copiar ruta", "volver", "carpeta", "editar", "no se pudo", "elemento"]) {
      expect(preview.toLowerCase()).not.toContain(word);
      expect(palette.toLowerCase().replace(/hoy|ayer/g, "")).not.toContain(word);
    }
  });
});
