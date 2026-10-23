/*
 * The files on a Jira card: their bytes for the screen, a file added, one of your
 * own taken off.
 *
 * The bytes cross this server because the credential must not leave it. A file
 * request to a Cloud site is answered with a 303 to one other host with a token in
 * the address; Data Center answers from the site itself. `jiraFetch` follows the
 * redirect to that ONE named host and no other, sends the credential to the first
 * hop only, and this file never hands the web an address it was redirected to:
 * what goes out is the bytes, a type of our choosing and a few headers.
 *
 * What the web may ask for is limited to what this app offered. The card read
 * remembers each file it listed (id, card, name, the type the site gave, whether it
 * is yours, and on Data Center the site's own path), and a request names a card and
 * an id that must match one of those. Nobody gets to name an address, and a file of
 * a card nobody opened is not one the proxy fetches.
 *
 * WHAT IS SHOWN IN PLACE, and what is only downloaded. A file somebody else made is
 * not drawn by this app because its bytes say so: a picture or a video is shown in
 * place only when the site's type for it AND the type the bytes arrive with are the
 * same entry of one short list. An HTML page or an SVG (which can carry script) is
 * never on that list, so it is sent as a download with a type that cannot run
 * (`application/octet-stream`), `nosniff`, and a CSP that allows nothing, whatever
 * it is called. Quicktime is sent as `video/mp4` for the reason /clickup/file
 * gives.
 *
 * LIMITS, measured in bytes the proxy will carry: 25 MB to show in place, 100 MB
 * to download, 1 MB for a thumbnail, 25 MB to add. A file over the line is
 * refused with a sentence that says so (the site's own limit, 1 GB on the sandbox
 * measured, is not ours to relax). A stream with no length is counted as it goes
 * and cut at the line. Ten seconds to the first byte.
 *
 * Writes sit behind the Jira write switch and check what they act on: a file is
 * taken off only when the card's own read says the file is on it and that you
 * attached it, because the site's delete takes any attachment by id.
 *
 * Ceilings, on purpose: a thumbnail is asked for only where the site says it made
 * one; the thumbnails kept in memory are the last 120 or 16 MB, whichever is
 * smaller, and a file added is one per request; the
 * name a file keeps is the one it had, cut to a plain name.
 */
import type { CardAttachment } from "../../shared/providers.ts";
import {
  ISSUE_KEY, NOT_CONNECTED, WRITE_OFF, apiOf, idText, isObj, jiraCall, jiraFetch, jiraGeneration, jiraWriteEnabled, personId, str, storedCreds,
  type JiraCreds,
} from "./jira.ts";
import { readBack, refusal, type RelateOutcome } from "./jiraRelate.ts";
import { redacted } from "./credentials.ts";

export const INLINE_MAX = 25 * 1024 * 1024;
export const DOWNLOAD_MAX = 100 * 1024 * 1024;
export const THUMB_MAX = 1024 * 1024;
export const UPLOAD_MAX = 25 * 1024 * 1024;
const FIRST_BYTE_MS = 10_000;
/** How long a stream may go without a chunk once it has begun; the size caps, not the clock, bound how much arrives. */
export const IDLE_MS = 20_000;
const ID = /^\d{1,12}$/;

// --- what may be drawn in place ---------------------------------------------

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const VIDEOS = new Set(["video/mp4", "video/webm", "video/ogg", "video/quicktime"]);

const essence = (t: string | null | undefined): string => (t ?? "").split(";")[0]!.trim().toLowerCase();

/** The one kind of thing a type may be drawn as in place, or null. SVG, HTML, PDF and the rest are null. */
export function inlineKind(type: string): "image" | "video" | null {
  const t = essence(type);
  return IMAGES.has(t) ? "image" : VIDEOS.has(t) ? "video" : null;
}

export interface Delivery {
  /** Shown in place (`true`) or handed over as a download (`false`). */
  inline: boolean;
  /** The type the answer carries. A download is always one that cannot run. */
  type: string;
}

/**
 * How a file is delivered. In place only when the site's type and the bytes' type name the same entry of the short list
 * and nobody asked for a download; every other case is a download of `application/octet-stream`.
 */
export function deliver(siteType: string, upstreamType: string, download: boolean): Delivery {
  const a = essence(siteType);
  const b = essence(upstreamType);
  if (download || !inlineKind(b) || a !== b) return { inline: false, type: "application/octet-stream" };
  return { inline: true, type: b === "video/quicktime" ? "video/mp4" : b };
}

