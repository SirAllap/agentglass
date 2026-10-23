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
/** A typed address: a folder of a remote that is already mounted opens at once, anything else starts a connection. */
export function resolveAddress(text: string, volumes: readonly Volume[]): Resolved {
  const t = text.trim().replace(/^ssh:/i, "sftp:");
  for (const v of volumes) {
    if (!v.remote || !v.mountPoint) continue;
    const r = root(v);
    if (t.toLowerCase() === r.toLowerCase() || t.toLowerCase().startsWith(r.toLowerCase() + "/")) {
      const rest = t.slice(r.length).replace(/\/+$/, "");
      return { kind: "open", path: v.mountPoint + rest };
    }
  }
  return { kind: "connect", uri: t };
}
