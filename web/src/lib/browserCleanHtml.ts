/**
 * `html --clean`: the markup a model can read. A page's outerHTML is mostly
 * what it cannot use — scripts, style blocks, svg paths, inline styles,
 * framework data attributes, comments, base64 images — and all of it is paid
 * for in tokens. This keeps the structure and the attributes that name a thing
 * (id, class, href, alt, aria-*, role, form fields, data-testid) and stamps the
 * same eN ids observe uses on everything actionable, so a selector read out of
 * this markup can be acted on as it stands.
 *
 * The body of a page script, to run where `e` is the element. (No backticks
 * in the comments here: one would end the template literal.)
 */
import { PICK, STAMP } from "./browserObserve.ts";
import { jsLit } from "../../../shared/jsLit.ts";

export const cleanHtmlBody = (max: number): string => `
  const stamp = ${STAMP};
  for (const n of e.querySelectorAll(${jsLit(PICK)})) stamp(n);
  const copy = e.cloneNode(true);
  for (const n of copy.querySelectorAll("script,style,noscript,link,meta,template")) n.remove();
  for (const n of copy.querySelectorAll("svg")) n.replaceChildren();
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.remove();
  const KEEP = /^(id|class|href|src|alt|title|role|name|type|value|placeholder|for|checked|disabled|selected|lang|data-testid|data-agx-e|aria-.+)$/;
  for (const n of [copy].concat([...copy.querySelectorAll("*")])) {
    for (const a of [...n.attributes]) {
      if (!KEEP.test(a.name)) { n.removeAttribute(a.name); continue; }
      if ((a.name === "src" || a.name === "href") && /^data:/i.test(a.value)) n.setAttribute(a.name, "data:…");
      else if (a.name === "class" && a.value.length > 80) n.setAttribute("class", a.value.slice(0, 80));
      else if (a.value.length > 300) n.setAttribute(a.name, a.value.slice(0, 300) + "…");
    }
  }
  const html = copy.outerHTML.replace(/>\\s+</g, "><").replace(/\\s{2,}/g, " ");
  return { kind: "ok", html: html.slice(0, ${max}), truncated: html.length > ${max}, clean: true };`;