/** A name safe to put in a header: no path, no control characters, no quote. Never empty. */
export function fileName(raw: unknown): string {
  const base = (typeof raw === "string" ? raw : "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").replace(/^\.+/, "").trim().slice(0, 200);
  return clean || "file";
}

export function dispositionOf(name: string): string {
  const ascii = fileName(name).replace(/[^\x20-\x7e]/g, "_").replace(/[\\;]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName(name)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** Whether a file of this size may be carried at all, and the sentence that says why not. */
export function tooBig(size: number, thumb: boolean, inline: boolean): string | null {
  const cap = thumb ? THUMB_MAX : inline ? INLINE_MAX : DOWNLOAD_MAX;
  if (!(size > cap)) return null;
  return inline ? "That file is too large to show here. Download it, or open it in Jira" : "That file is too large to carry through here. Open it in Jira";
}

// --- the files this app offered -----------------------------------------------

interface Offered { key: string; name: string; type: string; size: number; mine: boolean; content: string; thumb: string; gen: number }
const offered = new Map<string, Offered>();
const OFFERED_MAX = 4000;

/**
 * The path (and query) of an address on the site itself, relative to the site's base, or "" for one anywhere else.
 * A site with a context path (`host/jira`) is requested as base + path, so the path is kept WITHOUT the context:
 * left in, it is put twice (`/jira/jira/secure/...`) and the file is a 404.
 */
function sitePath(creds: JiraCreds, raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  try {
    const u = new URL(raw);
    const at = creds.site.indexOf("/");
    const host = (at < 0 ? creds.site : creds.site.slice(0, at)).toLowerCase();
    if (u.protocol !== "https:" || u.host.toLowerCase() !== host) return "";
    const context = at < 0 ? "" : creds.site.slice(at).replace(/\/+$/, "");
    if (context && u.pathname !== context && !u.pathname.startsWith(`${context}/`)) return "";
    return `${u.pathname.slice(context.length)}${u.search}`;
  } catch { return ""; }
}

const slot = (creds: JiraCreds, id: string): string => `${creds.site}|${id}`;

/** What the card read listed, remembered so a request can only name one of these. */
export function rememberFiles(creds: JiraCreds, key: string, f: Record<string, unknown>, me: string): void {
  const v = apiOf(creds);
  for (const a of Array.isArray(f.attachment) ? f.attachment : []) {
    if (!isObj(a) || !ID.test(idText(a.id)) || !str(a.filename)) continue;
    const id = idText(a.id);
    // Cloud: the id is the address. Data Center: the address is the site's own path to it, none on another host.
    const content = v === 3 ? `/rest/api/3/attachment/content/${id}` : sitePath(creds, a.content);
    const thumb = !str(a.thumbnail) ? "" : v === 3 ? `/rest/api/3/attachment/thumbnail/${id}?fallbackToDefault=false` : sitePath(creds, a.thumbnail);
    if (!content) continue;
    if (offered.size >= OFFERED_MAX) offered.delete(offered.keys().next().value!);
    offered.set(slot(creds, id), {
      key: key.toUpperCase(), name: str(a.filename), type: str(a.mimeType), size: typeof a.size === "number" ? a.size : 0,
      mine: !!me && isObj(a.author) && personId(a.author) === me, content, thumb, gen: jiraGeneration(),
    });
  }
}

/** The rows the card draws: where the screen asks for the bytes and the small picture, and whether the file is yours. */
export function fileRows(rows: CardAttachment[], key: string, f: Record<string, unknown>, me: string): CardAttachment[] {
  const raw = new Map<string, Record<string, unknown>>();
  for (const a of Array.isArray(f.attachment) ? f.attachment : []) if (isObj(a)) raw.set(idText(a.id), a);
  return rows.map((r) => {
    const a = raw.get(r.id);
    if (!a || !ID.test(r.id)) return r;
    const at = `/jira/file?key=${encodeURIComponent(key.toUpperCase())}&id=${r.id}`;
    const image = inlineKind(str(a.mimeType)) === "image" && !!str(a.thumbnail);
    return { ...r, url: at, ...(image ? { thumb: `${at}&thumb=1` } : {}), ...(me && isObj(a.author) && personId(a.author) === me ? { mine: true } : {}) };
  });
}

// --- thumbnails, kept ---------------------------------------------------------

const thumbs = new Map<string, { type: string; bytes: Uint8Array }>();
let thumbBytes = 0;
const THUMBS_MAX = 120;
const THUMB_BUDGET = 16 * 1024 * 1024;

function keepThumb(k: string, type: string, bytes: Uint8Array): void {
  thumbs.set(k, { type, bytes });
  thumbBytes += bytes.length;
  while (thumbs.size > THUMBS_MAX || thumbBytes > THUMB_BUDGET) {
    const old = thumbs.keys().next().value!;
    thumbBytes -= thumbs.get(old)!.bytes.length;
    thumbs.delete(old);
  }
}

// --- the bytes ----------------------------------------------------------------

export interface FileAsk { key: string; id: string; thumb: boolean; download: boolean; range: string | null; signal?: AbortSignal }
export type FileAnswer = { res: Response } | { error: string; status: number };

const fail = (error: string, status: number): FileAnswer => ({ error, status });

/** Counts what passes and ends the stream at the line, for an answer that did not say how long it was. */
export function capped(body: ReadableStream<Uint8Array>, cap: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.length;
      if (seen > cap) { ctl.error(new Error("over the limit")); return; }
      ctl.enqueue(chunk);
    },
  }));
}

