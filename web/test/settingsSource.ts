/* The settings modal's source as the tests read it: SettingsModal.tsx with each
   page that was cut out of it (components/settings/pages/*.tsx) put back where
   it is drawn. Several tests pin a string "inside the show("x") block"; a page
   moving to its own file must not change what they see. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(import.meta.dir, "..", "src", "components");
const PAGES = join(COMPONENTS, "settings", "pages");

export const pagesSource = (): string =>
  readdirSync(PAGES).filter((f) => f.endsWith(".tsx")).sort().map((f) => readFileSync(join(PAGES, f), "utf8")).join("\n");

export const modalSource = (): string => {
  let out = readFileSync(join(COMPONENTS, "SettingsModal.tsx"), "utf8");
  for (const f of readdirSync(PAGES).filter((n) => n.endsWith(".tsx")).sort()) {
    const text = readFileSync(join(PAGES, f), "utf8");
    // A page built on the shell is read whole by the loop below; its first fragment is a helper's, not the page's body.
    if (text.includes('from "../shell/SettingsPage.tsx"')) continue;
    const comp = /export function (\w+SettingsPage)\(/.exec(text)?.[1];
    const body = /\n    <>\n([\s\S]*?)\n    <\/>\n  \);\n\}/.exec(text)?.[1];
    if (comp && body) out = out.replace(`<${comp} c={pageCtx} />`, `(\n<>\n${body}\n</>\n)`);
  }
  // Pages built on the shell (SomethingPage.tsx) are read where the modal draws them, like the ones above.
  // That covers the lower-case page files too (hooks.tsx, engine.tsx, …) once they draw on the shell.
  for (const f of readdirSync(PAGES).filter((n) => n.endsWith(".tsx")).sort()) {
    const text = readFileSync(join(PAGES, f), "utf8");
    for (const comp of [...text.matchAll(/export function (\w+Page)\(/g)].map((m) => m[1]!)) {
      const use = new RegExp(`<${comp}( [^>]*)?/>`);
      if (use.test(out)) out = out.replace(use, `(\n<>\n${text.replace(/\$/g, "$$$$")}\n</>\n)`);
    }
  }
  // Choice lives in its own file so the orchestration page can import it without the modal; read it as if it were still inline.
  return out + "\n" + readFileSync(join(COMPONENTS, "SettingChoice.tsx"), "utf8");
};
