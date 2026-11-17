/**
 * Site storage for the login vault (plan cause 7): a site that keeps its login
 * in localStorage, not only in cookies.
 *
 * Opt-in per site: only the sites the person marked "needs storage" are read.
 * Firefox family only (Zen, Firefox, LibreWolf): each origin's localStorage is
 * one SQLite file, `storage/default/<origin>/ls/data.sqlite`. Chromium keeps it
 * in LevelDB, which this does not read. IndexedDB is not read either.
 *
 * Runs inside the one-shot cookie reader only. What leaves it goes into the
 * sealed vault, never to a log or an answer.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "./cookiesources.ts";
import type { VaultStorage } from "./loginvault.ts";

/**
 * Firefox's origin directory name, `https+++acme.test+8443^userContextId=2`,
 * as an origin and a container. Null for one this cannot carry: not http(s),
 * or with origin attributes other than a container (a partition, private
 * browsing, first-party isolation).
 */
export function parseOriginDir(name: string): { origin: string; container: string } | null {
  const [main, attrs = ""] = name.split("^", 2);
  const m = /^(https?)\+\+\+([a-z0-9.-]+|\[[0-9a-f:]+\])(?:\+(\d{1,5}))?$/i.exec(main ?? "");
  if (!m) return null;
  let container = "0";
  for (const kv of attrs.split("&").filter(Boolean)) {
    const [k, v = ""] = kv.split("=", 2);
    if (k === "userContextId" && /^\d+$/.test(v)) container = v;
    else return null;
  }
  return { origin: `${m[1]!.toLowerCase()}://${m[2]!.toLowerCase()}${m[3] ? `:${m[3]}` : ""}`, container };
}

/** Raw snappy (no framing), as Firefox's LSNG stores a compressed value. */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  let pos = 0;
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    if (pos >= src.length || shift > 28) throw new Error("snappy: bad length");
    const b = src[pos++]!;
    len |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
  }
  const out = new Uint8Array(len);
  let o = 0;
  const need = (n: number) => { if (pos + n > src.length) throw new Error("snappy: cut short"); };
  while (pos < src.length) {
    const tag = src[pos++]!;
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) { const k = n - 59; need(k); n = 0; for (let i = 0; i < k; i++) n |= src[pos++]! << (8 * i); }
      n += 1;
      need(n);
      if (o + n > len) throw new Error("snappy: too long");
      out.set(src.subarray(pos, pos + n), o);
      pos += n; o += n;
      continue;
    }
    let n: number;
    let off: number;
    if (kind === 1) { need(1); n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[pos++]!; }
    else if (kind === 2) { need(2); n = (tag >> 2) + 1; off = src[pos]! | (src[pos + 1]! << 8); pos += 2; }
    else { need(4); n = (tag >> 2) + 1; off = (src[pos]! | (src[pos + 1]! << 8) | (src[pos + 2]! << 16) | (src[pos + 3]! << 24)) >>> 0; pos += 4; }
    if (!off || off > o || o + n > len) throw new Error("snappy: bad copy");
    for (let i = 0; i < n; i++, o++) out[o] = out[o - off]!;
  }
  if (o !== len) throw new Error("snappy: wrong length");
  return out;
}

/** One LSNG value: conversion 0 = UTF-16 as stored, 1 = UTF-8; compression 0
 *  = none, 1 = snappy. Null for anything else. */
export function decodeLsValue(value: Uint8Array | string, conversion: number, compression: number): string | null {
  if (typeof value === "string") return value;
  let bytes = value;
  if (compression === 1) bytes = snappyDecompress(bytes);
  else if (compression !== 0) return null;
  if (conversion === 1) return new TextDecoder("utf-8").decode(bytes);
  if (conversion === 0) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf16le");
  return null;
}

/** One origin's data.sqlite, read from a private copy. */
export function readLsFile(db: string): Record<string, string> {
  const snap = snapshot(db);
  try {
    const d = new Database(snap.path, { readonly: true });
    try {
      const out: Record<string, string> = {};
      const rows = d.query("SELECT key, value, conversion_type AS c, compression_type AS z FROM data").all() as
        { key: string; value: Uint8Array | string; c: number; z: number }[];
      for (const r of rows) {
        try { const v = decodeLsValue(r.value, r.c, r.z); if (v !== null) out[r.key] = v; } catch { /* one bad value, not the site */ }
      }
      return out;
    } finally { d.close(); }
  } finally { snap.dispose(); }
}

/**
 * localStorage of every origin under the chosen sites, for one container.
 * @param siteOf the same host -> site rule the vault uses for cookies
 */
export function readFirefoxStorage(
  profileDir: string, container: string, sites: ReadonlySet<string>, siteOf: (host: string) => string,
): Record<string, VaultStorage[]> {
  const out: Record<string, VaultStorage[]> = {};
  if (!sites.size) return out;
  const base = join(profileDir, "storage", "default");
  let names: string[];
  try { names = readdirSync(base); } catch { return out; }
  for (const name of names) {
    const o = parseOriginDir(name);
    if (!o || o.container !== (container || "0")) continue;
    const site = siteOf(new URL(o.origin).hostname);
    if (!sites.has(site)) continue;
    const db = join(base, name, "ls", "data.sqlite");
    if (!existsSync(db)) continue;
    let local: Record<string, string>;
    try { local = readLsFile(db); } catch { continue; }
    if (!Object.keys(local).length) continue;
    (out[site] ??= []).push({ origin: o.origin, local });
  }
  return out;
}