/** Ends a stream that goes `ms` without a chunk, so a stalled download is cut but a slow, steady one is not. */
export function idleLimited(body: ReadableStream<Uint8Array>, ms: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("stalled")), ms); });
      try {
        const r = await Promise.race([reader.read(), stalled]);
        if (r.done) ctl.close(); else ctl.enqueue(r.value);
      } catch (e) {
        void reader.cancel().catch(() => {});
        ctl.error(e);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: (why) => reader.cancel(why),
  });
}

const GUARD_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
};

/** One file's bytes, or the sentence and status that say why not. */
export async function serveFile(creds: JiraCreds, ask: FileAsk): Promise<FileAnswer> {
  if (!ISSUE_KEY.test(ask.key) || !ID.test(ask.id)) return fail("That is not a file this app has offered", 404);
  const o = offered.get(slot(creds, ask.id));
  if (!o || o.key !== ask.key.toUpperCase() || o.gen !== jiraGeneration()) return fail("That is not a file this app has offered", 404);
  const wantThumb = ask.thumb;
  const path = wantThumb ? o.thumb : o.content;
  if (!path) return fail("That file has no small picture", 404);

  // What the site itself listed settles the obvious case before any request is made.
  const early = wantThumb ? null : tooBig(o.size, false, deliver(o.type, o.type, ask.download).inline);
  if (early) return fail(early, 413);

  const cacheKey = slot(creds, ask.id);
  if (wantThumb) {
    const held = thumbs.get(cacheKey);
    if (held) return { res: new Response(held.bytes, { headers: { ...GUARD_HEADERS, "content-type": held.type, "cache-control": "private, max-age=86400" } }) };
  }
  const got = await jiraFetch(creds, path, { range: wantThumb ? null : ask.range, timeoutMs: FIRST_BYTE_MS, signal: ask.signal });
  if ("error" in got) return fail(got.error, 502);
  const up = got.res;
  if (up.status === 401 || up.status === 403) { void up.body?.cancel(); return fail("Your Jira account cannot open that file", 403); }
  if (up.status === 404) { void up.body?.cancel(); return fail("That file is gone: reload the card", 404); }
  if (up.status !== 200 && up.status !== 206) { void up.body?.cancel(); return fail("Jira did not give that file", 502); }

  const how = wantThumb
    ? ((): Delivery => { const t = essence(up.headers.get("content-type")); return IMAGES.has(t) ? { inline: true, type: t } : { inline: false, type: "application/octet-stream" }; })()
    : deliver(o.type, up.headers.get("content-type") ?? "", ask.download);
  // A thumbnail the bytes do not vouch for as a picture is not drawn.
  if (wantThumb && !how.inline) { void up.body?.cancel(); return fail("That small picture is not a picture", 502); }

  const length = Number(up.headers.get("content-length"));
  const cap = wantThumb ? THUMB_MAX : how.inline ? INLINE_MAX : DOWNLOAD_MAX;
  // The larger of what the site listed and what it sends: a site that understates its own file does not get past the line.
  const big = tooBig(Math.max(wantThumb ? 0 : o.size, Number.isFinite(length) ? length : 0), wantThumb, how.inline);
  if (big) { void up.body?.cancel(); return fail(big, 413); }

  const head = new Headers(GUARD_HEADERS);
  head.set("content-type", how.type);
  if (!how.inline) head.set("content-disposition", dispositionOf(o.name));
  head.set("cache-control", wantThumb ? "private, max-age=86400" : "private, max-age=300");
  if (!wantThumb) {
    head.set("accept-ranges", "bytes");
    for (const k of ["content-length", "content-range"]) { const v = up.headers.get(k); if (v) head.set(k, v); }
  }
  if (wantThumb) {
    // Whole, so it can be kept and answered again without another request.
    const bytes = new Uint8Array(await new Response(up.body ? capped(idleLimited(up.body, IDLE_MS), cap) : null).arrayBuffer().catch(() => new ArrayBuffer(0)));
    if (!bytes.length) return fail("Jira did not give that small picture", 502);
    keepThumb(cacheKey, how.type, bytes);
    return { res: new Response(bytes, { headers: head }) };
  }
  return { res: new Response(up.body ? capped(idleLimited(up.body, IDLE_MS), cap) : null, { status: up.status, headers: head }) };
}

