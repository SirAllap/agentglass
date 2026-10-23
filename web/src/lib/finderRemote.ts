// A remote is shown and typed as its address (sftp://host/dir) while the finder
// browses it as the folder GVfs mounts it at. These are the two translations.
import type { Volume } from "../../../shared/types.ts";

/** smb://, sftp:// and ssh:// are the addresses the path bar takes as a server rather than a folder. */
export const isRemoteAddress = (t: string): boolean => /^(smb|sftp|ssh):\/\/\S+/i.test(t.trim());

const root = (v: Volume): string => v.id.replace(/\/+$/, "");
const under = (path: string, mp: string): string | null => (path === mp ? "" : path.startsWith(mp + "/") ? path.slice(mp.length) : null);

/** The address of a folder inside a mounted remote, with the address of the mount to draw as the first crumb; null for a local folder. */
export function remoteView(path: string, volumes: readonly Volume[]): { uri: string; root: string; mountPoint: string } | null {
  for (const v of volumes) {
    if (!v.remote || !v.mountPoint) continue;
    const rest = under(path, v.mountPoint);
    if (rest !== null) return { uri: root(v) + rest, root: root(v), mountPoint: v.mountPoint };
  }
  return null;
}

export type Resolved = { kind: "open"; path: string } | { kind: "connect"; uri: string };

interface Parts { scheme: "sftp" | "smb"; host: string; port: string; user: string; path: string }
function parts(text: string): Parts | null {
  let u: URL;
  try { u = new URL(text.trim().replace(/^ssh:/i, "sftp:")); } catch { return null; }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "sftp" && scheme !== "smb") return null;
  const dflt = scheme === "sftp" ? "22" : "445";
  return { scheme, host: u.hostname.toLowerCase(), port: u.port || dflt, user: decodeURIComponent(u.username).toLowerCase(), path: decodeURIComponent(u.pathname).replace(/\/+$/, "") };
}

/** The part of an address below the mount that holds it, or null when the mount is not that server. A mount that names no user is the server for any; a user must match when both name one. A share (smb) is the first folder of the path. */
function below(mount: Parts, want: Parts): string | null {
  if (mount.scheme !== want.scheme || mount.host !== want.host || mount.port !== want.port) return null;
  if (mount.user && want.user && mount.user !== want.user) return null;
  const m = mount.path, w = want.path;
  if (w.toLowerCase() === m.toLowerCase()) return "";
  return w.toLowerCase().startsWith(m.toLowerCase() + "/") ? w.slice(m.length) : null;
}

/** An address, typed or pinned: a folder of a remote that is already mounted opens at once, anything else starts a connection. */
export function resolveAddress(text: string, volumes: readonly Volume[]): Resolved {
  const t = text.trim().replace(/^ssh:/i, "sftp:");
  const want = parts(t);
  if (want) {
    for (const v of volumes) {
      if (!v.remote || !v.mountPoint) continue;
      const mount = parts(v.id);
      const rest = mount ? below(mount, want) : null;
      if (rest !== null) return { kind: "open", path: v.mountPoint + rest };
    }
  }
  return { kind: "connect", uri: t };
}