export const serveFileStored = (ask: FileAsk): Promise<FileAnswer> => {
  const c = storedCreds();
  return c ? serveFile(c, ask) : Promise.resolve(fail(NOT_CONNECTED, 400));
};

// --- adding and taking off ------------------------------------------------------

const no = (error: string): RelateOutcome => ({ ok: false, error });
const guard = (key: string): RelateOutcome | null =>
  !jiraWriteEnabled() ? no(WRITE_OFF) : !ISSUE_KEY.test(key) ? no("That is not a Jira card id") : null;

const attachPath = (creds: JiraCreds, upper: string) => `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}/attachments`;

/** Put one file on a card. */
export async function attachFile(creds: JiraCreds, key: string, name: unknown, bytes: Uint8Array): Promise<RelateOutcome & { added?: string }> {
  const stop = guard(key);
  if (stop) return stop;
  if (!bytes.length) return no("That file is empty");
  if (bytes.length > UPLOAD_MAX) return no(`A file added here is at most ${UPLOAD_MAX / (1024 * 1024)} MB. Add a bigger one in Jira`);
  const upper = key.toUpperCase();
  // The type is the site's to decide: the browser's word for it is not sent on.
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), fileName(name));
  const post = await jiraCall<unknown>(creds, attachPath(creds, upper), { method: "POST", form, timeoutMs: 60_000 });
  if (!post.ok) {
    // A write that got no answer may have landed; a second press would add a second copy.
    if (!post.throttled && !post.unauthorised && (post.status === undefined || post.status >= 500)) {
      return no(`${post.error ?? "Jira did not answer"}. The file may have been added: reload the card before adding it again`);
    }
    return refusal(post, "file", upper);
  }
  const made = Array.isArray(post.data) && isObj(post.data[0]) ? idText(post.data[0].id) : "";
  const back = await readBack(creds, upper, "The file was added");
  return made ? { ...back, added: made } : back;
}

/** Take one of your own files off a card, by an id the card itself holds. */
export async function removeFile(creds: JiraCreds, key: string, id: unknown): Promise<RelateOutcome> {
  const stop = guard(key);
  if (stop) return stop;
  if (typeof id !== "string" || !ID.test(id)) return no("That is not a file this card has");
  const upper = key.toUpperCase();
  const r = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/issue/${encodeURIComponent(upper)}?fields=attachment`, { fresh: true });
  if (!r.ok) return { ok: false, unauthorised: r.unauthorised, error: `Nothing was changed: could not read the card's files first. ${r.error ?? "Jira did not answer"}` };
  const f = isObj(r.data) && isObj(r.data.fields) ? r.data.fields : {};
  const held = (Array.isArray(f.attachment) ? f.attachment : []).find((a) => isObj(a) && idText(a.id) === id);
  if (!isObj(held)) return no("That is not a file this card has");
  const me = redacted("jira")?.accountId ?? "";
  if (!me || !isObj(held.author) || personId(held.author) !== me) return no("You can only take off a file you added");
  const del = await jiraCall<unknown>(creds, `/rest/api/${apiOf(creds)}/attachment/${id}`, { method: "DELETE" });
  if (!del.ok) return refusal(del, "change", upper);
  offered.delete(slot(creds, id));
  thumbs.delete(slot(creds, id));
  return readBack(creds, upper, "The file was taken off");
}

const stored = <A extends unknown[], R extends RelateOutcome>(run: (c: JiraCreds, ...a: A) => Promise<R>) =>
  (...a: A): Promise<R | RelateOutcome> => { const c = storedCreds(); return c ? run(c, ...a) : Promise.resolve({ ok: false, error: NOT_CONNECTED }); };
export const attachFileStored = stored(attachFile);
export const removeFileStored = stored(removeFile);
